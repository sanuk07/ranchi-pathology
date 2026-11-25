// =====================================================
// Ranchi Pathology — Booking Routes
// =====================================================

import { authMiddleware } from '../utils/auth.js';
import {
  jsonResponse,
  errorResponse,
  parseBody,
  validateRequired,
  sanitizeString,
  generateBookingId,
  generateTrackingToken,
  generateQRDataUrl,
} from '../utils/helpers.js';
import { validateOfferForItems } from './offers.js';

export async function handleBookingRoutes(request, env, path, method, origin) {
  // Public routes
  if (path === '/api/bookings' && method === 'POST') {
    return createBooking(request, env, origin);
  }
  const trackMatch = path.match(/^\/api\/bookings\/track\/([^/]+)$/);
  if (trackMatch && method === 'GET') {
    return trackBooking(decodeURIComponent(trackMatch[1]), env, origin);
  }
  if (path === '/api/bookings/track-by-id' && method === 'POST') {
    return trackBookingById(request, env, origin);
  }

  // Admin routes
  if (path === '/api/admin/bookings' && method === 'GET') {
    return listBookings(request, env, origin);
  }
  const detailMatch = path.match(/^\/api\/admin\/bookings\/([^/]+)$/);
  if (detailMatch && method === 'GET') {
    return getBookingDetail(detailMatch[1], request, env, origin);
  }
  const statusMatch = path.match(/^\/api\/admin\/bookings\/([^/]+)\/status$/);
  if (statusMatch && method === 'PATCH') {
    return updateBookingStatus(statusMatch[1], request, env, origin);
  }
  const notesMatch = path.match(/^\/api\/admin\/bookings\/([^/]+)\/notes$/);
  if (notesMatch && method === 'POST') {
    return addBookingNote(notesMatch[1], request, env, origin);
  }

  return null;
}

