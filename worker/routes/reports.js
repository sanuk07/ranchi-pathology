// =====================================================
// Ranchi Pathology — Medical Report Routes (R2)
// =====================================================

import { authMiddleware } from '../utils/auth.js';
import { jsonResponse, errorResponse, parseBody, validateRequired, sanitizeString, corsHeaders } from '../utils/helpers.js';

const ALLOWED_MIME_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
};

export async function handleReportRoutes(request, env, path, method, origin) {
  // Public / customer verification & download
  if (path === '/api/reports/verify' && method === 'POST') {
    return verifyCustomerReports(request, env, origin);
  }
  const downloadMatch1 = path.match(/^\/api\/reports\/download\/(\d+)$/);
  if (downloadMatch1 && method === 'GET') {
    return downloadReport(downloadMatch1[1], request, env, origin);
  }
  const downloadMatch2 = path.match(/^\/api\/reports\/(\d+)\/download$/);
  if (downloadMatch2 && method === 'GET') {
    return downloadReport(downloadMatch2[1], request, env, origin);
  }

  // Admin routes
  if (path === '/api/admin/reports/upload' && method === 'POST') {
    return uploadReport(request, env, origin);
  }
  if (path === '/api/admin/reports' && method === 'GET') {
    return listReports(request, env, origin);
  }
  const patchMatch = path.match(/^\/api\/admin\/reports\/(\d+)$/);
  if (patchMatch && method === 'PATCH') {
    return updateReportAvailability(patchMatch[1], request, env, origin);
  }

  return null;
}

/**
 * Validate magic bytes of PDF, JPEG, or PNG.
 */
function verifyFileSignature(bytes, mimeType) {
  if (!bytes || bytes.length < 4) return false;
  if (mimeType === 'application/pdf') {
    // %PDF
    return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  }
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    // FF D8 FF
    return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  }
  if (mimeType === 'image/png') {
    // 89 50 4E 47 0D 0A 1A 0A
    return bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A;
  }
  return false;
}

