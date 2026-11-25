// =====================================================
// Ranchi Pathology — Admin Dashboard, Customers, Notifications & Audit Logs
// =====================================================

import { authMiddleware } from '../utils/auth.js';
import { jsonResponse, errorResponse } from '../utils/helpers.js';

export async function handleDashboardRoutes(request, env, path, method, origin) {
  if (path === '/api/admin/dashboard' && method === 'GET') {
    return getDashboardStats(request, env, origin);
  }
  if (path === '/api/admin/customers' && method === 'GET') {
    return listCustomers(request, env, origin);
  }
  const custMatch = path.match(/^\/api\/admin\/customers\/(\d+)$/);
  if (custMatch && method === 'GET') {
    return getCustomerDetail(custMatch[1], request, env, origin);
  }
  if (path === '/api/admin/notifications' && method === 'GET') {
    return listNotifications(request, env, origin);
  }
  const notifReadMatch = path.match(/^\/api\/admin\/notifications\/(\d+)\/read$/);
  if (notifReadMatch && method === 'PATCH') {
    return markNotificationRead(notifReadMatch[1], request, env, origin);
  }
  if (path === '/api/admin/audit-logs' && method === 'GET') {
    return listAuditLogs(request, env, origin);
  }

  return null;
}

async function getDashboardStats(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const url = new URL(request.url);
  const branchId = url.searchParams.get('branch_id')?.trim() || '';
  const dateFrom = (url.searchParams.get('date_from') || url.searchParams.get('from') || url.searchParams.get('start_date') || '').trim();
  const dateTo = (url.searchParams.get('date_to') || url.searchParams.get('to') || url.searchParams.get('end_date') || '').trim();

  const conditions = [];
  const bConditions = [];
  const params = [];

  if (branchId && /^\d+$/.test(branchId)) {
    conditions.push('branch_id = ?');
    bConditions.push('b.branch_id = ?');
    params.push(Number(branchId));
  }
  if (dateFrom) {
    conditions.push('date(created_at) >= ?');
    bConditions.push('date(b.created_at) >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push('date(created_at) <= ?');
    bConditions.push('date(b.created_at) <= ?');
    params.push(dateTo);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const andPrefix = conditions.length ? `${whereClause} AND` : 'WHERE';

  const today = new Date().toISOString().slice(0, 10);

  const [
    totalsRow,
    todayRow,
    statusRows,
    paymentRows,
    branchRows,
    trendRows,
    typeRows,
    recentBookingsRes,
    unreadNotifsRow,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT
         COUNT(*) AS total_bookings,
         COALESCE(SUM(CASE WHEN booking_status != 'cancelled' THEN total_amount ELSE 0 END), 0) AS total_billed,
         COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END), 0) AS total_revenue,
         COALESCE(SUM(CASE WHEN payment_status IN ('pending', 'qr_sent') AND booking_status != 'cancelled' THEN total_amount ELSE 0 END), 0) AS pending_revenue,
         COUNT(CASE WHEN appointment_type = 'home_collection' THEN 1 END) AS home_collections,
         COUNT(CASE WHEN booking_status IN ('new', 'confirmed') THEN 1 END) AS active_bookings,
         COUNT(CASE WHEN booking_status = 'new' THEN 1 END) AS pending_bookings,
         COUNT(CASE WHEN booking_status = 'confirmed' THEN 1 END) AS confirmed_bookings,
         COUNT(CASE WHEN booking_status = 'completed' THEN 1 END) AS completed_bookings,
         COUNT(CASE WHEN payment_status IN ('pending', 'qr_sent') AND booking_status != 'cancelled' THEN 1 END) AS pending_payments,
         COUNT(CASE WHEN payment_status = 'paid' THEN 1 END) AS verified_payments
       FROM bookings ${whereClause}`
    ).bind(...params).first(),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS today_bookings,
         COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END), 0) AS today_revenue
       FROM bookings ${andPrefix} appointment_date = ?`
    ).bind(...params, today).first(),
    env.DB.prepare(
      `SELECT booking_status, COUNT(*) AS count FROM bookings ${whereClause} GROUP BY booking_status`
    ).bind(...params).all(),
    env.DB.prepare(
      `SELECT payment_status, COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount FROM bookings ${whereClause} GROUP BY payment_status`
    ).bind(...params).all(),
    env.DB.prepare(
      `SELECT br.id, br.name, br.name AS branch_name, COUNT(b.id) AS booking_count,
              COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_amount ELSE 0 END), 0) AS revenue
       FROM branches br
       LEFT JOIN bookings b ON br.id = b.branch_id ${bConditions.length ? 'AND ' + bConditions.join(' AND ') : ''}
       WHERE br.is_active = 1
       GROUP BY br.id
       ORDER BY br.sort_order ASC`
    ).bind(...params).all(),
    env.DB.prepare(
      `SELECT date(created_at) AS date, COUNT(*) AS count,
              COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END), 0) AS revenue
       FROM bookings ${whereClause}
       GROUP BY date(created_at)
       ORDER BY date(created_at) ASC
       LIMIT 31`
    ).bind(...params).all(),
    env.DB.prepare(
      `SELECT appointment_type, COUNT(*) AS count FROM bookings ${whereClause} GROUP BY appointment_type`
    ).bind(...params).all(),
    env.DB.prepare(
      `SELECT b.id, b.booking_id, b.patient_name, b.patient_phone, b.appointment_type,
              b.appointment_date, b.appointment_time, b.total_amount, b.booking_status,
              b.payment_status, b.created_at, br.name AS branch_name
       FROM bookings b
       LEFT JOIN branches br ON b.branch_id = br.id
       ${bConditions.length ? 'WHERE ' + bConditions.join(' AND ') : ''}
       ORDER BY b.created_at DESC LIMIT 10`
    ).bind(...params).all(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM notifications WHERE is_read = 0').first(),
  ]);

  const [customerCount, pendingReports, reportsUploaded] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS count FROM customers').first(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM bookings WHERE booking_status != 'cancelled' AND report_status IN ('pending', 'uploaded')"
    ).first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM reports').first(),
  ]);

  return jsonResponse({
    summary: {
      total_bookings: totalsRow?.total_bookings || 0,
      active_bookings: totalsRow?.active_bookings || 0,
      pending_bookings: totalsRow?.pending_bookings || 0,
      confirmed_bookings: totalsRow?.confirmed_bookings || 0,
      completed_bookings: totalsRow?.completed_bookings || 0,
      pending_payments: totalsRow?.pending_payments || 0,
      verified_payments: totalsRow?.verified_payments || 0,
      home_collections: totalsRow?.home_collections || 0,
      total_billed: totalsRow?.total_billed || 0,
      total_revenue: totalsRow?.total_revenue || 0,
      pending_revenue: totalsRow?.pending_revenue || 0,
      today_bookings: todayRow?.today_bookings || 0,
      today_revenue: todayRow?.today_revenue || 0,
      total_customers: customerCount?.count || 0,
      pending_reports: pendingReports?.count || 0,
      reports_uploaded: reportsUploaded?.count || 0,
      unread_notifications: unreadNotifsRow?.count || 0,
    },
    bookings_by_status: statusRows.results,
    bookings_by_payment: paymentRows.results,
    branch_breakdown: branchRows.results,
    branch_counts: branchRows.results,
    booking_trend: trendRows.results.map(r => ({ date: r.date, count: r.count })),
    revenue_trend: trendRows.results.map(r => ({ date: r.date, revenue: r.revenue })),
    appointment_types: typeRows.results,
    recent_bookings: recentBookingsRes.results,
  }, 200, origin);
}

