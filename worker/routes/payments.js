// =====================================================
// Ranchi Pathology — Payment Routes
// =====================================================

import { authMiddleware } from '../utils/auth.js';
import {
  jsonResponse,
  errorResponse,
  parseBody,
  sanitizeString,
  generatePaymentRef,
  generateUPIUri,
  generateQRDataUrl,
} from '../utils/helpers.js';

export async function handlePaymentRoutes(request, env, path, method, origin) {
  if (path === '/api/admin/payments' && method === 'GET') {
    return listPayments(request, env, origin);
  }
  const qrMatch = path.match(/^\/api\/admin\/payments\/([^/]+)\/generate-qr$/);
  if (qrMatch && method === 'POST') {
    return generatePaymentQR(qrMatch[1], request, env, origin);
  }
  const verifyMatch = path.match(/^\/api\/admin\/payments\/([^/]+)\/verify$/);
  if (verifyMatch && method === 'POST') {
    return verifyPayment(verifyMatch[1], request, env, origin);
  }
  const detailMatch = path.match(/^\/api\/admin\/payments\/([^/]+)$/);
  if (detailMatch && method === 'GET') {
    return getPaymentByBooking(detailMatch[1], request, env, origin);
  }
  return null;
}

async function resolveBooking(idOrCode, db) {
  if (/^\d+$/.test(idOrCode)) {
    return db.prepare('SELECT * FROM bookings WHERE id = ?').bind(Number(idOrCode)).first();
  }
  return db.prepare('SELECT * FROM bookings WHERE booking_id = ?').bind(idOrCode).first();
}