async function uploadReport(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return errorResponse('Request must be multipart/form-data', 400, origin);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse('Failed to parse multipart form data', 400, origin);
  }

  const file = formData.get('file');
  const bookingIdParam = formData.get('booking_id');
  const title = sanitizeString(formData.get('title') || 'Diagnostic Report');
  const isAvailable = formData.get('is_available') === '0' || formData.get('is_available') === 'false' ? 0 : 1;
  const replaceReportId = formData.get('replace_report_id') ? Number(formData.get('replace_report_id')) : null;
  const replaceReason = formData.get('replace_reason') ? sanitizeString(formData.get('replace_reason')) : null;

  if (!file || typeof file === 'string') {
    return errorResponse('Report file is required', 400, origin);
  }
  if (!bookingIdParam) {
    return errorResponse('booking_id is required', 400, origin);
  }

  // Resolve booking by numeric ID or booking_id string
  let booking;
  if (/^\d+$/.test(String(bookingIdParam))) {
    booking = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(Number(bookingIdParam)).first();
  } else {
    booking = await env.DB.prepare('SELECT * FROM bookings WHERE booking_id = ?').bind(String(bookingIdParam)).first();
  }
  if (!booking) return errorResponse('Booking not found', 404, origin);

  // Enforce size limit from settings
  const sizeSetting = await env.DB.prepare(
    "SELECT value FROM business_settings WHERE key = 'max_report_size_mb'"
  ).first();
  const maxSizeMb = Number(sizeSetting?.value || 10);
  const maxBytes = maxSizeMb * 1024 * 1024;

  if (file.size <= 0 || file.size > maxBytes) {
    return errorResponse(`File size must be between 1 byte and ${maxSizeMb} MB`, 400, origin);
  }

  const fileMime = (file.type || '').toLowerCase();
  if (!ALLOWED_MIME_TYPES[fileMime]) {
    return errorResponse('Unsupported file type. Only PDF, JPEG, and PNG are allowed.', 400, origin);
  }

  const arrayBuf = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  if (!verifyFileSignature(bytes, fileMime)) {
    return errorResponse('File signature does not match declared Content-Type', 400, origin);
  }

  const ext = ALLOWED_MIME_TYPES[fileMime];
  const safeOriginalName = sanitizeString(file.name || `report.${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const fileKey = `reports/${booking.booking_id}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;

  const useR2 = !!env.REPORTS_BUCKET;
  if (useR2) {
    await env.REPORTS_BUCKET.put(fileKey, arrayBuf, {
      httpMetadata: {
        contentType: fileMime,
        contentDisposition: `inline; filename="${safeOriginalName}"`,
      },
      customMetadata: {
        booking_id: booking.booking_id,
        uploaded_by: admin.username,
      },
    });
  }

  const res = await env.DB.prepare(
    `INSERT INTO reports (
      booking_id, customer_id, title, file_key, file_name, file_type, file_size, is_available, uploaded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    booking.id,
    booking.customer_id,
    title,
    useR2 ? fileKey : `d1:${fileKey}`,
    safeOriginalName,
    fileMime,
    file.size,
    isAvailable,
    admin.id
  ).run();

  const reportId = res.meta.last_row_id;

  if (!useR2) {
    // Store privately in D1 in 300KB raw chunks (base64 encoded) so no paid R2 setup is required
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS report_file_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        data_b64 TEXT NOT NULL
      )`
    ).run();
    const CHUNK_SIZE = 300 * 1024;
    const chunkStmts = [];
    let idx = 0;
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      const slice = bytes.subarray(offset, offset + CHUNK_SIZE);
      let bin = '';
      for (let i = 0; i < slice.length; i++) bin += String.fromCharCode(slice[i]);
      chunkStmts.push(
        env.DB.prepare(
          'INSERT INTO report_file_chunks (report_id, chunk_index, data_b64) VALUES (?, ?, ?)'
        ).bind(reportId, idx++, btoa(bin))
      );
    }
    if (chunkStmts.length) await env.DB.batch(chunkStmts);
  }

  const batchStmts = [];
  if (replaceReportId) {
    batchStmts.push(
      env.DB.prepare(
        `UPDATE reports SET replaced_by = ?, replaced_at = datetime('now'), replace_reason = ?, is_available = 0, updated_at = datetime('now')
         WHERE id = ? AND booking_id = ?`
      ).bind(reportId, replaceReason || 'Replaced by newer report', replaceReportId, booking.id)
    );
  }

  batchStmts.push(
    env.DB.prepare(
      `UPDATE bookings SET report_status = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(isAvailable ? 'ready' : 'uploaded', booking.id),
    env.DB.prepare(
      `INSERT INTO notifications (type, title, message, reference_type, reference_id)
       VALUES ('report_uploaded', ?, ?, 'report', ?)`
    ).bind(
      `Report Uploaded (${booking.booking_id})`,
      `${title} uploaded for ${booking.patient_name} by ${admin.username}.`,
      reportId
    )
  );

  const ip = request.headers.get('CF-Connecting-IP') || null;
  batchStmts.push(
    env.DB.prepare(
      `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, new_value, ip_address)
       VALUES (?, 'upload_report', 'report', ?, ?, ?)`
    ).bind(admin.id, reportId, JSON.stringify({ booking_id: booking.booking_id, file_key: fileKey, title }), ip)
  );

  await env.DB.batch(batchStmts);

  const report = await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(reportId).first();
  return jsonResponse({ report }, 201, origin);
}

async function listReports(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const url = new URL(request.url);
  const bookingId = url.searchParams.get('booking_id')?.trim() || '';
  const search = url.searchParams.get('search')?.trim() || '';
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 25)));
  const offset = (page - 1) * limit;

  const conditions = [];
  const params = [];

  if (bookingId) {
    if (/^\d+$/.test(bookingId)) {
      conditions.push('r.booking_id = ?');
      params.push(Number(bookingId));
    } else {
      conditions.push('b.booking_id = ?');
      params.push(bookingId);
    }
  }
  if (search) {
    conditions.push('(r.title LIKE ? OR r.file_name LIKE ? OR b.booking_id LIKE ? OR b.patient_name LIKE ? OR b.patient_phone LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM reports r LEFT JOIN bookings b ON r.booking_id = b.id ${whereClause}`
  ).bind(...params).first();

  const { results: reports } = await env.DB.prepare(
    `SELECT r.*, b.booking_id AS booking_code, b.patient_name, b.patient_phone,
            a.username AS uploaded_by_username
     FROM reports r
     LEFT JOIN bookings b ON r.booking_id = b.id
     LEFT JOIN admins a ON r.uploaded_by = a.id
     ${whereClause}
     ORDER BY r.created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();

  return jsonResponse({
    reports,
    pagination: {
      total: countRow?.total || 0,
      page,
      limit,
      total_pages: Math.ceil((countRow?.total || 0) / limit),
    },
  }, 200, origin);
}

async function updateReportAvailability(id, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const reportId = Number(id);
  const existing = await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(reportId).first();
  if (!existing) return errorResponse('Report not found', 404, origin);

  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const isAvailable = body.is_available !== undefined ? (body.is_available ? 1 : 0) : existing.is_available;
  const title = body.title !== undefined ? sanitizeString(body.title) : existing.title;

  await env.DB.prepare(
    `UPDATE reports SET is_available = ?, title = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(isAvailable, title, reportId).run();

  if (isAvailable) {
    await env.DB.prepare(
      `UPDATE bookings SET report_status = 'ready', updated_at = datetime('now') WHERE id = ?`
    ).bind(existing.booking_id).run();
  }

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, old_value, new_value, ip_address)
     VALUES (?, 'update_report', 'report', ?, ?, ?, ?)`
  ).bind(admin.id, reportId, JSON.stringify({ is_available: existing.is_available }), JSON.stringify({ is_available: isAvailable, title }), ip).run();

  const updated = await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(reportId).first();
  return jsonResponse({ report: updated }, 200, origin);
}

async function verifyCustomerReports(request, env, origin) {
  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const bookingIdStr = sanitizeString(body.bookingId || body.booking_id || '').toUpperCase();
  const phone = sanitizeString(body.phone || '').replace(/\s+/g, '');

  if (!bookingIdStr || !phone) {
    return errorResponse('Booking ID and phone number are required', 400, origin);
  }

  const booking = await env.DB.prepare(
    `SELECT b.*, br.name AS branch_name
     FROM bookings b
     LEFT JOIN branches br ON b.branch_id = br.id
     WHERE UPPER(b.booking_id) = ?`
  ).bind(bookingIdStr).first();

  if (!booking) {
    return errorResponse('Booking not found or phone number does not match', 404, origin);
  }

  // Match last 10 digits to tolerate +91 or 0 prefix differences
  const storedDigits = booking.patient_phone.replace(/\D/g, '').slice(-10);
  const inputDigits = phone.replace(/\D/g, '').slice(-10);
  if (!storedDigits || storedDigits !== inputDigits) {
    return errorResponse('Booking not found or phone number does not match', 403, origin);
  }

  const { results: reports } = await env.DB.prepare(
    `SELECT id, title, file_name, file_type, file_size, is_available, created_at
     FROM reports
     WHERE booking_id = ? AND is_available = 1
     ORDER BY created_at DESC`
  ).bind(booking.id).all();

  const enrichedReports = reports.map(r => ({
    ...r,
    download_url: `/api/reports/download/${r.id}?token=${encodeURIComponent(booking.tracking_token)}`,
  }));

  return jsonResponse({
    tracking_token: booking.tracking_token,
    booking: {
      booking_id: booking.booking_id,
      patient_name: booking.patient_name,
      appointment_date: booking.appointment_date,
      branch_name: booking.branch_name,
      booking_status: booking.booking_status,
      report_status: booking.report_status,
    },
    reports: enrichedReports,
  }, 200, origin);
}

async function downloadReport(id, request, env, origin) {
  const reportId = Number(id);
  const url = new URL(request.url);
  const token = url.searchParams.get('token')?.trim() || '';

  // Allow either admin Bearer JWT or customer tracking token
  let isAdmin = false;
  let adminId = null;
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const { admin } = await authMiddleware(request, env);
    if (admin) {
      isAdmin = true;
      adminId = admin.id;
    }
  }

  const report = await env.DB.prepare(
    `SELECT r.*, b.tracking_token, b.tracking_token_expires_at, b.booking_id AS booking_code
     FROM reports r
     INNER JOIN bookings b ON r.booking_id = b.id
     WHERE r.id = ?`
  ).bind(reportId).first();

  if (!report) return errorResponse('Report not found', 404, origin);

  if (!isAdmin) {
    if (!token || token !== report.tracking_token) {
      return errorResponse('Valid tracking token is required to download this report', 401, origin);
    }
    if (!report.is_available) {
      return errorResponse('Report is not yet available for download', 403, origin);
    }
    if (report.tracking_token_expires_at) {
      const exp = new Date(report.tracking_token_expires_at.replace('T', ' ') + 'Z');
      if (exp < new Date()) {
        return errorResponse('Tracking token has expired', 410, origin);
      }
    }
  }

  let responseBody = null;
  if (report.file_key && !report.file_key.startsWith('d1:') && env.REPORTS_BUCKET) {
    const obj = await env.REPORTS_BUCKET.get(report.file_key);
    if (obj) responseBody = obj.body;
  } else {
    const { results: chunks } = await env.DB.prepare(
      'SELECT data_b64 FROM report_file_chunks WHERE report_id = ? ORDER BY chunk_index ASC'
    ).bind(report.id).all();
    if (chunks && chunks.length > 0) {
      const arrays = chunks.map(c => {
        const bin = atob(c.data_b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr;
      });
      const totalLen = arrays.reduce((s, a) => s + a.length, 0);
      const merged = new Uint8Array(totalLen);
      let pos = 0;
      for (const a of arrays) {
        merged.set(a, pos);
        pos += a.length;
      }
      responseBody = merged;
    }
  }

  if (!responseBody) {
    return errorResponse('Report file not found in storage', 404, origin);
  }

  // Increment access count and log report access event
  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE reports SET access_count = access_count + 1, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(report.id),
    env.DB.prepare(
      `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, new_value, ip_address)
       VALUES (?, 'download_report', 'report', ?, ?, ?)`
    ).bind(
      adminId,
      report.id,
      JSON.stringify({ booking_id: report.booking_code, access_by: isAdmin ? 'admin' : 'patient_token' }),
      ip
    ),
  ]);

  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', report.file_type || 'application/pdf');
  headers.set('Content-Disposition', `attachment; filename="${report.file_name}"`);
  headers.set('X-Content-Type-Options', 'nosniff');

  return new Response(responseBody, { status: 200, headers });
}