async function listCustomers(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const url = new URL(request.url);
  const search = url.searchParams.get('search')?.trim() || '';
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 25)));
  const offset = (page - 1) * limit;

  const conditions = [];
  const params = [];

  if (search) {
    conditions.push('(c.full_name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.city LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM customers c ${whereClause}`
  ).bind(...params).first();

  const { results: customers } = await env.DB.prepare(
    `SELECT c.*,
            COUNT(b.id) AS total_bookings,
            COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_amount ELSE 0 END), 0) AS total_spent,
            MAX(b.created_at) AS last_booking_at
     FROM customers c
     LEFT JOIN bookings b ON b.customer_id = c.id
     ${whereClause}
     GROUP BY c.id
     ORDER BY c.created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();

  return jsonResponse({
    customers,
    pagination: {
      total: countRow?.total || 0,
      page,
      limit,
      total_pages: Math.ceil((countRow?.total || 0) / limit),
    },
  }, 200, origin);
}

async function getCustomerDetail(id, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const customerId = Number(id);
  const customer = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(customerId).first();
  if (!customer) return errorResponse('Customer not found', 404, origin);

  const [bookingsRes, reportsRes] = await Promise.all([
    env.DB.prepare(
      `SELECT b.*, br.name AS branch_name
       FROM bookings b
       LEFT JOIN branches br ON b.branch_id = br.id
       WHERE b.customer_id = ?
       ORDER BY b.created_at DESC`
    ).bind(customerId).all(),
    env.DB.prepare(
      `SELECT r.*, b.booking_id AS booking_code
       FROM reports r
       LEFT JOIN bookings b ON r.booking_id = b.id
       WHERE r.customer_id = ?
       ORDER BY r.created_at DESC`
    ).bind(customerId).all(),
  ]);

  return jsonResponse({
    customer,
    bookings: bookingsRes.results,
    reports: reportsRes.results,
  }, 200, origin);
}

async function listNotifications(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const url = new URL(request.url);
  const unreadOnly = url.searchParams.get('unread') === '1';
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 30)));

  const whereClause = unreadOnly ? 'WHERE is_read = 0' : '';
  const { results: notifications } = await env.DB.prepare(
    `SELECT * FROM notifications ${whereClause} ORDER BY created_at DESC LIMIT ?`
  ).bind(limit).all();

  const unreadRow = await env.DB.prepare('SELECT COUNT(*) AS count FROM notifications WHERE is_read = 0').first();

  return jsonResponse({
    notifications,
    unread_count: unreadRow?.count || 0,
  }, 200, origin);
}

async function markNotificationRead(id, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const notifId = Number(id);
  const existing = await env.DB.prepare('SELECT id FROM notifications WHERE id = ?').bind(notifId).first();
  if (!existing) return errorResponse('Notification not found', 404, origin);

  await env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').bind(notifId).run();
  return jsonResponse({ message: 'Notification marked as read', id: notifId }, 200, origin);
}

async function listAuditLogs(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const url = new URL(request.url);
  const action = url.searchParams.get('action')?.trim() || '';
  const entityType = url.searchParams.get('entity_type')?.trim() || '';
  const adminId = url.searchParams.get('admin_id')?.trim() || '';
  const dateFrom = url.searchParams.get('date_from')?.trim() || '';
  const dateTo = url.searchParams.get('date_to')?.trim() || '';
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)));
  const offset = (page - 1) * limit;

  const conditions = [];
  const params = [];

  if (action) {
    conditions.push('l.action = ?');
    params.push(action);
  }
  if (entityType) {
    conditions.push('l.entity_type = ?');
    params.push(entityType);
  }
  if (adminId && /^\d+$/.test(adminId)) {
    conditions.push('l.admin_id = ?');
    params.push(Number(adminId));
  }
  if (dateFrom) {
    conditions.push('date(l.created_at) >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push('date(l.created_at) <= ?');
    params.push(dateTo);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM audit_logs l ${whereClause}`
  ).bind(...params).first();

  const { results: logs } = await env.DB.prepare(
    `SELECT l.*, a.username AS admin_username, a.display_name AS admin_display_name
     FROM audit_logs l
     LEFT JOIN admins a ON l.admin_id = a.id
     ${whereClause}
     ORDER BY l.created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();

  return jsonResponse({
    logs,
    pagination: {
      total: countRow?.total || 0,
      page,
      limit,
      total_pages: Math.ceil((countRow?.total || 0) / limit),
    },
  }, 200, origin);
}
