// =====================================================
// Ranchi Pathology — Utility Helpers
// =====================================================

let configuredAllowedOrigin = null;

export function setAllowedOrigin(allowedOrigin) {
  configuredAllowedOrigin = allowedOrigin || null;
}

/**
 * Generate a booking ID: RP-20261125-XXXX
 */
export function generateBookingId(prefix = 'RP') {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let rand = '';
  for (const b of bytes) rand += chars[b % chars.length];
  return `${prefix}-${dateStr}-${rand}`;
}

/**
 * Generate an unpredictable tracking token.
 */
export function generateTrackingToken() {
  const uuid = crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${uuid}-${hex}`;
}

/**
 * Generate a unique payment reference.
 */
export function generatePaymentRef() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(rand).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `PAY-${ts}-${hex}`;
}

/**
 * Generate a UPI payment URI.
 */
export function generateUPIUri(upiId, payeeName, amount, ref) {
  const params = new URLSearchParams({
    pa: upiId,
    pn: payeeName,
    am: Number(amount).toFixed(2),
    cu: 'INR',
    tr: ref,
    tn: `Ranchi Pathology - ${ref}`,
  });
  return `upi://pay?${params.toString()}`;
}

function isOriginAllowed(origin, allowedOriginEnv) {
  if (!origin) return false;
  if (allowedOriginEnv) {
    const list = allowedOriginEnv.split(',').map(s => s.trim()).filter(Boolean);
    if (list.includes('*') || list.includes(origin)) return true;
  }
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    if (u.hostname.endsWith('.pages.dev') && u.protocol === 'https:') return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * CORS + security headers. Allows env.ALLOWED_ORIGIN, *.pages.dev, localhost, and same-origin requests.
 */
export function corsHeaders(origin, allowedOrigin = configuredAllowedOrigin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };

  if (origin && isOriginAllowed(origin, allowedOrigin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  } else if (!origin) {
    headers['Access-Control-Allow-Origin'] = '*';
  }

  return headers;
}

/**
 * JSON success response.
 */
export function jsonResponse(data, status = 200, origin = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

/**
 * JSON error response.
 */
export function errorResponse(message, status = 400, origin = null) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

/**
 * Parse request body as JSON.
 */
export async function parseBody(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Validate that required fields are present and non-empty.
 */
export function validateRequired(body, fields) {
  const missing = [];
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') {
      missing.push(f);
    }
  }
  return missing.length ? missing : null;
}

/**
 * Sanitize a string: trim, collapse whitespace, strip angle brackets.
 */
export function sanitizeString(str) {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/[<>]/g, '').replace(/\s+/g, ' ');
}

// ─── QR Code Generator (pure JS, SVG-based, ISO 18004 ECC-L Versions 1-10) ───

/**
 * Generate a data URL containing an SVG QR code for the given text.
 */
export function generateQRDataUrl(text) {
  const svg = generateQRSvg(text);
  return 'data:image/svg+xml;base64,' + btoa(svg);
}

function generateQRSvg(text) {
  const modules = encodeQR(text);
  const size = modules.length;
  const cellSize = 10;
  const margin = 4;
  const totalSize = (size + margin * 2) * cellSize;
  let paths = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        const x = (c + margin) * cellSize;
        const y = (r + margin) * cellSize;
        paths += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}"/>`;
      }
    }
  }
  return `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><g fill="black">${paths}</g></svg>`;
}

// ECC-L block specs for versions 1..10: [ecPerBlock, g1Blocks, g1DataCw, g2Blocks, g2DataCw]
const QR_SPEC_L = {
  1: [7, 1, 19, 0, 0],
  2: [10, 1, 34, 0, 0],
  3: [15, 1, 55, 0, 0],
  4: [20, 1, 80, 0, 0],
  5: [26, 1, 108, 0, 0],
  6: [18, 2, 68, 0, 0],
  7: [20, 2, 78, 0, 0],
  8: [24, 2, 97, 0, 0],
  9: [30, 2, 116, 0, 0],
  10: [18, 2, 68, 2, 69],
};

