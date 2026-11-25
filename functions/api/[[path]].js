// =====================================================
// Ranchi Pathology — Cloudflare Pages Functions Proxy
// Forwards all /api/* requests to the Worker router
// =====================================================

import worker from '../../worker/index.js';

export async function onRequest(context) {
  return worker.fetch(context.request, context.env, context);
}
