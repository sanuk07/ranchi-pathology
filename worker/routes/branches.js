// =====================================================
// Ranchi Pathology — Branch, Slot & Holiday Routes
// =====================================================

import { authMiddleware } from '../utils/auth.js';
import { jsonResponse, errorResponse, parseBody, validateRequired, sanitizeString } from '../utils/helpers.js';

export async function handleBranchRoutes(request, env, path, method, origin) {
  if (path === '/api/branches' && method === 'GET') {
    return listBranches(request, env, origin);
  }
  const branchMatch = path.match(/^\/api\/branches\/(\d+)$/);
  if (branchMatch && method === 'GET') {
    return getBranchById(branchMatch[1], env, origin);
  }
  const slotsGetMatch = path.match(/^\/api\/branches\/(\d+)\/slots$/);
  if (slotsGetMatch && method === 'GET') {
    return getBranchSlots(slotsGetMatch[1], request, env, origin);
  }

  // Admin routes
  const adminBranchMatch = path.match(/^\/api\/admin\/branches\/(\d+)$/);
  if (adminBranchMatch && method === 'PUT') {
    return updateBranch(adminBranchMatch[1], request, env, origin);
  }
  const adminSlotsMatch = path.match(/^\/api\/admin\/branches\/(\d+)\/slots$/);
  if (adminSlotsMatch && method === 'POST') {
    return createBranchSlots(adminSlotsMatch[1], request, env, origin);
  }
  const adminHolidaysMatch = path.match(/^\/api\/admin\/branches\/(\d+)\/holidays$/);
  if (adminHolidaysMatch && method === 'POST') {
    return addBranchHoliday(adminHolidaysMatch[1], request, env, origin);
  }
  const adminHolidayDelMatch = path.match(/^\/api\/admin\/branches\/(\d+)\/holidays\/(\d+)$/);
  if (adminHolidayDelMatch && method === 'DELETE') {
    return deleteBranchHoliday(adminHolidayDelMatch[1], adminHolidayDelMatch[2], request, env, origin);
  }

  return null;
}

async function listBranches(request, env, origin) {
  const url = new URL(request.url);
  const includeInactive = url.searchParams.get('include_inactive') === '1';

  let isAdmin = false;
  if (includeInactive) {
    const { admin } = await authMiddleware(request, env);
    isAdmin = !!admin;
  }

  const whereClause = isAdmin ? '' : 'WHERE is_active = 1';
  const { results } = await env.DB.prepare(
    `SELECT * FROM branches ${whereClause} ORDER BY sort_order ASC, id ASC`
  ).all();

  return jsonResponse({ branches: results }, 200, origin);
}

async function getBranchById(id, env, origin) {
  const branchId = Number(id);
  const branch = await env.DB.prepare(
    'SELECT * FROM branches WHERE id = ? AND is_active = 1'
  ).bind(branchId).first();

  if (!branch) return errorResponse('Branch not found', 404, origin);

  const { results: holidays } = await env.DB.prepare(
    `SELECT id, holiday_date, reason FROM branch_holidays
     WHERE branch_id = ? AND holiday_date >= date('now')
     ORDER BY holiday_date ASC`
  ).bind(branchId).all();

  return jsonResponse({ branch: { ...branch, upcoming_holidays: holidays } }, 200, origin);
}