function selectVersion(dataLen) {
  for (let v = 1; v <= 10; v++) {
    const [, g1B, g1D, g2B, g2D] = QR_SPEC_L[v];
    const dataCw = g1B * g1D + g2B * g2D;
    const ccBits = v <= 9 ? 8 : 16;
    const capacityBits = dataCw * 8 - 4 - ccBits;
    if (dataLen * 8 <= capacityBits) return v;
  }
  return 10;
}

function encodeQR(text) {
  const data = new TextEncoder().encode(text);
  const version = selectVersion(data.length);
  const size = version * 4 + 17;
  const [ecPerBlock, g1Blocks, g1DataCw, g2Blocks, g2DataCw] = QR_SPEC_L[version];
  const totalDataCw = g1Blocks * g1DataCw + g2Blocks * g2DataCw;

  const bits = [];
  pushBits(bits, 0b0100, 4); // Byte mode
  const ccBits = version <= 9 ? 8 : 16;
  const maxBytes = Math.floor((totalDataCw * 8 - 4 - ccBits) / 8);
  const payload = data.slice(0, maxBytes);
  pushBits(bits, payload.length, ccBits);
  for (const b of payload) pushBits(bits, b, 8);

  const capacity = totalDataCw * 8;
  const termLen = Math.min(4, capacity - bits.length);
  pushBits(bits, 0, termLen);
  while (bits.length % 8 !== 0) bits.push(0);

  const padBytes = [0xEC, 0x11];
  let padIdx = 0;
  while (bits.length < capacity) {
    pushBits(bits, padBytes[padIdx % 2], 8);
    padIdx++;
  }

  const dataBytes = bitsToBytes(bits);

  // Split into RS blocks and interleave data + EC codewords
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < g1Blocks; i++) {
    const blk = dataBytes.slice(offset, offset + g1DataCw);
    dataBlocks.push(blk);
    ecBlocks.push(computeEC(blk, ecPerBlock));
    offset += g1DataCw;
  }
  for (let i = 0; i < g2Blocks; i++) {
    const blk = dataBytes.slice(offset, offset + g2DataCw);
    dataBlocks.push(blk);
    ecBlocks.push(computeEC(blk, ecPerBlock));
    offset += g2DataCw;
  }

  const allBytes = [];
  const maxDataLen = Math.max(g1DataCw, g2DataCw);
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of dataBlocks) {
      if (i < blk.length) allBytes.push(blk[i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const ec of ecBlocks) {
      allBytes.push(ec[i]);
    }
  }

  const grid = Array.from({ length: size }, () => new Uint8Array(size));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  placeFinderPattern(grid, reserved, 0, 0, size);
  placeFinderPattern(grid, reserved, size - 7, 0, size);
  placeFinderPattern(grid, reserved, 0, size - 7, size);

  for (let i = 8; i < size - 8; i++) {
    grid[6][i] = i % 2 === 0 ? 1 : 0;
    reserved[6][i] = 1;
    grid[i][6] = i % 2 === 0 ? 1 : 0;
    reserved[i][6] = 1;
  }

  if (version >= 2) {
    const positions = ALIGNMENT_POSITIONS[version] || [];
    for (const r of positions) {
      for (const c of positions) {
        if (reserved[r][c]) continue;
        placeAlignmentPattern(grid, reserved, r, c, size);
      }
    }
  }

  grid[size - 8][8] = 1;
  reserved[size - 8][8] = 1;

  reserveFormatAreas(reserved, size);
  if (version >= 7) reserveVersionAreas(reserved, size);

  placeData(grid, reserved, allBytes, size);
  applyMask(grid, reserved, size);
  placeFormatInfo(grid, size);
  if (version >= 7) placeVersionInfo(grid, size, version);

  return grid;
}

function pushBits(arr, value, count) {
  for (let i = count - 1; i >= 0; i--) {
    arr.push((value >> i) & 1);
  }
}

function bitsToBytes(bits) {
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] || 0);
    bytes.push(byte);
  }
  return bytes;
}

