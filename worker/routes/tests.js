// =====================================================
// Ranchi Pathology — Test & Category Routes
// =====================================================

import { authMiddleware } from '../utils/auth.js';
import { jsonResponse, errorResponse, parseBody, validateRequired, sanitizeString } from '../utils/helpers.js';

export async function handleTestRoutes(request, env, path, method, origin) {
  // Public routes
  if (path === '/api/tests' && method === 'GET') {
    return listTests(request, env, origin);
  }
  const testMatch = path.match(/^\/api\/tests\/(\d+)$/);
  if (testMatch && method === 'GET') {
    return getTestById(testMatch[1], env, origin);
  }
  if (path === '/api/categories' && method === 'GET') {
    return listCategories(request, env, origin);
  }

  // Admin routes
  if (path === '/api/admin/tests' && method === 'POST') {
    return createTest(request, env, origin);
  }
  const adminTestMatch = path.match(/^\/api\/admin\/tests\/(\d+)$/);
  if (adminTestMatch && method === 'PUT') {
    return updateTest(adminTestMatch[1], request, env, origin);
  }
  if (adminTestMatch && method === 'DELETE') {
    return deactivateTest(adminTestMatch[1], request, env, origin);
  }
  if (path === '/api/admin/categories' && method === 'POST') {
    return createCategory(request, env, origin);
  }
  const adminCatMatch = path.match(/^\/api\/admin\/categories\/(\d+)$/);
  if (adminCatMatch && method === 'PUT') {
    return updateCategory(adminCatMatch[1], request, env, origin);
  }

  return null;
}

