// =====================================================
// Ranchi Pathology — Admin Auth Routes
// =====================================================

import { hashPassword, verifyPassword, createToken, authMiddleware } from '../utils/auth.js';
import { jsonResponse, errorResponse, parseBody, validateRequired, sanitizeString } from '../utils/helpers.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 15;

export async function handleAuthRoutes(request, env, path, method, origin) {
  // POST /api/admin/setup — One-time initial admin creation
  if (path === '/api/admin/setup' && method === 'POST') {
    return handleSetup(request, env, origin);
  }
  // POST /api/admin/login — Login with rate limiting
  if (path === '/api/admin/login' && method === 'POST') {
    return handleLogin(request, env, origin);
  }
  // POST /api/admin/logout — Logout
  if (path === '/api/admin/logout' && method === 'POST') {
    return handleLogout(request, env, origin);
  }
  // GET /api/admin/me — Get current admin info
  if (path === '/api/admin/me' && method === 'GET') {
    return handleMe(request, env, origin);
  }
  return null;
}

async function handleSetup(request, env, origin) {
  const existing = await env.DB.prepare('SELECT COUNT(*) AS count FROM admins').first();
  if (existing && existing.count > 0) {
    return errorResponse('Admin account already exists. Setup is disabled.', 403, origin);
  }

  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const missing = validateRequired(body, ['username', 'password']);
  if (missing) {
    return errorResponse(`Missing required fields: ${missing.join(', ')}`, 400, origin);
  }

  const username = sanitizeString(body.username).toLowerCase();
  const password = String(body.password);
  const displayName = sanitizeString(body.display_name || 'Admin');
  const email = body.email ? sanitizeString(body.email) : null;

  if (username.length < 3 || username.length > 50) {
    return errorResponse('Username must be between 3 and 50 characters', 400, origin);
  }
  if (password.length < 8) {
    return errorResponse('Password must be at least 8 characters', 400, origin);
  }

  const passwordHash = await hashPassword(password);
  const result = await env.DB.prepare(
    `INSERT INTO admins (username, password_hash, display_name, email, role)
     VALUES (?, ?, ?, ?, 'super_admin')`
  ).bind(username, passwordHash, displayName, email).run();

  const adminId = result.meta.last_row_id;
  const admin = await env.DB.prepare(
    'SELECT id, username, display_name, email, role, created_at FROM admins WHERE id = ?'
  ).bind(adminId).first();

  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, new_value, ip_address)
     VALUES (?, 'admin_setup', 'admin', ?, ?, ?)`
  ).bind(adminId, adminId, JSON.stringify({ username, role: 'super_admin' }), ip).run();

  const secret = env.ADMIN_JWT_SECRET || 'dev-secret-change-me';
  const token = await createToken(admin, secret);

  return jsonResponse({ admin, token, message: 'Initial admin created successfully' }, 201, origin);
}

async function handleLogin(request, env, origin) {
  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const missing = validateRequired(body, ['username', 'password']);
  if (missing) {
    return errorResponse(`Missing required fields: ${missing.join(', ')}`, 400, origin);
  }

  const username = sanitizeString(body.username).toLowerCase();
  const password = String(body.password);
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || null;

  const admin = await env.DB.prepare(
    `SELECT id, username, password_hash, display_name, email, role, is_active,
            failed_login_attempts, locked_until
     FROM admins WHERE username = ?`
  ).bind(username).first();

  if (!admin) {
    return errorResponse('Invalid username or password', 401, origin);
  }

  if (!admin.is_active) {
    return errorResponse('Account is deactivated', 403, origin);
  }

  // Rate limit check
  if (admin.locked_until) {
    const lockedUntil = new Date(admin.locked_until.replace(' ', 'T') + (admin.locked_until.endsWith('Z') ? '' : 'Z'));
    if (lockedUntil > new Date()) {
      const waitMins = Math.ceil((lockedUntil.getTime() - Date.now()) / 60000);
      return errorResponse(
        `Account temporarily locked due to too many failed attempts. Try again in ${waitMins} minute(s).`,
        429,
        origin
      );
    }
  }

  const valid = await verifyPassword(password, admin.password_hash);
  if (!valid) {
    const newAttempts = (admin.failed_login_attempts || 0) + 1;
    let lockedUntil = null;
    if (newAttempts >= MAX_FAILED_ATTEMPTS) {
      lockedUntil = new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19);
    }

    await env.DB.prepare(
      `UPDATE admins SET failed_login_attempts = ?, locked_until = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(newAttempts, lockedUntil, admin.id).run();

    await env.DB.prepare(
      `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, new_value, ip_address)
       VALUES (?, 'login_failed', 'admin', ?, ?, ?)`
    ).bind(admin.id, admin.id, JSON.stringify({ attempts: newAttempts, locked: !!lockedUntil }), ip).run();

    if (lockedUntil) {
      return errorResponse(
        `Too many failed login attempts. Account locked for ${LOCK_DURATION_MINUTES} minutes.`,
        429,
        origin
      );
    }
    return errorResponse('Invalid username or password', 401, origin);
  }

  // Successful login — reset failed attempts and update last_login_at
  await env.DB.prepare(
    `UPDATE admins
     SET failed_login_attempts = 0, locked_until = NULL, last_login_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`
  ).bind(admin.id).run();

  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, ip_address)
     VALUES (?, 'login_success', 'admin', ?, ?)`
  ).bind(admin.id, admin.id, ip).run();

  const secret = env.ADMIN_JWT_SECRET || 'dev-secret-change-me';
  const token = await createToken(admin, secret);

  return jsonResponse({
    token,
    admin: {
      id: admin.id,
      username: admin.username,
      display_name: admin.display_name,
      email: admin.email,
      role: admin.role,
    },
  }, 200, origin);
}

async function handleLogout(request, env, origin) {
  const { admin } = await authMiddleware(request, env);
  if (admin) {
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || null;
    await env.DB.prepare(
      `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, ip_address)
       VALUES (?, 'logout', 'admin', ?, ?)`
    ).bind(admin.id, admin.id, ip).run();
  }
  return jsonResponse({ message: 'Logged out successfully' }, 200, origin);
}

async function handleMe(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) {
    return errorResponse(error || 'Unauthorized', 401, origin);
  }

  const fullAdmin = await env.DB.prepare(
    'SELECT id, username, display_name, email, role, is_active, last_login_at, created_at FROM admins WHERE id = ?'
  ).bind(admin.id).first();

  return jsonResponse({ admin: fullAdmin }, 200, origin);
}
