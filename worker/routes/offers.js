// =====================================================
// Ranchi Pathology — Offer & Coupon Routes
// =====================================================

import { authMiddleware } from '../utils/auth.js';
import { jsonResponse, errorResponse, parseBody, validateRequired, sanitizeString } from '../utils/helpers.js';

export async function handleOfferRoutes(request, env, path, method, origin) {
  // Public routes
  if (path === '/api/offers/active' && method === 'GET') {
    return listActiveOffers(env, origin);
  }
  if (path === '/api/offers/validate' && method === 'POST') {
    return validateOfferEndpoint(request, env, origin);
  }

  // Admin routes
  if (path === '/api/admin/offers' && method === 'GET') {
    return listAllOffers(request, env, origin);
  }
  if (path === '/api/admin/offers' && method === 'POST') {
    return createOffer(request, env, origin);
  }
  const adminOfferMatch = path.match(/^\/api\/admin\/offers\/(\d+)$/);
  if (adminOfferMatch && method === 'PUT') {
    return updateOffer(adminOfferMatch[1], request, env, origin);
  }

  return null;
}

/**
 * Core server-side offer validation and discount computation.
 * Used by both /api/offers/validate and POST /api/bookings.
 */
export async function validateOfferForItems(db, { code, subtotal, branchId, items = [], customerPhone = null }) {
  const cleanCode = sanitizeString(code || '').toUpperCase();
  if (!cleanCode) {
    return { valid: false, error: 'Coupon code is required' };
  }

  const offer = await db.prepare('SELECT * FROM offers WHERE code = ?').bind(cleanCode).first();
  if (!offer || !offer.is_active) {
    return { valid: false, error: 'Invalid or inactive coupon code' };
  }

  const today = new Date().toISOString().slice(0, 10);
  if (offer.valid_from && today < offer.valid_from.slice(0, 10)) {
    return { valid: false, error: 'This offer is not yet active' };
  }
  if (offer.valid_until && today > offer.valid_until.slice(0, 10)) {
    return { valid: false, error: 'This coupon has expired' };
  }

  if (offer.total_usage_limit !== null && offer.times_used >= offer.total_usage_limit) {
    return { valid: false, error: 'This coupon has reached its maximum usage limit' };
  }

  // Per-customer limit check
  if (customerPhone && offer.per_customer_limit) {
    const cleanPhone = sanitizeString(customerPhone).replace(/\s+/g, '');
    const usageRow = await db.prepare(
      `SELECT COUNT(*) AS count FROM bookings
       WHERE patient_phone = ? AND coupon_code = ? AND booking_status != 'cancelled'`
    ).bind(cleanPhone, cleanCode).first();
    if (usageRow && usageRow.count >= offer.per_customer_limit) {
      return { valid: false, error: 'You have already used this coupon code the maximum allowed times' };
    }
  }

  // Branch restriction check
  if (offer.branch_ids && offer.branch_ids.trim() !== '' && branchId) {
    const allowedBranches = offer.branch_ids.split(',').map(s => s.trim()).filter(Boolean);
    if (allowedBranches.length > 0 && !allowedBranches.includes(String(branchId))) {
      return { valid: false, error: 'This coupon is not valid at the selected branch' };
    }
  }

  // Compute eligible amount based on applicable_to / applicable_ids
  let eligibleSubtotal = Number(subtotal || 0);
  if (offer.applicable_to && offer.applicable_to !== 'all' && items.length > 0) {
    const allowedIds = (offer.applicable_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    const matchingItems = items.filter(it => {
      if (offer.applicable_to === 'tests' && it.item_type !== 'test') return false;
      if (offer.applicable_to === 'packages' && it.item_type !== 'package') return false;
      if (allowedIds.length > 0 && !allowedIds.includes(String(it.item_id))) return false;
      return true;
    });
    if (matchingItems.length === 0) {
      return { valid: false, error: 'Coupon is not applicable to the selected tests/packages' };
    }
    eligibleSubtotal = matchingItems.reduce((sum, it) => sum + Number(it.total_price || 0), 0);
  }

  if (Number(subtotal || 0) < Number(offer.min_order_amount || 0)) {
    return {
      valid: false,
      error: `Minimum order amount of ₹${offer.min_order_amount} is required for this coupon`,
    };
  }

  let discountAmount = 0;
  if (offer.discount_type === 'percentage') {
    discountAmount = (eligibleSubtotal * Number(offer.discount_value)) / 100;
    if (offer.max_discount_amount !== null && offer.max_discount_amount !== undefined) {
      discountAmount = Math.min(discountAmount, Number(offer.max_discount_amount));
    }
  } else {
    // fixed / flat
    discountAmount = Number(offer.discount_value);
  }

  discountAmount = Math.max(0, Math.min(eligibleSubtotal, Math.round(discountAmount * 100) / 100));

  return {
    valid: true,
    offer,
    discount_amount: discountAmount,
  };
}

async function listActiveOffers(env, origin) {
  const today = new Date().toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT id, code, title, description, discount_type, discount_value,
            min_order_amount, max_discount_amount, applicable_to, branch_ids,
            valid_from, valid_until
     FROM offers
     WHERE is_active = 1
       AND substr(valid_from, 1, 10) <= ?
       AND substr(valid_until, 1, 10) >= ?
       AND (total_usage_limit IS NULL OR times_used < total_usage_limit)
     ORDER BY created_at DESC`
  ).bind(today, today).all();

  return jsonResponse({ offers: results }, 200, origin);
}

async function validateOfferEndpoint(request, env, origin) {
  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const missing = validateRequired(body, ['code']);
  if (missing) return errorResponse('Coupon code is required', 400, origin);

  // Calculate subtotal server-side if items are provided; otherwise fallback to explicit order_amount for preview
  let subtotal = 0;
  const resolvedItems = [];

  if (Array.isArray(body.items) && body.items.length > 0) {
    const packageTestIds = new Set();
    const pkgRecords = [];
    const testRequests = [];

    for (const reqItem of body.items) {
      const itemType = reqItem.item_type === 'package' ? 'package' : 'test';
      const itemId = Number(reqItem.item_id || reqItem.id);
      const quantity = Math.max(1, Math.min(10, Number(reqItem.quantity || 1)));
      if (!itemId || isNaN(itemId)) continue;

      if (itemType === 'package') {
        const pkg = await env.DB.prepare(
          'SELECT id, name, offer_price FROM packages WHERE id = ? AND is_active = 1'
        ).bind(itemId).first();
        if (pkg) {
          pkgRecords.push({ pkg, quantity });
          const { results: pts } = await env.DB.prepare(
            'SELECT test_id FROM package_tests WHERE package_id = ?'
          ).bind(pkg.id).all();
          for (const pt of pts) packageTestIds.add(pt.test_id);
        }
      } else {
        testRequests.push({ itemId, quantity });
      }
    }

    for (const { pkg, quantity } of pkgRecords) {
      const totalPrice = Number(pkg.offer_price) * quantity;
      subtotal += totalPrice;
      resolvedItems.push({ item_type: 'package', item_id: pkg.id, total_price: totalPrice });
    }

    for (const { itemId, quantity } of testRequests) {
      if (packageTestIds.has(itemId)) continue; // included in selected package
      const test = await env.DB.prepare(
        'SELECT id, price, discounted_price FROM tests WHERE id = ? AND is_active = 1'
      ).bind(itemId).first();
      if (test) {
        const eff = test.discounted_price !== null ? Number(test.discounted_price) : Number(test.price);
        const totalPrice = eff * quantity;
        subtotal += totalPrice;
        resolvedItems.push({ item_type: 'test', item_id: test.id, total_price: totalPrice });
      }
    }
  } else if (body.order_amount !== undefined || body.subtotal !== undefined) {
    subtotal = Math.max(0, Number(body.order_amount ?? body.subtotal ?? 0));
  }

  const result = await validateOfferForItems(env.DB, {
    code: body.code,
    subtotal,
    branchId: body.branch_id ? Number(body.branch_id) : null,
    items: resolvedItems,
    customerPhone: body.phone || body.patient_phone || null,
  });

  if (!result.valid) {
    return errorResponse(result.error, 400, origin);
  }

  return jsonResponse({
    valid: true,
    code: result.offer.code,
    title: result.offer.title,
    discount_type: result.offer.discount_type,
    discount_value: result.offer.discount_value,
    discount_amount: result.discount_amount,
    subtotal,
    final_amount: Math.max(0, Math.round((subtotal - result.discount_amount) * 100) / 100),
  }, 200, origin);
}

async function listAllOffers(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const { results } = await env.DB.prepare(
    'SELECT * FROM offers ORDER BY created_at DESC'
  ).all();

  return jsonResponse({ offers: results }, 200, origin);
}

async function createOffer(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const missing = validateRequired(body, ['code', 'title', 'discount_value', 'valid_from', 'valid_until']);
  if (missing) return errorResponse(`Missing required fields: ${missing.join(', ')}`, 400, origin);

  const code = sanitizeString(body.code).toUpperCase();
  const discountType = sanitizeString(body.discount_type || 'percentage');
  if (!['percentage', 'fixed'].includes(discountType)) {
    return errorResponse('discount_type must be percentage or fixed', 400, origin);
  }

  const discountValue = Number(body.discount_value);
  if (isNaN(discountValue) || discountValue <= 0) {
    return errorResponse('discount_value must be greater than 0', 400, origin);
  }
  if (discountType === 'percentage' && discountValue > 100) {
    return errorResponse('Percentage discount cannot exceed 100', 400, origin);
  }

  const duplicate = await env.DB.prepare('SELECT id FROM offers WHERE code = ?').bind(code).first();
  if (duplicate) return errorResponse('Offer code already exists', 409, origin);

  const res = await env.DB.prepare(
    `INSERT INTO offers (
      code, title, description, discount_type, discount_value, min_order_amount,
      max_discount_amount, applicable_to, applicable_ids, branch_ids,
      valid_from, valid_until, total_usage_limit, per_customer_limit, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    code,
    sanitizeString(body.title),
    sanitizeString(body.description || ''),
    discountType,
    discountValue,
    Number(body.min_order_amount || 0),
    body.max_discount_amount !== undefined && body.max_discount_amount !== null && body.max_discount_amount !== ''
      ? Number(body.max_discount_amount) : null,
    sanitizeString(body.applicable_to || 'all'),
    Array.isArray(body.applicable_ids) ? body.applicable_ids.join(',') : sanitizeString(body.applicable_ids || ''),
    Array.isArray(body.branch_ids) ? body.branch_ids.join(',') : sanitizeString(body.branch_ids || ''),
    sanitizeString(body.valid_from),
    sanitizeString(body.valid_until),
    body.total_usage_limit ? Number(body.total_usage_limit) : null,
    body.per_customer_limit !== undefined ? Number(body.per_customer_limit) : 1,
    body.is_active === undefined ? 1 : (body.is_active ? 1 : 0)
  ).run();

  const offerId = res.meta.last_row_id;
  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, new_value, ip_address)
     VALUES (?, 'create_offer', 'offer', ?, ?, ?)`
  ).bind(admin.id, offerId, JSON.stringify({ code, discountType, discountValue }), ip).run();

  const created = await env.DB.prepare('SELECT * FROM offers WHERE id = ?').bind(offerId).first();
  return jsonResponse({ offer: created }, 201, origin);
}

async function updateOffer(id, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const offerId = Number(id);
  const existing = await env.DB.prepare('SELECT * FROM offers WHERE id = ?').bind(offerId).first();
  if (!existing) return errorResponse('Offer not found', 404, origin);

  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const code = body.code !== undefined ? sanitizeString(body.code).toUpperCase() : existing.code;
  const discountType = body.discount_type !== undefined ? sanitizeString(body.discount_type) : existing.discount_type;
  const discountValue = body.discount_value !== undefined ? Number(body.discount_value) : existing.discount_value;

  if (!['percentage', 'fixed'].includes(discountType)) {
    return errorResponse('discount_type must be percentage or fixed', 400, origin);
  }
  if (isNaN(discountValue) || discountValue <= 0) {
    return errorResponse('discount_value must be greater than 0', 400, origin);
  }

  await env.DB.prepare(
    `UPDATE offers SET
      code = ?, title = ?, description = ?, discount_type = ?, discount_value = ?,
      min_order_amount = ?, max_discount_amount = ?, applicable_to = ?,
      applicable_ids = ?, branch_ids = ?, valid_from = ?, valid_until = ?,
      total_usage_limit = ?, per_customer_limit = ?, is_active = ?,
      updated_at = datetime('now')
     WHERE id = ?`
  ).bind(
    code,
    body.title !== undefined ? sanitizeString(body.title) : existing.title,
    body.description !== undefined ? sanitizeString(body.description) : existing.description,
    discountType,
    discountValue,
    body.min_order_amount !== undefined ? Number(body.min_order_amount) : existing.min_order_amount,
    body.max_discount_amount !== undefined
      ? (body.max_discount_amount === null || body.max_discount_amount === '' ? null : Number(body.max_discount_amount))
      : existing.max_discount_amount,
    body.applicable_to !== undefined ? sanitizeString(body.applicable_to) : existing.applicable_to,
    body.applicable_ids !== undefined
      ? (Array.isArray(body.applicable_ids) ? body.applicable_ids.join(',') : sanitizeString(body.applicable_ids))
      : existing.applicable_ids,
    body.branch_ids !== undefined
      ? (Array.isArray(body.branch_ids) ? body.branch_ids.join(',') : sanitizeString(body.branch_ids))
      : existing.branch_ids,
    body.valid_from !== undefined ? sanitizeString(body.valid_from) : existing.valid_from,
    body.valid_until !== undefined ? sanitizeString(body.valid_until) : existing.valid_until,
    body.total_usage_limit !== undefined ? (body.total_usage_limit ? Number(body.total_usage_limit) : null) : existing.total_usage_limit,
    body.per_customer_limit !== undefined ? Number(body.per_customer_limit) : existing.per_customer_limit,
    body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active,
    offerId
  ).run();

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, old_value, new_value, ip_address)
     VALUES (?, 'update_offer', 'offer', ?, ?, ?, ?)`
  ).bind(admin.id, offerId, JSON.stringify(existing), JSON.stringify(body), ip).run();

  const updated = await env.DB.prepare('SELECT * FROM offers WHERE id = ?').bind(offerId).first();
  return jsonResponse({ offer: updated }, 200, origin);
}
