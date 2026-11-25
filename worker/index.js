// =====================================================
// Ranchi Pathology — Cloudflare Worker Entry & Router
// =====================================================

import { corsHeaders, jsonResponse, errorResponse, setAllowedOrigin } from './utils/helpers.js';
import { handleAuthRoutes } from './routes/auth.js';
import { handleTestRoutes } from './routes/tests.js';
import { handlePackageRoutes } from './routes/packages.js';
import { handleBranchRoutes } from './routes/branches.js';
import { handleBookingRoutes } from './routes/bookings.js';
import { handlePaymentRoutes } from './routes/payments.js';
import { handleOfferRoutes } from './routes/offers.js';
import { handleReportRoutes } from './routes/reports.js';
import { handleWhatsAppRoutes } from './routes/whatsapp.js';
import { handleDashboardRoutes } from './routes/dashboard.js';
import { handleSettingsRoutes } from './routes/settings.js';

const ROUTE_HANDLERS = [
  handleAuthRoutes,
  handleTestRoutes,
  handlePackageRoutes,
  handleBranchRoutes,
  handleBookingRoutes,
  handlePaymentRoutes,
  handleOfferRoutes,
  handleReportRoutes,
  handleWhatsAppRoutes,
  handleDashboardRoutes,
  handleSettingsRoutes,
];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || null;
    setAllowedOrigin(env.ALLOWED_ORIGIN || null);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, env.ALLOWED_ORIGIN),
      });
    }

    const url = new URL(request.url);
    // Normalize trailing slash (except root '/')
    const path = url.pathname.length > 1 && url.pathname.endsWith('/')
      ? url.pathname.slice(0, -1)
      : url.pathname;
    const method = request.method.toUpperCase();

    // Serve static frontend assets for non-API requests (Cloudflare Workers + Assets)
    if (!path.startsWith('/api/') && path !== '/api') {
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
    }

    try {
      // Health check
      if (path === '/api/health' && method === 'GET') {
        return jsonResponse({
          status: 'ok',
          service: env.APP_NAME || 'Ranchi Pathology',
          environment: env.ENVIRONMENT || 'production',
          timestamp: new Date().toISOString(),
        }, 200, origin);
      }

      // Dispatch to route modules
      for (const handler of ROUTE_HANDLERS) {
        const res = await handler(request, env, path, method, origin);
        if (res) return res;
      }

      return errorResponse(`Route not found: ${method} ${path}`, 404, origin);
    } catch (err) {
      const message = env.ENVIRONMENT === 'demo'
        ? (err?.message || 'Internal server error')
        : 'An unexpected error occurred. Please try again.';
      return errorResponse(message, 500, origin);
    }
  },
};