async function createBooking(request, env, origin) {
  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const missing = validateRequired(body, [
    'branch_id',
    'appointment_type',
    'appointment_date',
    'appointment_time',
    'patient_name',
    'patient_phone',
    'items',
  ]);
  if (missing) return errorResponse(`Missing required fields: ${missing.join(', ')}`, 400, origin);

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return errorResponse('At least one test or package must be selected', 400, origin);
  }

  const branchId = Number(body.branch_id);
  const appointmentType = sanitizeString(body.appointment_type);
  if (!['branch_visit', 'home_collection'].includes(appointmentType)) {
    return errorResponse('appointment_type must be branch_visit or home_collection', 400, origin);
  }

  const appointmentDate = sanitizeString(body.appointment_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate)) {
    return errorResponse('appointment_date must be YYYY-MM-DD', 400, origin);
  }

  const appointmentTime = sanitizeString(body.appointment_time);
  const patientName = sanitizeString(body.patient_name);
  const patientPhone = sanitizeString(body.patient_phone).replace(/\s+/g, '');

  if (patientPhone.length < 10) {
    return errorResponse('Valid patient phone number is required', 400, origin);
  }

  if (appointmentType === 'home_collection') {
    const homeMissing = validateRequired(body, ['home_address', 'home_pincode']);
    if (homeMissing) {
      return errorResponse(`Home collection requires: ${homeMissing.join(', ')}`, 400, origin);
    }
  }

  // Verify branch
  const branch = await env.DB.prepare(
    'SELECT * FROM branches WHERE id = ? AND is_active = 1'
  ).bind(branchId).first();
  if (!branch) return errorResponse('Selected branch not found or inactive', 404, origin);

  if (appointmentType === 'home_collection' && !branch.home_collection_available) {
    return errorResponse('Home collection is not available for this branch', 400, origin);
  }

  // Check branch holiday
  const holiday = await env.DB.prepare(
    'SELECT reason FROM branch_holidays WHERE branch_id = ? AND holiday_date = ?'
  ).bind(branchId, appointmentDate).first();
  if (holiday) {
    return errorResponse(`Branch is closed on ${appointmentDate}: ${holiday.reason}`, 400, origin);
  }

  // Check weekly_off
  if (branch.weekly_off) {
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayOfWeek = new Date(appointmentDate + 'T00:00:00Z').getUTCDay();
    const offList = branch.weekly_off.toLowerCase().split(',').map(s => s.trim());
    if (offList.includes(dayNames[dayOfWeek]) || offList.includes(String(dayOfWeek))) {
      return errorResponse(`Branch has weekly off on ${dayNames[dayOfWeek]}`, 400, origin);
    }
  }

  // Separate packages & individual tests to prevent double-charging tests already inside selected packages
  const pkgRequests = [];
  const testRequests = [];

  for (const reqItem of body.items) {
    const itemType = reqItem.item_type === 'package' ? 'package' : 'test';
    const itemId = Number(reqItem.item_id || reqItem.id);
    const quantity = Math.max(1, Math.min(10, Number(reqItem.quantity || 1)));
    if (!itemId || isNaN(itemId)) {
      return errorResponse('Invalid item_id in items list', 400, origin);
    }
    if (itemType === 'package') {
      pkgRequests.push({ itemId, quantity });
    } else {
      testRequests.push({ itemId, quantity });
    }
  }

  const resolvedItems = [];
  const packageTestIds = new Set();
  const overlapSkipped = [];
  let subtotal = 0;

  // 1. Resolve packages first
  for (const { itemId, quantity } of pkgRequests) {
    const pkg = await env.DB.prepare(
      'SELECT id, slug, name, original_price, offer_price, home_collection_available FROM packages WHERE id = ? AND is_active = 1'
    ).bind(itemId).first();
    if (!pkg) return errorResponse(`Package #${itemId} not found or inactive`, 404, origin);
    if (appointmentType === 'home_collection' && !pkg.home_collection_available) {
      return errorResponse(`Package "${pkg.name}" is not available for home collection`, 400, origin);
    }

    const { results: pts } = await env.DB.prepare(
      'SELECT test_id FROM package_tests WHERE package_id = ?'
    ).bind(pkg.id).all();
    for (const pt of pts) packageTestIds.add(pt.test_id);

    const effectivePrice = Number(pkg.offer_price);
    const itemDiscount = Math.max(0, Number(pkg.original_price) - effectivePrice);
    const totalPrice = effectivePrice * quantity;
    subtotal += totalPrice;
    resolvedItems.push({
      item_type: 'package',
      item_id: pkg.id,
      item_name: pkg.name,
      item_code: pkg.slug,
      quantity,
      unit_price: Number(pkg.original_price),
      discount: itemDiscount * quantity,
      total_price: totalPrice,
    });
  }

  // 2. Resolve individual tests (skip if already included in a selected package)
  for (const { itemId, quantity } of testRequests) {
    const test = await env.DB.prepare(
      'SELECT id, test_code, name, price, discounted_price, home_collection_available FROM tests WHERE id = ? AND is_active = 1'
    ).bind(itemId).first();
    if (!test) return errorResponse(`Test #${itemId} not found or inactive`, 404, origin);

    if (packageTestIds.has(test.id)) {
      overlapSkipped.push({ id: test.id, name: test.name, reason: 'Already included in selected package' });
      continue;
    }

    if (appointmentType === 'home_collection' && !test.home_collection_available) {
      return errorResponse(`Test "${test.name}" is not available for home collection`, 400, origin);
    }

    const effectivePrice = test.discounted_price !== null ? Number(test.discounted_price) : Number(test.price);
    const itemDiscount = Math.max(0, Number(test.price) - effectivePrice);
    const totalPrice = effectivePrice * quantity;
    subtotal += totalPrice;
    resolvedItems.push({
      item_type: 'test',
      item_id: test.id,
      item_name: test.name,
      item_code: test.test_code,
      quantity,
      unit_price: Number(test.price),
      discount: itemDiscount * quantity,
      total_price: totalPrice,
    });
  }

  if (resolvedItems.length === 0) {
    return errorResponse('No valid tests or packages selected', 400, origin);
  }

  // Home collection charge calculated server-side
  let homeCollectionCharge = 0;
  if (appointmentType === 'home_collection') {
    if (branch.home_collection_charge_type === 'fixed' && branch.home_collection_charge_amount > 0) {
      homeCollectionCharge = Number(branch.home_collection_charge_amount);
    } else if (branch.home_collection_charge_type !== 'free') {
      const defaultChargeSetting = await env.DB.prepare(
        "SELECT value FROM business_settings WHERE key = 'home_collection_default_charge'"
      ).first();
      if (defaultChargeSetting && Number(defaultChargeSetting.value) > 0) {
        homeCollectionCharge = Number(defaultChargeSetting.value);
      }
    }
  }

  // Validate coupon server-side if provided
  let discountAmount = 0;
  let couponCode = null;
  let appliedOfferId = null;

  if (body.coupon_code && sanitizeString(body.coupon_code)) {
    const code = sanitizeString(body.coupon_code).toUpperCase();
    const offerResult = await validateOfferForItems(env.DB, {
      code,
      subtotal,
      branchId,
      items: resolvedItems,
      customerPhone: patientPhone,
    });
    if (!offerResult.valid) {
      return errorResponse(offerResult.error, 400, origin);
    }
    discountAmount = offerResult.discount_amount;
    couponCode = offerResult.offer.code;
    appliedOfferId = offerResult.offer.id;
  }

  const totalAmount = Math.max(0, Math.round((subtotal + homeCollectionCharge - discountAmount) * 100) / 100);

  // Upsert customer
  const customer = await env.DB.prepare(
    'SELECT id FROM customers WHERE phone = ?'
  ).bind(patientPhone).first();

  let customerId;
  if (customer) {
    customerId = customer.id;
    await env.DB.prepare(
      `UPDATE customers SET
        full_name = COALESCE(NULLIF(?, ''), full_name),
        email = COALESCE(?, email),
        gender = COALESCE(?, gender),
        address = COALESCE(?, address),
        city = COALESCE(?, city),
        pincode = COALESCE(?, pincode),
        updated_at = datetime('now')
       WHERE id = ?`
    ).bind(
      patientName,
      body.patient_email ? sanitizeString(body.patient_email) : null,
      body.patient_gender ? sanitizeString(body.patient_gender) : null,
      body.home_address ? sanitizeString(body.home_address) : null,
      body.home_city ? sanitizeString(body.home_city) : null,
      body.home_pincode ? sanitizeString(body.home_pincode) : null,
      customerId
    ).run();
  } else {
    const custRes = await env.DB.prepare(
      `INSERT INTO customers (full_name, phone, email, gender, address, city, pincode)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      patientName,
      patientPhone,
      body.patient_email ? sanitizeString(body.patient_email) : null,
      body.patient_gender ? sanitizeString(body.patient_gender) : null,
      body.home_address ? sanitizeString(body.home_address) : null,
      body.home_city ? sanitizeString(body.home_city) : null,
      body.home_pincode ? sanitizeString(body.home_pincode) : null
    ).run();
    customerId = custRes.meta.last_row_id;
  }

  // Reserve slot atomically if slot_id is given
  const slotId = body.slot_id ? Number(body.slot_id) : null;
  if (slotId) {
    const slotRes = await env.DB.prepare(
      `UPDATE appointment_slots
       SET booked_count = booked_count + 1
       WHERE id = ? AND branch_id = ? AND slot_date = ? AND is_active = 1 AND booked_count < max_capacity`
    ).bind(slotId, branchId, appointmentDate).run();

    if (!slotRes.meta.changes) {
      return errorResponse('Selected appointment slot is full or unavailable', 409, origin);
    }
  }

  const prefixSetting = await env.DB.prepare(
    "SELECT value FROM business_settings WHERE key = 'booking_id_prefix'"
  ).first();
  const prefix = prefixSetting?.value || 'RP';
  const isDemo = env.ENVIRONMENT === 'demo' ? 1 : 0;

  const bookingIdStr = generateBookingId(prefix);
  const trackingToken = generateTrackingToken();
  const trackingExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  try {
    const stmts = [
      env.DB.prepare(
        `INSERT INTO bookings (
          booking_id, customer_id, branch_id, appointment_type, appointment_date, appointment_time, slot_id,
          patient_name, patient_phone, patient_age, patient_gender, patient_email,
          home_address, home_pincode, home_landmark, home_city, home_contact_instructions,
          subtotal, home_collection_charge, discount_amount, coupon_code, total_amount,
          notes, consent_given, booking_status, payment_status, sample_status, report_status,
          tracking_token, tracking_token_expires_at, is_demo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'pending', 'pending', 'pending', ?, ?, ?)`
      ).bind(
        bookingIdStr,
        customerId,
        branchId,
        appointmentType,
        appointmentDate,
        appointmentTime,
        slotId,
        patientName,
        patientPhone,
        body.patient_age ? Number(body.patient_age) : null,
        body.patient_gender ? sanitizeString(body.patient_gender) : null,
        body.patient_email ? sanitizeString(body.patient_email) : null,
        body.home_address ? sanitizeString(body.home_address) : null,
        body.home_pincode ? sanitizeString(body.home_pincode) : null,
        body.home_landmark ? sanitizeString(body.home_landmark) : null,
        body.home_city ? sanitizeString(body.home_city) : null,
        body.home_contact_instructions ? sanitizeString(body.home_contact_instructions) : null,
        subtotal,
        homeCollectionCharge,
        discountAmount,
        couponCode,
        totalAmount,
        body.notes ? sanitizeString(body.notes) : null,
        body.consent_given ? 1 : 0,
        trackingToken,
        trackingExpiresAt,
        isDemo
      ),
    ];

    for (const item of resolvedItems) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO booking_items (booking_id, item_type, item_id, item_name, item_code, quantity, unit_price, discount, total_price)
           VALUES ((SELECT id FROM bookings WHERE booking_id = ?), ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          bookingIdStr,
          item.item_type,
          item.item_id,
          item.item_name,
          item.item_code,
          item.quantity,
          item.unit_price,
          item.discount,
          item.total_price
        )
      );
    }

    if (appliedOfferId) {
      stmts.push(
        env.DB.prepare(
          `UPDATE offers SET times_used = times_used + 1, updated_at = datetime('now')
           WHERE id = ? AND (total_usage_limit IS NULL OR times_used < total_usage_limit)`
        ).bind(appliedOfferId)
      );
    }

    stmts.push(
      env.DB.prepare(
        `INSERT INTO notifications (type, title, message, reference_type, reference_id)
         VALUES ('new_booking', ?, ?, 'booking', (SELECT id FROM bookings WHERE booking_id = ?))`
      ).bind(
        `New Booking ${bookingIdStr}`,
        `${patientName} (${patientPhone}) booked ${resolvedItems.length} item(s) at ${branch.name} for ${appointmentDate} ${appointmentTime}. Total: ₹${totalAmount}`,
        bookingIdStr
      )
    );

    await env.DB.batch(stmts);
  } catch (err) {
    if (slotId) {
      await env.DB.prepare(
        'UPDATE appointment_slots SET booked_count = MAX(0, booked_count - 1) WHERE id = ?'
      ).bind(slotId).run();
    }
    throw err;
  }

  const booking = await env.DB.prepare(
    'SELECT * FROM bookings WHERE booking_id = ?'
  ).bind(bookingIdStr).first();

  return jsonResponse({
    booking: {
      id: booking.id,
      booking_id: booking.booking_id,
      tracking_token: booking.tracking_token,
      appointment_type: booking.appointment_type,
      appointment_date: booking.appointment_date,
      appointment_time: booking.appointment_time,
      branch_name: branch.name,
      subtotal: booking.subtotal,
      home_collection_charge: booking.home_collection_charge,
      discount_amount: booking.discount_amount,
      coupon_code: booking.coupon_code,
      total_amount: booking.total_amount,
      booking_status: booking.booking_status,
      payment_status: booking.payment_status,
    },
    items: resolvedItems,
    overlap_skipped: overlapSkipped,
  }, 201, origin);
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '—';
  const last4 = digits.slice(-4);
  return `••••••${last4}`;
}

async function buildTrackingPayload(booking, env) {
  const [itemsRes, reportsRes, paymentRow, recentTestsRes] = await Promise.all([
    env.DB.prepare(
      'SELECT item_type, item_id, item_name, item_code, quantity, unit_price, discount, total_price FROM booking_items WHERE booking_id = ?'
    ).bind(booking.id).all(),
    env.DB.prepare(
      `SELECT id, title, file_name, file_type, file_size, created_at
       FROM reports
       WHERE booking_id = ? AND is_available = 1
       ORDER BY created_at DESC`
    ).bind(booking.id).all(),
    env.DB.prepare(
      `SELECT payment_ref, amount, upi_id, payee_name, payment_uri, payment_status,
              qr_status, qr_expires_at, utr_number, verified_at, created_at
       FROM payments
       WHERE booking_id = ?
       ORDER BY created_at DESC LIMIT 1`
    ).bind(booking.id).first(),
    env.DB.prepare(
      `SELECT bi.item_type, bi.item_name, bi.item_code, bi.total_price,
              b.booking_id, b.tracking_token, b.appointment_date, b.booking_status, b.report_status, b.created_at
       FROM booking_items bi
       INNER JOIN bookings b ON bi.booking_id = b.id
       WHERE b.customer_id = ?
       ORDER BY b.created_at DESC, bi.id DESC
       LIMIT 10`
    ).bind(booking.customer_id).all(),
  ]);

  const { internal_notes, ...publicBooking } = booking;
  publicBooking.patient_phone = maskPhone(booking.patient_phone);

  const branch = {
    id: booking.branch_id,
    name: booking.branch_name,
    slug: booking.branch_slug,
    address: booking.branch_address,
    city: booking.branch_city,
    phone: booking.branch_phone,
    map_link: booking.branch_map_link,
  };

  let payment = null;
  if (paymentRow) {
    let effectiveQrStatus = paymentRow.qr_status;
    if (effectiveQrStatus === 'active' && paymentRow.qr_expires_at) {
      const exp = new Date(paymentRow.qr_expires_at.replace(' ', 'T') + (paymentRow.qr_expires_at.endsWith('Z') ? '' : 'Z'));
      if (exp < new Date()) {
        effectiveQrStatus = 'expired';
      }
    }
    const qrDataUrl = effectiveQrStatus === 'active' && paymentRow.payment_uri
      ? generateQRDataUrl(paymentRow.payment_uri)
      : null;
    payment = {
      payment_ref: paymentRow.payment_ref,
      amount: paymentRow.amount,
      upi_id: paymentRow.upi_id,
      payee_name: paymentRow.payee_name,
      upi_uri: effectiveQrStatus === 'active' ? paymentRow.payment_uri : null,
      qr_data_url: qrDataUrl,
      qr_status: effectiveQrStatus,
      qr_expires_at: paymentRow.qr_expires_at,
      payment_status: paymentRow.payment_status,
      utr_number: paymentRow.utr_number,
      verified_at: paymentRow.verified_at,
      created_at: paymentRow.created_at,
    };
  }

  const reports = reportsRes.results.map(r => ({
    ...r,
    download_url: `/api/reports/download/${r.id}?token=${encodeURIComponent(booking.tracking_token)}`,
  }));

  return {
    booking: publicBooking,
    branch,
    items: itemsRes.results,
    payment,
    reports,
    recent_tests: recentTestsRes.results || [],
    qrCodeUrl: payment?.qr_status === 'active' ? payment.qr_data_url : null,
    upiUri: payment?.qr_status === 'active' ? payment.upi_uri : null,
    reportUrl: reports.length > 0 ? reports[0].download_url : null,
  };
}

async function trackBooking(token, env, origin) {
  const booking = await env.DB.prepare(
    `SELECT b.*, br.name AS branch_name, br.slug AS branch_slug, br.address AS branch_address,
            br.city AS branch_city, br.phone AS branch_phone, br.map_link AS branch_map_link
     FROM bookings b
     LEFT JOIN branches br ON b.branch_id = br.id
     WHERE b.tracking_token = ?`
  ).bind(token).first();

  if (!booking) return errorResponse('Booking not found', 404, origin);

  if (booking.tracking_token_expires_at) {
    const exp = new Date(booking.tracking_token_expires_at.replace(' ', 'T') + (booking.tracking_token_expires_at.endsWith('Z') ? '' : 'Z'));
    if (exp < new Date()) {
      return errorResponse('Tracking token has expired', 410, origin);
    }
  }

  const payload = await buildTrackingPayload(booking, env);
  return jsonResponse(payload, 200, origin);
}

async function trackBookingById(request, env, origin) {
  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const bookingIdStr = sanitizeString(body.booking_id || body.bookingId || '').toUpperCase();
  const phoneDigits = String(body.phone || '').replace(/\D/g, '').slice(-10);

  if (!bookingIdStr || phoneDigits.length < 10) {
    return errorResponse('Booking ID and 10-digit mobile number are required', 400, origin);
  }

  const booking = await env.DB.prepare(
    `SELECT b.*, br.name AS branch_name, br.slug AS branch_slug, br.address AS branch_address,
            br.city AS branch_city, br.phone AS branch_phone, br.map_link AS branch_map_link
     FROM bookings b
     LEFT JOIN branches br ON b.branch_id = br.id
     WHERE UPPER(b.booking_id) = ?`
  ).bind(bookingIdStr).first();

  if (!booking) {
    return errorResponse('Booking ID not found or mobile number does not match', 404, origin);
  }

  const storedDigits = String(booking.patient_phone || '').replace(/\D/g, '').slice(-10);
  if (!storedDigits || storedDigits !== phoneDigits) {
    return errorResponse('Booking ID not found or mobile number does not match', 403, origin);
  }

  const payload = await buildTrackingPayload(booking, env);
  return jsonResponse(payload, 200, origin);
}

async function listBookings(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const url = new URL(request.url);
  const status = url.searchParams.get('status')?.trim() || '';
  const paymentStatus = url.searchParams.get('payment_status')?.trim() || '';
  const branchId = url.searchParams.get('branch_id')?.trim() || '';
  const appointmentType = url.searchParams.get('appointment_type')?.trim() || '';
  const date = url.searchParams.get('date')?.trim() || '';
  const dateFrom = (url.searchParams.get('date_from') || url.searchParams.get('from') || url.searchParams.get('start_date') || '').trim();
  const dateTo = (url.searchParams.get('date_to') || url.searchParams.get('to') || url.searchParams.get('end_date') || '').trim();
  const search = url.searchParams.get('search')?.trim() || '';
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 25)));
  const offset = (page - 1) * limit;

  const conditions = [];
  const params = [];

  if (status) {
    conditions.push('b.booking_status = ?');
    params.push(status);
  }
  if (paymentStatus) {
    conditions.push('b.payment_status = ?');
    params.push(paymentStatus);
  }
  if (branchId && /^\d+$/.test(branchId)) {
    conditions.push('b.branch_id = ?');
    params.push(Number(branchId));
  }
  if (appointmentType) {
    conditions.push('b.appointment_type = ?');
    params.push(appointmentType);
  }
  if (date) {
    conditions.push('b.appointment_date = ?');
    params.push(date);
  }
  if (dateFrom) {
    conditions.push('b.appointment_date >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push('b.appointment_date <= ?');
    params.push(dateTo);
  }
  if (search) {
    conditions.push('(b.booking_id LIKE ? OR b.patient_name LIKE ? OR b.patient_phone LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM bookings b ${whereClause}`
  ).bind(...params).first();

  const { results: bookings } = await env.DB.prepare(
    `SELECT b.*, br.name AS branch_name
     FROM bookings b
     LEFT JOIN branches br ON b.branch_id = br.id
     ${whereClause}
     ORDER BY b.created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();

  const total = countRow?.total || 0;
  const totalPages = Math.ceil(total / limit);

  return jsonResponse({
    bookings,
    pagination: {
      total,
      page,
      limit,
      total_pages: totalPages,
      totalPages,
    },
  }, 200, origin);
}

async function resolveBooking(idOrCode, db) {
  if (/^\d+$/.test(idOrCode)) {
    return db.prepare(
      `SELECT b.*, br.name AS branch_name
       FROM bookings b
       LEFT JOIN branches br ON b.branch_id = br.id
       WHERE b.id = ?`
    ).bind(Number(idOrCode)).first();
  }
  return db.prepare(
    `SELECT b.*, br.name AS branch_name
     FROM bookings b
     LEFT JOIN branches br ON b.branch_id = br.id
     WHERE b.booking_id = ?`
  ).bind(idOrCode).first();
}

async function getBookingDetail(idOrCode, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const booking = await resolveBooking(idOrCode, env.DB);
  if (!booking) return errorResponse('Booking not found', 404, origin);

  const [customer, itemsRes, paymentsRes, reportsRes, waRes] = await Promise.all([
    env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(booking.customer_id).first(),
    env.DB.prepare('SELECT * FROM booking_items WHERE booking_id = ?').bind(booking.id).all(),
    env.DB.prepare('SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at DESC').bind(booking.id).all(),
    env.DB.prepare('SELECT * FROM reports WHERE booking_id = ? ORDER BY created_at DESC').bind(booking.id).all(),
    env.DB.prepare('SELECT * FROM whatsapp_messages WHERE booking_id = ? ORDER BY created_at DESC').bind(booking.id).all(),
  ]);

  return jsonResponse({
    booking,
    customer,
    items: itemsRes.results,
    payments: paymentsRes.results,
    reports: reportsRes.results,
    whatsapp_messages: waRes.results,
  }, 200, origin);
}

async function updateBookingStatus(idOrCode, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const existing = await resolveBooking(idOrCode, env.DB);
  if (!existing) return errorResponse('Booking not found', 404, origin);

  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const allowedBookingStatuses = ['new', 'confirmed', 'sample_collected', 'processing', 'completed', 'cancelled'];
  const allowedPaymentStatuses = ['pending', 'qr_sent', 'paid', 'failed', 'refunded'];
  const allowedSampleStatuses = ['pending', 'collected', 'received_at_lab', 'processing', 'completed'];
  const allowedReportStatuses = ['pending', 'uploaded', 'ready', 'delivered'];

  const bookingStatus = body.booking_status !== undefined ? sanitizeString(body.booking_status) : existing.booking_status;
  const paymentStatus = body.payment_status !== undefined ? sanitizeString(body.payment_status) : existing.payment_status;
  const sampleStatus = body.sample_status !== undefined ? sanitizeString(body.sample_status) : existing.sample_status;
  const reportStatus = body.report_status !== undefined ? sanitizeString(body.report_status) : existing.report_status;

  if (!allowedBookingStatuses.includes(bookingStatus)) {
    return errorResponse(`Invalid booking_status. Allowed: ${allowedBookingStatuses.join(', ')}`, 400, origin);
  }
  if (!allowedPaymentStatuses.includes(paymentStatus)) {
    return errorResponse(`Invalid payment_status. Allowed: ${allowedPaymentStatuses.join(', ')}`, 400, origin);
  }
  if (!allowedSampleStatuses.includes(sampleStatus)) {
    return errorResponse(`Invalid sample_status. Allowed: ${allowedSampleStatuses.join(', ')}`, 400, origin);
  }
  if (!allowedReportStatuses.includes(reportStatus)) {
    return errorResponse(`Invalid report_status. Allowed: ${allowedReportStatuses.join(', ')}`, 400, origin);
  }

  await env.DB.prepare(
    `UPDATE bookings SET
      booking_status = ?, payment_status = ?, sample_status = ?, report_status = ?,
      updated_at = datetime('now')
     WHERE id = ?`
  ).bind(bookingStatus, paymentStatus, sampleStatus, reportStatus, existing.id).run();

  if (bookingStatus === 'cancelled' && existing.booking_status !== 'cancelled' && existing.slot_id) {
    await env.DB.prepare(
      'UPDATE appointment_slots SET booked_count = MAX(0, booked_count - 1) WHERE id = ?'
    ).bind(existing.slot_id).run();
  }

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, old_value, new_value, ip_address)
     VALUES (?, 'update_booking_status', 'booking', ?, ?, ?, ?)`
  ).bind(
    admin.id,
    existing.id,
    JSON.stringify({
      booking_status: existing.booking_status,
      payment_status: existing.payment_status,
      sample_status: existing.sample_status,
      report_status: existing.report_status,
    }),
    JSON.stringify({ booking_status: bookingStatus, payment_status: paymentStatus, sample_status: sampleStatus, report_status: reportStatus }),
    ip
  ).run();

  const updated = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(existing.id).first();
  return jsonResponse({ booking: updated }, 200, origin);
}

async function addBookingNote(idOrCode, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const existing = await resolveBooking(idOrCode, env.DB);
  if (!existing) return errorResponse('Booking not found', 404, origin);

  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const missing = validateRequired(body, ['note']);
  if (missing) return errorResponse('note is required', 400, origin);

  const noteText = sanitizeString(body.note);
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp} - ${admin.display_name || admin.username}]: ${noteText}`;
  const updatedNotes = existing.internal_notes ? `${existing.internal_notes}\n${entry}` : entry;

  await env.DB.prepare(
    `UPDATE bookings SET internal_notes = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(updatedNotes, existing.id).run();

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, new_value, ip_address)
     VALUES (?, 'add_booking_note', 'booking', ?, ?, ?)`
  ).bind(admin.id, existing.id, JSON.stringify({ note: noteText }), ip).run();

  return jsonResponse({ internal_notes: updatedNotes }, 200, origin);
}
