// =====================================================
// Ranchi Pathology — Auth Utilities (Web Crypto API)
// =====================================================

const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const HASH_LENGTH = 32;

/**
 * Hash a password using PBKDF2 with Web Crypto API.
 * Returns "salt_hex:hash_hex"
 */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    HASH_LENGTH * 8
  );
  const hashArray = new Uint8Array(bits);
  return bufToHex(salt) + ':' + bufToHex(hashArray);
}

/**
 * Verify a password against a stored "salt_hex:hash_hex" string.
 */
export async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = hexToBuf(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    HASH_LENGTH * 8
  );
  return bufToHex(new Uint8Array(bits)) === hashHex;
}

/**
 * Create a JWT token using HMAC-SHA256.
 */
export async function createToken(admin, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: admin.id,
    username: admin.username,
    role: admin.role,
    iat: now,
    exp: now + 24 * 60 * 60, // 24 hours
  };
  const enc = new TextEncoder();
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = headerB64 + '.' + payloadB64;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  const sigB64 = base64urlFromBuffer(new Uint8Array(sig));
  return signingInput + '.' + sigB64;
}

/**
 * Verify a JWT token. Returns the payload or null.
 */
export async function verifyToken(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const enc = new TextEncoder();
    const signingInput = headerB64 + '.' + payloadB64;
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigBytes = base64urlToBuffer(sigB64);
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(signingInput));
    if (!valid) return null;
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Auth middleware: extracts and verifies the JWT from the Authorization header.
 * Returns { admin, error }.
 */
export async function authMiddleware(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { admin: null, error: 'Authentication required' };
  }
  const token = authHeader.slice(7);
  const secret = env.ADMIN_JWT_SECRET || 'dev-secret-change-me';
  const payload = await verifyToken(token, secret);
  if (!payload) {
    return { admin: null, error: 'Invalid or expired token' };
  }
  // Check admin is still active in DB
  const admin = await env.DB.prepare(
    'SELECT id, username, display_name, role, is_active FROM admins WHERE id = ?'
  ).bind(payload.sub).first();
  if (!admin || !admin.is_active) {
    return { admin: null, error: 'Admin account not found or deactivated' };
  }
  return { admin, error: null };
}

// ─── Helpers ───

function bufToHex(buf) {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function base64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlFromBuffer(buf) {
  let binary = '';
  for (const byte of buf) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuffer(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