async function generatePaymentQR(bookingIdParam, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const booking = await resolveBooking(bookingIdParam, env.DB);
  if (!booking) return errorResponse('Booking not found', 404, origin);

  if (booking.payment_status === 'paid') {
    return errorResponse('Booking is already marked as paid', 400, origin);
  }

  // Load settings
  const { results: settingsRows } = await env.DB.prepare(
    "SELECT key, value FROM business_settings WHERE key IN ('upi_id', 'upi_payee_name', 'qr_validity_minutes')"
  ).all();
  const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));

  const upiId = settings.upi_id || env.DEFAULT_UPI_ID || '6204522977@ptyes';
  const payeeName = settings.upi_payee_name || env.DEFAULT_UPI_PAYEE || 'sanu';
  const validityMinutes = Number(settings.qr_validity_minutes || 1440);

  // Server-side calculated amount
  const amount = Number(booking.total_amount);
  if (amount <= 0) {
    return errorResponse('Booking total amount must be greater than 0', 400, origin);
  }

  const paymentRef = generatePaymentRef();
  const paymentUri = generateUPIUri(upiId, payeeName, amount, paymentRef);
  const qrDataUrl = generateQRDataUrl(paymentUri);
  const qrExpiresAt = new Date(Date.now() + validityMinutes * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  // Expire any previous active QRs for this booking
  await env.DB.prepare(
    `UPDATE payments SET qr_status = 'expired', updated_at = datetime('now')
     WHERE booking_id = ? AND qr_status = 'active' AND payment_status = 'pending'`
  ).bind(booking.id).run();

  const res = await env.DB.prepare(
    `INSERT INTO payments (
      booking_id, payment_ref, amount, upi_id, payee_name, payment_uri, qr_expires_at, qr_status, payment_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'pending')`
  ).bind(booking.id, paymentRef, amount, upiId, payeeName, paymentUri, qrExpiresAt).run();

  const paymentId = res.meta.last_row_id;

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO notifications (type, title, message, reference_type, reference_id)
       VALUES ('payment_qr_generated', ?, ?, 'payment', ?)`
    ).bind(
      `Payment QR Generated (${booking.booking_id})`,
      `UPI QR (${paymentRef}) generated for ₹${amount} by ${admin.username}.`,
      paymentId
    ),
    env.DB.prepare(
      `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, new_value, ip_address)
       VALUES (?, 'generate_payment_qr', 'payment', ?, ?, ?)`
    ).bind(admin.id, paymentId, JSON.stringify({ booking_id: booking.booking_id, payment_ref: paymentRef, amount }), ip),
  ]);

  const payment = await env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(paymentId).first();
  return jsonResponse({
    payment,
    qr_data_url: qrDataUrl,
    booking_id: booking.booking_id,
  }, 201, origin);
}

async function getPaymentByBooking(bookingIdParam, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const booking = await resolveBooking(bookingIdParam, env.DB);
  if (!booking) return errorResponse('Booking not found', 404, origin);

  const { results: payments } = await env.DB.prepare(
    `SELECT p.*, a.username AS verified_by_username
     FROM payments p
     LEFT JOIN admins a ON p.verified_by = a.id
     WHERE p.booking_id = ?
     ORDER BY p.created_at DESC`
  ).bind(booking.id).all();

  const enriched = payments.map(p => ({
    ...p,
    qr_data_url: p.payment_uri ? generateQRDataUrl(p.payment_uri) : null,
  }));

  return jsonResponse({
    booking_id: booking.booking_id,
    total_amount: booking.total_amount,
    booking_payment_status: booking.payment_status,
    payments: enriched,
  }, 200, origin);
}

async function verifyPayment(paymentIdParam, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  let payment;
  if (/^\d+$/.test(paymentIdParam)) {
    payment = await env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(Number(paymentIdParam)).first();
  } else {
    payment = await env.DB.prepare('SELECT * FROM payments WHERE payment_ref = ?').bind(paymentIdParam).first();
  }

  if (!payment) return errorResponse('Payment record not found', 404, origin);

  const body = (await parseBody(request)) || {};
  const status = body.status && ['verified', 'failed', 'refunded'].includes(body.status)
    ? body.status
    : 'verified';

  if (status === 'verified') {
    if (payment.payment_status === 'verified') {
      return errorResponse('This payment has already been verified. Duplicate verification is not permitted.', 409, origin);
    }
    const existingVerified = await env.DB.prepare(
      `SELECT id FROM payments WHERE booking_id = ? AND payment_status = 'verified' AND id != ?`
    ).bind(payment.booking_id, payment.id).first();
    if (existingVerified) {
      return errorResponse('Another verified payment already exists for this booking.', 409, origin);
    }
  }
  const utrNumber = body.utr_number ? sanitizeString(body.utr_number) : payment.utr_number;
  const transactionDate = body.transaction_date ? sanitizeString(body.transaction_date) : new Date().toISOString();
  const adminNotes = body.admin_notes ? sanitizeString(body.admin_notes) : payment.admin_notes;

  const bookingPaymentStatus = status === 'verified' ? 'paid' : (status === 'refunded' ? 'refunded' : 'failed');
  const qrStatus = status === 'verified' ? 'completed' : payment.qr_status;

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE payments SET
        payment_status = ?, qr_status = ?, utr_number = ?, transaction_date = ?,
        verified_at = datetime('now'), verified_by = ?, admin_notes = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).bind(status, qrStatus, utrNumber, transactionDate, admin.id, adminNotes, payment.id),
    env.DB.prepare(
      `UPDATE bookings SET payment_status = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(bookingPaymentStatus, payment.booking_id),
    env.DB.prepare(
      `INSERT INTO notifications (type, title, message, reference_type, reference_id)
       VALUES (?, ?, ?, 'payment', ?)`
    ).bind(
      status === 'verified' ? 'payment_verified' : 'payment_updated',
      `Payment ${status.toUpperCase()} (${payment.payment_ref})`,
      `Payment ${payment.payment_ref} of ₹${payment.amount} marked as ${status} by ${admin.username}.`,
      payment.id
    ),
    env.DB.prepare(
      `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, old_value, new_value, ip_address)
       VALUES (?, 'verify_payment', 'payment', ?, ?, ?, ?)`
    ).bind(
      admin.id,
      payment.id,
      JSON.stringify({ payment_status: payment.payment_status }),
      JSON.stringify({ payment_status: status, utr_number: utrNumber }),
      ip
    ),
  ]);

  const updated = await env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(payment.id).first();
  return jsonResponse({ payment: updated }, 200, origin);
}

async function listPayments(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const url = new URL(request.url);
  const status = url.searchParams.get('status')?.trim() || '';
  const search = url.searchParams.get('search')?.trim() || '';
  const dateFrom = url.searchParams.get('date_from')?.trim() || '';
  const dateTo = url.searchParams.get('date_to')?.trim() || '';
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 25)));
  const offset = (page - 1) * limit;

  const conditions = [];
  const params = [];

  if (status) {
    conditions.push('p.payment_status = ?');
    params.push(status);
  }
  if (dateFrom) {
    conditions.push('date(p.created_at) >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push('date(p.created_at) <= ?');
    params.push(dateTo);
  }
  if (search) {
    conditions.push('(p.payment_ref LIKE ? OR p.utr_number LIKE ? OR b.booking_id LIKE ? OR b.patient_name LIKE ? OR b.patient_phone LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM payments p
     LEFT JOIN bookings b ON p.booking_id = b.id
     ${whereClause}`
  ).bind(...params).first();

  const { results: payments } = await env.DB.prepare(
    `SELECT p.*, b.booking_id AS booking_code, b.patient_name, b.patient_phone, a.username AS verified_by_username
     FROM payments p
     LEFT JOIN bookings b ON p.booking_id = b.id
     LEFT JOIN admins a ON p.verified_by = a.id
     ${whereClause}
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();

  return jsonResponse({
    payments,
    pagination: {
      total: countRow?.total || 0,
      page,
      limit,
      total_pages: Math.ceil((countRow?.total || 0) / limit),
    },
  }, 200, origin);
}
