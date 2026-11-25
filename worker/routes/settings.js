// =====================================================
// Ranchi Pathology — Settings & Public Contact Routes
// =====================================================

import { authMiddleware } from '../utils/auth.js';
import { jsonResponse, errorResponse, parseBody, validateRequired, sanitizeString } from '../utils/helpers.js';

const PUBLIC_SETTING_KEYS = [
  'business_name',
  'business_tagline',
  'currency',
  'timezone',
  'home_collection_default_charge',
  'max_report_size_mb',
  'environment',
  'whatsapp_configured',
  'contact_phone',
  'contact_email',
  'whatsapp_number',
];

export async function handleSettingsRoutes(request, env, path, method, origin) {
  if (path === '/api/settings/public' && method === 'GET') {
    return getPublicSettings(env, origin);
  }
  if (path === '/api/contact' && method === 'POST') {
    return handleContactForm(request, env, origin);
  }
  if (path === '/api/admin/settings' && method === 'GET') {
    return getAdminSettings(request, env, origin);
  }
  if (path === '/api/admin/settings' && method === 'PUT') {
    return updateAdminSettings(request, env, origin);
  }
  return null;
}

async function getPublicSettings(env, origin) {
  const placeholders = PUBLIC_SETTING_KEYS.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM business_settings WHERE key IN (${placeholders})`
  ).bind(...PUBLIC_SETTING_KEYS).all();

  const settings = Object.fromEntries(results.map(r => [r.key, r.value]));
  // Always reflect Worker ENVIRONMENT var if set
  if (env.ENVIRONMENT) {
    settings.environment = env.ENVIRONMENT;
  }
  if (env.APP_NAME && !settings.business_name) {
    settings.business_name = env.APP_NAME;
  }
  if (env.CURRENCY && !settings.currency) {
    settings.currency = env.CURRENCY;
  }
  if (env.TIMEZONE && !settings.timezone) {
    settings.timezone = env.TIMEZONE;
  }

  const adminRow = await env.DB.prepare('SELECT COUNT(*) AS count FROM admins').first();
  const hasAdmin = (adminRow?.count || 0) > 0;

  return jsonResponse({
    settings,
    has_admin: hasAdmin,
    needs_setup: !hasAdmin,
  }, 200, origin);
}

async function getAdminSettings(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const { results } = await env.DB.prepare(
    'SELECT key, value, updated_at FROM business_settings ORDER BY key ASC'
  ).all();

  const settings = Object.fromEntries(results.map(r => [r.key, r.value]));
  return jsonResponse({ settings, rows: results }, 200, origin);
}

async function updateAdminSettings(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const updates = body.settings && typeof body.settings === 'object' ? body.settings : body;
  const entries = Object.entries(updates).filter(([k, v]) => k && v !== undefined && v !== null);

  if (entries.length === 0) {
    return errorResponse('No settings provided to update', 400, origin);
  }

  const stmts = entries.map(([key, value]) =>
    env.DB.prepare(
      `INSERT INTO business_settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).bind(sanitizeString(key), String(value).trim())
  );

  await env.DB.batch(stmts);

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, new_value, ip_address)
     VALUES (?, 'update_settings', 'settings', ?, ?)`
  ).bind(admin.id, JSON.stringify(Object.fromEntries(entries)), ip).run();

  const { results } = await env.DB.prepare('SELECT key, value, updated_at FROM business_settings ORDER BY key ASC').all();
  return jsonResponse({
    message: 'Settings updated successfully',
    settings: Object.fromEntries(results.map(r => [r.key, r.value])),
  }, 200, origin);
}

async function handleContactForm(request, env, origin) {
  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const missing = validateRequired(body, ['name', 'message']);
  if (missing) return errorResponse(`Missing required fields: ${missing.join(', ')}`, 400, origin);

  const name = sanitizeString(body.name);
  const phone = body.phone ? sanitizeString(body.phone) : '';
  const email = body.email ? sanitizeString(body.email) : '';
  const subject = sanitizeString(body.subject || 'General Inquiry');
  const message = sanitizeString(body.message);

  if (!phone && !email) {
    return errorResponse('Please provide a phone number or email address', 400, origin);
  }
  if (message.length < 5) {
    return errorResponse('Message is too short', 400, origin);
  }

  const contactSummary = `${name} (${phone || email})${body.branch ? ' [' + sanitizeString(body.branch) + ']' : ''} — ${subject}: ${message}`;

  await env.DB.prepare(
    `INSERT INTO notifications (type, title, message, reference_type)
     VALUES ('contact_inquiry', ?, ?, 'contact')`
  ).bind(`Contact Inquiry: ${name}`, contactSummary).run();

  return jsonResponse({
    message: 'Thank you for contacting us. Our team will get back to you shortly.',
  }, 201, origin);
}