async function listTests(request, env, origin) {
  const url = new URL(request.url);
  const search = url.searchParams.get('search')?.trim() || '';
  const category = url.searchParams.get('category')?.trim() || '';
  const branchId = url.searchParams.get('branch_id')?.trim() || '';
  const sort = url.searchParams.get('sort')?.trim() || 'name_asc';
  const includeInactive = url.searchParams.get('include_inactive') === '1';

  let isAdmin = false;
  if (includeInactive) {
    const { admin } = await authMiddleware(request, env);
    isAdmin = !!admin;
  }

  const conditions = [];
  const params = [];

  if (!isAdmin) {
    conditions.push('t.is_active = 1');
  }

  if (search) {
    conditions.push('(t.name LIKE ? OR t.test_code LIKE ? OR t.description LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  if (category) {
    if (/^\d+$/.test(category)) {
      conditions.push('t.category_id = ?');
      params.push(Number(category));
    } else {
      conditions.push('c.slug = ?');
      params.push(category);
    }
  }

  if (branchId && /^\d+$/.test(branchId)) {
    conditions.push('EXISTS (SELECT 1 FROM test_branches tb WHERE tb.test_id = t.id AND tb.branch_id = ?)');
    params.push(Number(branchId));
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const sortMap = {
    name_asc: 't.name ASC',
    name_desc: 't.name DESC',
    price_asc: 'COALESCE(t.discounted_price, t.price) ASC',
    price_desc: 'COALESCE(t.discounted_price, t.price) DESC',
    newest: 't.created_at DESC',
  };
  const orderBy = sortMap[sort] || 't.name ASC';

  const query = `
    SELECT t.*, c.name AS category_name, c.slug AS category_slug
    FROM tests t
    LEFT JOIN test_categories c ON t.category_id = c.id
    ${whereClause}
    ORDER BY ${orderBy}
  `;

  const { results } = await env.DB.prepare(query).bind(...params).all();

  return jsonResponse({ tests: results, count: results.length }, 200, origin);
}

async function getTestById(id, env, origin) {
  const test = await env.DB.prepare(
    `SELECT t.*, c.name AS category_name, c.slug AS category_slug
     FROM tests t
     LEFT JOIN test_categories c ON t.category_id = c.id
     WHERE t.id = ? AND t.is_active = 1`
  ).bind(Number(id)).first();

  if (!test) {
    return errorResponse('Test not found', 404, origin);
  }

  const { results: branches } = await env.DB.prepare(
    `SELECT b.id, b.name, b.slug, b.city
     FROM branches b
     INNER JOIN test_branches tb ON tb.branch_id = b.id
     WHERE tb.test_id = ? AND b.is_active = 1
     ORDER BY b.sort_order ASC`
  ).bind(Number(id)).all();

  return jsonResponse({ test: { ...test, branches } }, 200, origin);
}

async function listCategories(request, env, origin) {
  const url = new URL(request.url);
  const includeInactive = url.searchParams.get('include_inactive') === '1';

  let isAdmin = false;
  if (includeInactive) {
    const { admin } = await authMiddleware(request, env);
    isAdmin = !!admin;
  }

  const whereClause = isAdmin ? '' : 'WHERE c.is_active = 1';
  const { results } = await env.DB.prepare(
    `SELECT c.*,
            (SELECT COUNT(*) FROM tests t WHERE t.category_id = c.id AND t.is_active = 1) AS test_count
     FROM test_categories c
     ${whereClause}
     ORDER BY c.sort_order ASC, c.name ASC`
  ).all();

  return jsonResponse({ categories: results }, 200, origin);
}

async function createTest(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const missing = validateRequired(body, ['test_code', 'name', 'category_id', 'price']);
  if (missing) return errorResponse(`Missing required fields: ${missing.join(', ')}`, 400, origin);

  const testCode = sanitizeString(body.test_code).toUpperCase();
  const name = sanitizeString(body.name);
  const categoryId = Number(body.category_id);
  const price = Number(body.price);
  const discountedPrice = body.discounted_price !== undefined && body.discounted_price !== null && body.discounted_price !== ''
    ? Number(body.discounted_price)
    : null;

  if (isNaN(price) || price < 0) return errorResponse('Invalid price', 400, origin);
  if (discountedPrice !== null && (isNaN(discountedPrice) || discountedPrice < 0 || discountedPrice > price)) {
    return errorResponse('Invalid discounted price', 400, origin);
  }

  const category = await env.DB.prepare('SELECT id FROM test_categories WHERE id = ?').bind(categoryId).first();
  if (!category) return errorResponse('Category not found', 404, origin);

  const duplicate = await env.DB.prepare('SELECT id FROM tests WHERE test_code = ?').bind(testCode).first();
  if (duplicate) return errorResponse('Test code already exists', 409, origin);

  const result = await env.DB.prepare(
    `INSERT INTO tests (
      test_code, name, category_id, description, price, discounted_price,
      sample_type, preparation, fasting_required, fasting_hours,
      report_time, home_collection_available, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    testCode,
    name,
    categoryId,
    sanitizeString(body.description || ''),
    price,
    discountedPrice,
    sanitizeString(body.sample_type || 'Blood'),
    sanitizeString(body.preparation || 'No special preparation required'),
    body.fasting_required ? 1 : 0,
    body.fasting_hours ? Number(body.fasting_hours) : null,
    sanitizeString(body.report_time || '24 hours'),
    body.home_collection_available === undefined ? 1 : (body.home_collection_available ? 1 : 0),
    body.is_active === undefined ? 1 : (body.is_active ? 1 : 0)
  ).run();

  const testId = result.meta.last_row_id;

  // Link branches (either specified branch_ids or all active branches)
  if (Array.isArray(body.branch_ids) && body.branch_ids.length > 0) {
    const stmts = body.branch_ids.map(bid =>
      env.DB.prepare('INSERT OR IGNORE INTO test_branches (test_id, branch_id) VALUES (?, ?)').bind(testId, Number(bid))
    );
    await env.DB.batch(stmts);
  } else {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO test_branches (test_id, branch_id) SELECT ?, id FROM branches WHERE is_active = 1'
    ).bind(testId).run();
  }

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, new_value, ip_address)
     VALUES (?, 'create_test', 'test', ?, ?, ?)`
  ).bind(admin.id, testId, JSON.stringify({ test_code: testCode, name, price }), ip).run();

  const created = await env.DB.prepare('SELECT * FROM tests WHERE id = ?').bind(testId).first();
  return jsonResponse({ test: created }, 201, origin);
}

async function updateTest(id, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const testId = Number(id);
  const existing = await env.DB.prepare('SELECT * FROM tests WHERE id = ?').bind(testId).first();
  if (!existing) return errorResponse('Test not found', 404, origin);

  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const testCode = body.test_code !== undefined ? sanitizeString(body.test_code).toUpperCase() : existing.test_code;
  const name = body.name !== undefined ? sanitizeString(body.name) : existing.name;
  const categoryId = body.category_id !== undefined ? Number(body.category_id) : existing.category_id;
  const price = body.price !== undefined ? Number(body.price) : existing.price;
  const discountedPrice = body.discounted_price !== undefined
    ? (body.discounted_price === null || body.discounted_price === '' ? null : Number(body.discounted_price))
    : existing.discounted_price;

  if (isNaN(price) || price < 0) return errorResponse('Invalid price', 400, origin);
  if (discountedPrice !== null && (isNaN(discountedPrice) || discountedPrice < 0 || discountedPrice > price)) {
    return errorResponse('Invalid discounted price', 400, origin);
  }

  await env.DB.prepare(
    `UPDATE tests SET
      test_code = ?, name = ?, category_id = ?, description = ?, price = ?, discounted_price = ?,
      sample_type = ?, preparation = ?, fasting_required = ?, fasting_hours = ?,
      report_time = ?, home_collection_available = ?, is_active = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).bind(
    testCode,
    name,
    categoryId,
    body.description !== undefined ? sanitizeString(body.description) : existing.description,
    price,
    discountedPrice,
    body.sample_type !== undefined ? sanitizeString(body.sample_type) : existing.sample_type,
    body.preparation !== undefined ? sanitizeString(body.preparation) : existing.preparation,
    body.fasting_required !== undefined ? (body.fasting_required ? 1 : 0) : existing.fasting_required,
    body.fasting_hours !== undefined ? (body.fasting_hours ? Number(body.fasting_hours) : null) : existing.fasting_hours,
    body.report_time !== undefined ? sanitizeString(body.report_time) : existing.report_time,
    body.home_collection_available !== undefined ? (body.home_collection_available ? 1 : 0) : existing.home_collection_available,
    body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active,
    testId
  ).run();

  if (Array.isArray(body.branch_ids)) {
    const stmts = [
      env.DB.prepare('DELETE FROM test_branches WHERE test_id = ?').bind(testId),
      ...body.branch_ids.map(bid =>
        env.DB.prepare('INSERT OR IGNORE INTO test_branches (test_id, branch_id) VALUES (?, ?)').bind(testId, Number(bid))
      ),
    ];
    await env.DB.batch(stmts);
  }

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, old_value, new_value, ip_address)
     VALUES (?, 'update_test', 'test', ?, ?, ?, ?)`
  ).bind(admin.id, testId, JSON.stringify(existing), JSON.stringify(body), ip).run();

  const updated = await env.DB.prepare('SELECT * FROM tests WHERE id = ?').bind(testId).first();
  return jsonResponse({ test: updated }, 200, origin);
}

async function deactivateTest(id, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const testId = Number(id);
  const existing = await env.DB.prepare('SELECT * FROM tests WHERE id = ?').bind(testId).first();
  if (!existing) return errorResponse('Test not found', 404, origin);

  await env.DB.prepare(
    `UPDATE tests SET is_active = 0, updated_at = datetime('now') WHERE id = ?`
  ).bind(testId).run();

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, old_value, new_value, ip_address)
     VALUES (?, 'deactivate_test', 'test', ?, ?, ?, ?)`
  ).bind(admin.id, testId, JSON.stringify({ is_active: existing.is_active }), JSON.stringify({ is_active: 0 }), ip).run();

  return jsonResponse({ message: 'Test deactivated successfully', id: testId }, 200, origin);
}

async function createCategory(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const missing = validateRequired(body, ['name']);
  if (missing) return errorResponse(`Missing required fields: ${missing.join(', ')}`, 400, origin);

  const name = sanitizeString(body.name);
  const slug = sanitizeString(body.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const duplicate = await env.DB.prepare(
    'SELECT id FROM test_categories WHERE name = ? OR slug = ?'
  ).bind(name, slug).first();
  if (duplicate) return errorResponse('Category name or slug already exists', 409, origin);

  const result = await env.DB.prepare(
    `INSERT INTO test_categories (name, slug, description, icon, sort_order, is_active)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    name,
    slug,
    sanitizeString(body.description || ''),
    sanitizeString(body.icon || 'flask'),
    Number(body.sort_order || 0),
    body.is_active === undefined ? 1 : (body.is_active ? 1 : 0)
  ).run();

  const catId = result.meta.last_row_id;
  const created = await env.DB.prepare('SELECT * FROM test_categories WHERE id = ?').bind(catId).first();
  return jsonResponse({ category: created }, 201, origin);
}

async function updateCategory(id, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const catId = Number(id);
  const existing = await env.DB.prepare('SELECT * FROM test_categories WHERE id = ?').bind(catId).first();
  if (!existing) return errorResponse('Category not found', 404, origin);

  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const name = body.name !== undefined ? sanitizeString(body.name) : existing.name;
  const slug = body.slug !== undefined
    ? sanitizeString(body.slug).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    : existing.slug;

  await env.DB.prepare(
    `UPDATE test_categories SET
      name = ?, slug = ?, description = ?, icon = ?, sort_order = ?, is_active = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).bind(
    name,
    slug,
    body.description !== undefined ? sanitizeString(body.description) : existing.description,
    body.icon !== undefined ? sanitizeString(body.icon) : existing.icon,
    body.sort_order !== undefined ? Number(body.sort_order) : existing.sort_order,
    body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active,
    catId
  ).run();

  const updated = await env.DB.prepare('SELECT * FROM test_categories WHERE id = ?').bind(catId).first();
  return jsonResponse({ category: updated }, 200, origin);
}