async function updateBranch(id, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const branchId = Number(id);
  const existing = await env.DB.prepare('SELECT * FROM branches WHERE id = ?').bind(branchId).first();
  if (!existing) return errorResponse('Branch not found', 404, origin);

  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const chargeType = body.home_collection_charge_type !== undefined
    ? sanitizeString(body.home_collection_charge_type)
    : existing.home_collection_charge_type;
  const chargeAmount = body.home_collection_charge_amount !== undefined
    ? Number(body.home_collection_charge_amount)
    : existing.home_collection_charge_amount;

  if (isNaN(chargeAmount) || chargeAmount < 0) {
    return errorResponse('Invalid home collection charge amount', 400, origin);
  }

  await env.DB.prepare(
    `UPDATE branches SET
      name = ?, address = ?, city = ?, state = ?, pincode = ?, phone = ?, email = ?,
      map_link = ?, opening_time = ?, closing_time = ?, weekly_off = ?,
      home_collection_available = ?, home_collection_charge_type = ?,
      home_collection_charge_amount = ?, is_active = ?, sort_order = ?,
      updated_at = datetime('now')
     WHERE id = ?`
  ).bind(
    body.name !== undefined ? sanitizeString(body.name) : existing.name,
    body.address !== undefined ? sanitizeString(body.address) : existing.address,
    body.city !== undefined ? sanitizeString(body.city) : existing.city,
    body.state !== undefined ? sanitizeString(body.state) : existing.state,
    body.pincode !== undefined ? sanitizeString(body.pincode) : existing.pincode,
    body.phone !== undefined ? sanitizeString(body.phone) : existing.phone,
    body.email !== undefined ? sanitizeString(body.email) : existing.email,
    body.map_link !== undefined ? sanitizeString(body.map_link) : existing.map_link,
    body.opening_time !== undefined ? sanitizeString(body.opening_time) : existing.opening_time,
    body.closing_time !== undefined ? sanitizeString(body.closing_time) : existing.closing_time,
    body.weekly_off !== undefined ? sanitizeString(body.weekly_off) : existing.weekly_off,
    body.home_collection_available !== undefined ? (body.home_collection_available ? 1 : 0) : existing.home_collection_available,
    chargeType,
    chargeAmount,
    body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active,
    body.sort_order !== undefined ? Number(body.sort_order) : existing.sort_order,
    branchId
  ).run();

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, old_value, new_value, ip_address)
     VALUES (?, 'update_branch', 'branch', ?, ?, ?, ?)`
  ).bind(admin.id, branchId, JSON.stringify(existing), JSON.stringify(body), ip).run();

  const updated = await env.DB.prepare('SELECT * FROM branches WHERE id = ?').bind(branchId).first();
  return jsonResponse({ branch: updated }, 200, origin);
}

async function getBranchSlots(id, request, env, origin) {
  const branchId = Number(id);
  const url = new URL(request.url);
  const date = url.searchParams.get('date')?.trim();
  const slotType = url.searchParams.get('type')?.trim() || url.searchParams.get('slot_type')?.trim();

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return errorResponse('Valid date query parameter (YYYY-MM-DD) is required', 400, origin);
  }

  const branch = await env.DB.prepare(
    'SELECT id, name, weekly_off, is_active FROM branches WHERE id = ? AND is_active = 1'
  ).bind(branchId).first();
  if (!branch) return errorResponse('Branch not found', 404, origin);

  // Check holiday
  const holiday = await env.DB.prepare(
    'SELECT id, reason FROM branch_holidays WHERE branch_id = ? AND holiday_date = ?'
  ).bind(branchId, date).first();

  if (holiday) {
    return jsonResponse({
      branch_id: branchId,
      date,
      is_holiday: true,
      holiday_reason: holiday.reason,
      slots: [],
    }, 200, origin);
  }

  // Check weekly_off (e.g. "Sunday" or "0")
  if (branch.weekly_off) {
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayOfWeek = new Date(date + 'T00:00:00Z').getUTCDay();
    const offList = branch.weekly_off.toLowerCase().split(',').map(s => s.trim());
    if (offList.includes(dayNames[dayOfWeek]) || offList.includes(String(dayOfWeek))) {
      return jsonResponse({
        branch_id: branchId,
        date,
        is_holiday: true,
        holiday_reason: 'Weekly off',
        slots: [],
      }, 200, origin);
    }
  }

  const params = [branchId, date];
  let typeCondition = '';
  if (slotType) {
    typeCondition = 'AND slot_type = ?';
    params.push(slotType);
  }

  const { results: slots } = await env.DB.prepare(
    `SELECT id, branch_id, slot_type, slot_date, start_time, end_time, max_capacity, booked_count,
            (max_capacity - booked_count) AS available_spots
     FROM appointment_slots
     WHERE branch_id = ? AND slot_date = ? AND is_active = 1 ${typeCondition}
     ORDER BY start_time ASC`
  ).bind(...params).all();

  return jsonResponse({
    branch_id: branchId,
    date,
    is_holiday: false,
    slots: slots.map(s => ({ ...s, is_available: s.available_spots > 0 })),
  }, 200, origin);
}

async function createBranchSlots(id, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const branchId = Number(id);
  const branch = await env.DB.prepare('SELECT id FROM branches WHERE id = ?').bind(branchId).first();
  if (!branch) return errorResponse('Branch not found', 404, origin);

  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const slotsInput = Array.isArray(body.slots) ? body.slots : [body];
  if (slotsInput.length === 0) return errorResponse('At least one slot is required', 400, origin);

  const stmts = [];
  for (const s of slotsInput) {
    const missing = validateRequired(s, ['slot_date', 'start_time', 'end_time']);
    if (missing) {
      return errorResponse(`Missing required slot fields: ${missing.join(', ')}`, 400, origin);
    }
    const slotType = sanitizeString(s.slot_type || 'branch_visit');
    const maxCap = s.max_capacity !== undefined ? Number(s.max_capacity) : 5;
    if (isNaN(maxCap) || maxCap < 1) {
      return errorResponse('Invalid max_capacity', 400, origin);
    }

    stmts.push(
      env.DB.prepare(
        `INSERT INTO appointment_slots (branch_id, slot_type, slot_date, start_time, end_time, max_capacity, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        branchId,
        slotType,
        sanitizeString(s.slot_date),
        sanitizeString(s.start_time),
        sanitizeString(s.end_time),
        maxCap,
        s.is_active === undefined ? 1 : (s.is_active ? 1 : 0)
      )
    );
  }

  await env.DB.batch(stmts);

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, new_value, ip_address)
     VALUES (?, 'create_slots', 'branch', ?, ?, ?)`
  ).bind(admin.id, branchId, JSON.stringify({ count: slotsInput.length }), ip).run();

  return jsonResponse({ message: `${slotsInput.length} slot(s) created`, count: slotsInput.length }, 201, origin);
}

async function addBranchHoliday(id, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const branchId = Number(id);
  const branch = await env.DB.prepare('SELECT id FROM branches WHERE id = ?').bind(branchId).first();
  if (!branch) return errorResponse('Branch not found', 404, origin);

  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const missing = validateRequired(body, ['holiday_date']);
  if (missing) return errorResponse(`Missing required fields: ${missing.join(', ')}`, 400, origin);

  const holidayDate = sanitizeString(body.holiday_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(holidayDate)) {
    return errorResponse('holiday_date must be YYYY-MM-DD', 400, origin);
  }
  const reason = sanitizeString(body.reason || 'Branch Holiday');

  await env.DB.prepare(
    `INSERT INTO branch_holidays (branch_id, holiday_date, reason)
     VALUES (?, ?, ?)
     ON CONFLICT(branch_id, holiday_date) DO UPDATE SET reason = excluded.reason`
  ).bind(branchId, holidayDate, reason).run();

  const holiday = await env.DB.prepare(
    'SELECT * FROM branch_holidays WHERE branch_id = ? AND holiday_date = ?'
  ).bind(branchId, holidayDate).first();

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, new_value, ip_address)
     VALUES (?, 'add_holiday', 'branch', ?, ?, ?)`
  ).bind(admin.id, branchId, JSON.stringify(holiday), ip).run();

  return jsonResponse({ holiday }, 201, origin);
}

async function deleteBranchHoliday(branchIdParam, holidayIdParam, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const branchId = Number(branchIdParam);
  const holidayId = Number(holidayIdParam);
  const existing = await env.DB.prepare(
    'SELECT * FROM branch_holidays WHERE id = ? AND branch_id = ?'
  ).bind(holidayId, branchId).first();
  if (!existing) return errorResponse('Holiday not found', 404, origin);

  await env.DB.prepare('DELETE FROM branch_holidays WHERE id = ?').bind(holidayId).run();

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, old_value, ip_address)
     VALUES (?, 'delete_holiday', 'branch', ?, ?, ?)`
  ).bind(admin.id, branchId, JSON.stringify(existing), ip).run();

  return jsonResponse({ message: 'Holiday deleted' }, 200, origin);
}
