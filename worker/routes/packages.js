// =====================================================
// Ranchi Pathology — Package Routes
// =====================================================

import { authMiddleware } from '../utils/auth.js';
import { jsonResponse, errorResponse, parseBody, validateRequired, sanitizeString } from '../utils/helpers.js';

export async function handlePackageRoutes(request, env, path, method, origin) {
  if (path === '/api/packages' && method === 'GET') {
    return listPackages(request, env, origin);
  }
  const pkgMatch = path.match(/^\/api\/packages\/(\d+)$/);
  if (pkgMatch && method === 'GET') {
    return getPackageById(pkgMatch[1], env, origin);
  }
  if (path === '/api/admin/packages' && method === 'POST') {
    return createPackage(request, env, origin);
  }
  const adminPkgMatch = path.match(/^\/api\/admin\/packages\/(\d+)$/);
  if (adminPkgMatch && method === 'PUT') {
    return updatePackage(adminPkgMatch[1], request, env, origin);
  }
  return null;
}

async function listPackages(request, env, origin) {
  const url = new URL(request.url);
  const branchId = url.searchParams.get('branch_id')?.trim() || '';
  const includeInactive = url.searchParams.get('include_inactive') === '1';

  let isAdmin = false;
  if (includeInactive) {
    const { admin } = await authMiddleware(request, env);
    isAdmin = !!admin;
  }

  const conditions = [];
  const params = [];

  if (!isAdmin) {
    conditions.push('p.is_active = 1');
  }
  if (branchId && /^\d+$/.test(branchId)) {
    conditions.push('EXISTS (SELECT 1 FROM package_branches pb WHERE pb.package_id = p.id AND pb.branch_id = ?)');
    params.push(Number(branchId));
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { results: packages } = await env.DB.prepare(
    `SELECT p.* FROM packages p ${whereClause} ORDER BY p.sort_order ASC, p.id ASC`
  ).bind(...params).all();

  if (packages.length === 0) {
    return jsonResponse({ packages: [] }, 200, origin);
  }

  // Fetch included tests for all returned packages
  const pkgIds = packages.map(p => p.id);
  const placeholders = pkgIds.map(() => '?').join(',');
  const { results: pkgTests } = await env.DB.prepare(
    `SELECT pt.package_id, t.id, t.test_code, t.name, t.price, t.discounted_price, t.sample_type, t.report_time
     FROM package_tests pt
     INNER JOIN tests t ON pt.test_id = t.id
     WHERE pt.package_id IN (${placeholders})
     ORDER BY t.name ASC`
  ).bind(...pkgIds).all();

  const testsByPkg = new Map();
  for (const row of pkgTests) {
    if (!testsByPkg.has(row.package_id)) testsByPkg.set(row.package_id, []);
    const { package_id, ...test } = row;
    testsByPkg.get(row.package_id).push(test);
  }

  const enriched = packages.map(p => ({
    ...p,
    tests: testsByPkg.get(p.id) || [],
    test_count: (testsByPkg.get(p.id) || []).length,
  }));

  return jsonResponse({ packages: enriched }, 200, origin);
}

async function getPackageById(id, env, origin) {
  const pkg = await env.DB.prepare(
    'SELECT * FROM packages WHERE id = ? AND is_active = 1'
  ).bind(Number(id)).first();

  if (!pkg) return errorResponse('Package not found', 404, origin);

  const { results: tests } = await env.DB.prepare(
    `SELECT t.id, t.test_code, t.name, t.description, t.price, t.discounted_price,
            t.sample_type, t.preparation, t.fasting_required, t.fasting_hours, t.report_time
     FROM package_tests pt
     INNER JOIN tests t ON pt.test_id = t.id
     WHERE pt.package_id = ? AND t.is_active = 1
     ORDER BY t.name ASC`
  ).bind(pkg.id).all();

  const { results: branches } = await env.DB.prepare(
    `SELECT b.id, b.name, b.slug, b.city
     FROM package_branches pb
     INNER JOIN branches b ON pb.branch_id = b.id
     WHERE pb.package_id = ? AND b.is_active = 1
     ORDER BY b.sort_order ASC`
  ).bind(pkg.id).all();

  return jsonResponse({ package: { ...pkg, tests, branches } }, 200, origin);
}

async function createPackage(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const missing = validateRequired(body, ['name', 'original_price', 'offer_price']);
  if (missing) return errorResponse(`Missing required fields: ${missing.join(', ')}`, 400, origin);

  const name = sanitizeString(body.name);
  const slug = sanitizeString(body.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const originalPrice = Number(body.original_price);
  const offerPrice = Number(body.offer_price);

  if (isNaN(originalPrice) || originalPrice < 0 || isNaN(offerPrice) || offerPrice < 0 || offerPrice > originalPrice) {
    return errorResponse('Invalid package pricing', 400, origin);
  }

  const discountPercent = body.discount_percent !== undefined
    ? Number(body.discount_percent)
    : (originalPrice > 0 ? Math.round(((originalPrice - offerPrice) / originalPrice) * 100) : 0);

  const duplicate = await env.DB.prepare('SELECT id FROM packages WHERE slug = ?').bind(slug).first();
  if (duplicate) return errorResponse('Package slug already exists', 409, origin);

  const result = await env.DB.prepare(
    `INSERT INTO packages (
      name, slug, description, image_url, original_price, offer_price,
      discount_percent, home_collection_available, validity_days, is_active, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    name,
    slug,
    sanitizeString(body.description || ''),
    body.image_url ? sanitizeString(body.image_url) : null,
    originalPrice,
    offerPrice,
    discountPercent,
    body.home_collection_available === undefined ? 1 : (body.home_collection_available ? 1 : 0),
    body.validity_days ? Number(body.validity_days) : null,
    body.is_active === undefined ? 1 : (body.is_active ? 1 : 0),
    Number(body.sort_order || 0)
  ).run();

  const packageId = result.meta.last_row_id;

  if (Array.isArray(body.test_ids) && body.test_ids.length > 0) {
    const stmts = body.test_ids.map(tid =>
      env.DB.prepare('INSERT OR IGNORE INTO package_tests (package_id, test_id) VALUES (?, ?)').bind(packageId, Number(tid))
    );
    await env.DB.batch(stmts);
  }

  if (Array.isArray(body.branch_ids) && body.branch_ids.length > 0) {
    const stmts = body.branch_ids.map(bid =>
      env.DB.prepare('INSERT OR IGNORE INTO package_branches (package_id, branch_id) VALUES (?, ?)').bind(packageId, Number(bid))
    );
    await env.DB.batch(stmts);
  } else {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO package_branches (package_id, branch_id) SELECT ?, id FROM branches WHERE is_active = 1'
    ).bind(packageId).run();
  }

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, new_value, ip_address)
     VALUES (?, 'create_package', 'package', ?, ?, ?)`
  ).bind(admin.id, packageId, JSON.stringify({ name, offer_price: offerPrice }), ip).run();

  const created = await env.DB.prepare('SELECT * FROM packages WHERE id = ?').bind(packageId).first();
  return jsonResponse({ package: created }, 201, origin);
}

async function updatePackage(id, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const packageId = Number(id);
  const existing = await env.DB.prepare('SELECT * FROM packages WHERE id = ?').bind(packageId).first();
  if (!existing) return errorResponse('Package not found', 404, origin);

  const body = await parseBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400, origin);

  const name = body.name !== undefined ? sanitizeString(body.name) : existing.name;
  const slug = body.slug !== undefined
    ? sanitizeString(body.slug).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    : existing.slug;
  const originalPrice = body.original_price !== undefined ? Number(body.original_price) : existing.original_price;
  const offerPrice = body.offer_price !== undefined ? Number(body.offer_price) : existing.offer_price;

  if (isNaN(originalPrice) || originalPrice < 0 || isNaN(offerPrice) || offerPrice < 0 || offerPrice > originalPrice) {
    return errorResponse('Invalid package pricing', 400, origin);
  }

  const discountPercent = body.discount_percent !== undefined
    ? Number(body.discount_percent)
    : (originalPrice > 0 ? Math.round(((originalPrice - offerPrice) / originalPrice) * 100) : 0);

  await env.DB.prepare(
    `UPDATE packages SET
      name = ?, slug = ?, description = ?, image_url = ?, original_price = ?, offer_price = ?,
      discount_percent = ?, home_collection_available = ?, validity_days = ?, is_active = ?,
      sort_order = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).bind(
    name,
    slug,
    body.description !== undefined ? sanitizeString(body.description) : existing.description,
    body.image_url !== undefined ? (body.image_url ? sanitizeString(body.image_url) : null) : existing.image_url,
    originalPrice,
    offerPrice,
    discountPercent,
    body.home_collection_available !== undefined ? (body.home_collection_available ? 1 : 0) : existing.home_collection_available,
    body.validity_days !== undefined ? (body.validity_days ? Number(body.validity_days) : null) : existing.validity_days,
    body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active,
    body.sort_order !== undefined ? Number(body.sort_order) : existing.sort_order,
    packageId
  ).run();

  if (Array.isArray(body.test_ids)) {
    const stmts = [
      env.DB.prepare('DELETE FROM package_tests WHERE package_id = ?').bind(packageId),
      ...body.test_ids.map(tid =>
        env.DB.prepare('INSERT OR IGNORE INTO package_tests (package_id, test_id) VALUES (?, ?)').bind(packageId, Number(tid))
      ),
    ];
    await env.DB.batch(stmts);
  }

  if (Array.isArray(body.branch_ids)) {
    const stmts = [
      env.DB.prepare('DELETE FROM package_branches WHERE package_id = ?').bind(packageId),
      ...body.branch_ids.map(bid =>
        env.DB.prepare('INSERT OR IGNORE INTO package_branches (package_id, branch_id) VALUES (?, ?)').bind(packageId, Number(bid))
      ),
    ];
    await env.DB.batch(stmts);
  }

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, old_value, new_value, ip_address)
     VALUES (?, 'update_package', 'package', ?, ?, ?, ?)`
  ).bind(admin.id, packageId, JSON.stringify(existing), JSON.stringify(body), ip).run();

  const updated = await env.DB.prepare('SELECT * FROM packages WHERE id = ?').bind(packageId).first();
  return jsonResponse({ package: updated }, 200, origin);
}