function computeEC(data, ecLen) {
  const gfExp = new Uint8Array(512);
  const gfLog = new Uint8Array(256);
  let val = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = val;
    gfLog[val] = i;
    val <<= 1;
    if (val >= 256) val ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255];

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return gfExp[gfLog[a] + gfLog[b]];
  }

  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const newGen = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      newGen[j] ^= gen[j];
      newGen[j + 1] ^= gfMul(gen[j], gfExp[i]);
    }
    gen = newGen;
  }

  const msg = new Array(data.length + ecLen).fill(0);
  for (let i = 0; i < data.length; i++) msg[i] = data[i];
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return msg.slice(data.length);
}

function placeFinderPattern(grid, reserved, row, col, size) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const gr = row + r, gc = col + c;
      if (gr < 0 || gr >= size || gc < 0 || gc >= size) continue;
      reserved[gr][gc] = 1;
      if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
        grid[gr][gc] = (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) ? 1 : 0;
      } else {
        grid[gr][gc] = 0;
      }
    }
  }
}

function placeAlignmentPattern(grid, reserved, centerR, centerC, size) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const gr = centerR + r, gc = centerC + c;
      if (gr < 0 || gr >= size || gc < 0 || gc >= size) continue;
      reserved[gr][gc] = 1;
      grid[gr][gc] = (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)) ? 1 : 0;
    }
  }
}

const ALIGNMENT_POSITIONS = {
  2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

function reserveFormatAreas(reserved, size) {
  for (let i = 0; i < 9; i++) {
    if (i < size) reserved[8][i] = 1;
    if (i < size) reserved[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = 1;
    reserved[size - 1 - i][8] = 1;
  }
}

function reserveVersionAreas(reserved, size) {
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 3; j++) {
      reserved[i][size - 11 + j] = 1;
      reserved[size - 11 + j][i] = 1;
    }
  }
}

function placeData(grid, reserved, bytes, size) {
  let bitIdx = 0;
  const totalBits = bytes.length * 8;
  let col = size - 1;
  let goingUp = true;

  while (col >= 0) {
    if (col === 6) col--;
    const rows = goingUp
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const row of rows) {
      for (let dc = 0; dc <= 1; dc++) {
        const c = col - dc;
        if (c < 0 || c >= size || reserved[row][c]) continue;
        if (bitIdx < totalBits) {
          const byteIdx = Math.floor(bitIdx / 8);
          const bitPos = 7 - (bitIdx % 8);
          grid[row][c] = (bytes[byteIdx] >> bitPos) & 1;
          bitIdx++;
        }
      }
    }
    col -= 2;
    goingUp = !goingUp;
  }
}

function applyMask(grid, reserved, size) {
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && (r + c) % 2 === 0) {
        grid[r][c] ^= 1;
      }
    }
  }
}

function placeFormatInfo(grid, size) {
  // ECC L (01) + Mask 0 (000) -> BCH + mask 101010000010010 = 111011111000100
  const bits = 0b111011111000100;

  // Strip 1: bit 0 at [0,8] up to bit 14 at [8,0]
  const strip1 = [
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
    [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  ];
  for (let i = 0; i < 15; i++) {
    const [r, c] = strip1[i];
    grid[r][c] = (bits >> i) & 1;
  }

  // Strip 2: bit 0..7 along row 8 from right [8, size-1]..[8, size-8], bit 8..14 along col 8 [size-7, 8]..[size-1, 8]
  for (let i = 0; i < 8; i++) {
    grid[8][size - 1 - i] = (bits >> i) & 1;
  }
  for (let i = 8; i < 15; i++) {
    grid[size - 15 + i][8] = (bits >> i) & 1;
  }
}

function placeVersionInfo(grid, size, version) {
  const VERSION_INFO = { 7: 0x07C94, 8: 0x085BC, 9: 0x09A99, 10: 0x0A4D3 };
  const info = VERSION_INFO[version];
  if (!info) return;
  for (let i = 0; i < 18; i++) {
    const bit = (info >> i) & 1;
    const r = Math.floor(i / 3);
    const c = size - 11 + (i % 3);
    grid[r][c] = bit;
    grid[c][r] = bit;
  }
}
