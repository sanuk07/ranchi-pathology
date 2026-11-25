// =====================================================
// Ranchi Pathology — WhatsApp Routes
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

export async function handleWhatsAppRoutes(request, env, path, method, origin) {
  // Webhooks (public, Meta verification + status updates)
  if (path === '/api/webhooks/whatsapp' && method === 'GET') {
    return verifyWebhook(request, env);
  }
  if (path === '/api/webhooks/whatsapp' && method === 'POST') {
    return handleWebhookEvent(request, env, origin);
  }

  // Admin routes
  const sendQrMatch = path.match(/^\/api\/admin\/whatsapp\/send-qr\/([^/]+)$/);
  if (sendQrMatch && method === 'POST') {
    return sendPaymentQR(sendQrMatch[1], request, env, origin);
  }
  if (path === '/api/admin/whatsapp/messages' && method === 'GET') {
    return listMessages(request, env, origin);
  }

  return null;
}

async function resolveBooking(idOrCode, db) {
  if (/^\d+$/.test(idOrCode)) {
    return db.prepare('SELECT * FROM bookings WHERE id = ?').bind(Number(idOrCode)).first();
  }
  return db.prepare('SELECT * FROM bookings WHERE booking_id = ?').bind(idOrCode).first();
}

function normalizeIndianPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  if (digits.startsWith('0') && digits.length === 11) return '91' + digits.slice(1);
  return digits;
}

async function sendPaymentQR(bookingIdParam, request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const booking = await resolveBooking(bookingIdParam, env.DB);
  if (!booking) return errorResponse('Booking not found', 404, origin);

  const body = (await parseBody(request)) || {};
  const messageType = sanitizeString(body.message_type || 'payment_qr');
  const retryMessageId = body.retry_message_id ? Number(body.retry_message_id) : null;
  const recipientPhone = normalizeIndianPhone(body.phone || booking.patient_phone);

  const { results: settingsRows } = await env.DB.prepare(
    "SELECT key, value FROM business_settings WHERE key IN ('upi_id', 'upi_payee_name', 'qr_validity_minutes', 'whatsapp_template_name', 'whatsapp_report_template_name', 'whatsapp_template_lang')"
  ).all();
  const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));

  let payment = null;
  let qrDataUrl = null;
  let messageText = '';
  let templateName = null;

  if (messageType === 'report_ready') {
    templateName = settings.whatsapp_report_template_name || null;
    messageText = body.message
      ? sanitizeString(body.message)
      : `Hello ${booking.patient_name}, your diagnostic report for booking ${booking.booking_id} is now ready. You can securely view and download it using your booking tracking link.`;
  } else {
    templateName = settings.whatsapp_template_name || null;
    // Check for active, non-expired payment QR
    payment = await env.DB.prepare(
      `SELECT * FROM payments WHERE booking_id = ? AND qr_status = 'active' ORDER BY created_at DESC LIMIT 1`
    ).bind(booking.id).first();

    if (payment && payment.qr_expires_at) {
      const exp = new Date(payment.qr_expires_at.replace(' ', 'T') + (payment.qr_expires_at.endsWith('Z') ? '' : 'Z'));
      if (exp < new Date()) {
        await env.DB.prepare(
          `UPDATE payments SET qr_status = 'expired', updated_at = datetime('now') WHERE id = ?`
        ).bind(payment.id).run();
        payment = null;
      }
    }

    if (!payment) {
      const upiId = settings.upi_id || env.DEFAULT_UPI_ID || '6204522977@ptyes';
      const payeeName = settings.upi_payee_name || env.DEFAULT_UPI_PAYEE || 'sanu';
      const validityMinutes = Number(settings.qr_validity_minutes || 1440);
      const amount = Number(booking.total_amount);

      const paymentRef = generatePaymentRef();
      const paymentUri = generateUPIUri(upiId, payeeName, amount, paymentRef);
      const qrExpiresAt = new Date(Date.now() + validityMinutes * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19);

      const payRes = await env.DB.prepare(
        `INSERT INTO payments (booking_id, payment_ref, amount, upi_id, payee_name, payment_uri, qr_expires_at, qr_status, payment_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'pending')`
      ).bind(booking.id, paymentRef, amount, upiId, payeeName, paymentUri, qrExpiresAt).run();

      payment = await env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(payRes.meta.last_row_id).first();
    }

    qrDataUrl = generateQRDataUrl(payment.payment_uri);
    messageText = body.message
      ? sanitizeString(body.message)
      : `Hello ${booking.patient_name}, please complete your payment of ₹${payment.amount} for booking ${booking.booking_id} using UPI ID ${payment.upi_id} (Ref: ${payment.payment_ref}). UPI Link: ${payment.payment_uri}`;
  }

  const isDemo = env.ENVIRONMENT === 'demo' || !env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID;

  let status = 'queued';
  let waMessageId = null;
  let responsePayload = {};
  let failureReason = null;
  const requestPayload = templateName
    ? {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientPhone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: settings.whatsapp_template_lang || 'en' },
        },
        payment_ref: payment?.payment_ref || null,
      }
    : {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientPhone,
        type: 'text',
        text: { preview_url: false, body: messageText },
        payment_ref: payment?.payment_ref || null,
      };

  if (isDemo) {
    // Demo mode simulation — clearly marked, does not claim live Meta delivery
    status = 'simulated';
    waMessageId = `demo_wamid_${crypto.randomUUID().slice(0, 12)}`;
    responsePayload = {
      simulated: true,
      mode: 'demo',
      note: 'WhatsApp Cloud API credentials not active or ENVIRONMENT=demo; message logged locally.',
      qr_data_url: qrDataUrl,
    };
  } else {
    const graphVersion = env.GRAPH_API_VERSION || 'v21.0';
    const endpoint = `https://graph.facebook.com/${graphVersion}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

    try {
      const apiBody = templateName
        ? {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipientPhone,
            type: 'template',
            template: {
              name: templateName,
              language: { code: settings.whatsapp_template_lang || 'en' },
              components: [
                {
                  type: 'body',
                  parameters: payment
                    ? [
                        { type: 'text', text: booking.patient_name },
                        { type: 'text', text: booking.booking_id },
                        { type: 'text', text: `₹${payment.amount}` },
                        { type: 'text', text: payment.upi_id },
                      ]
                    : [
                        { type: 'text', text: booking.patient_name },
                        { type: 'text', text: booking.booking_id },
                      ],
                },
              ],
            },
          }
        : {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipientPhone,
            type: 'text',
            text: { preview_url: false, body: messageText },
          };

      const apiRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(apiBody),
      });
      const apiJson = await apiRes.json();
      responsePayload = apiJson;
      if (apiRes.ok && apiJson.messages?.[0]?.id) {
        status = 'sent';
        waMessageId = apiJson.messages[0].id;
      } else {
        status = 'failed';
        failureReason = apiJson.error?.message || `HTTP ${apiRes.status}`;
      }
    } catch (err) {
      status = 'failed';
      failureReason = err.message || 'Network error calling Meta Graph API';
      responsePayload = { error: failureReason };
    }
  }

  let retryCount = 0;
  if (retryMessageId) {
    const prev = await env.DB.prepare('SELECT retry_count FROM whatsapp_messages WHERE id = ?').bind(retryMessageId).first();
    retryCount = (prev?.retry_count || 0) + 1;
  }

  const msgRes = await env.DB.prepare(
    `INSERT INTO whatsapp_messages (
      booking_id, customer_phone, message_type, template_name, whatsapp_message_id, status,
      sent_at, failed_at, failure_reason, retry_count, request_payload, response_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    booking.id,
    recipientPhone,
    messageType,
    templateName,
    waMessageId,
    status,
    status === 'sent' || status === 'simulated' ? new Date().toISOString() : null,
    status === 'failed' ? new Date().toISOString() : null,
    failureReason,
    retryCount,
    JSON.stringify(requestPayload),
    JSON.stringify(responsePayload)
  ).run();

  if (messageType === 'payment_qr' && (status === 'sent' || status === 'simulated')) {
    await env.DB.prepare(
      `UPDATE bookings SET payment_status = CASE WHEN payment_status = 'pending' THEN 'qr_sent' ELSE payment_status END, updated_at = datetime('now') WHERE id = ?`
    ).bind(booking.id).run();
  }

  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, new_value, ip_address)
     VALUES (?, ?, 'whatsapp_message', ?, ?, ?)`
  ).bind(
    admin.id,
    messageType === 'report_ready' ? 'send_whatsapp_report' : 'send_whatsapp_qr',
    msgRes.meta.last_row_id,
    JSON.stringify({ booking_id: booking.booking_id, message_type: messageType, status, simulated: isDemo }),
    ip
  ).run();

  const saved = await env.DB.prepare('SELECT * FROM whatsapp_messages WHERE id = ?').bind(msgRes.meta.last_row_id).first();
  return jsonResponse({
    message: saved,
    simulated: isDemo,
    qr_data_url: qrDataUrl,
    payment_uri: payment?.payment_uri || null,
  }, status === 'failed' ? 502 : 200, origin);
}

async function listMessages(request, env, origin) {
  const { admin, error } = await authMiddleware(request, env);
  if (error || !admin) return errorResponse(error || 'Unauthorized', 401, origin);

  const url = new URL(request.url);
  const bookingId = url.searchParams.get('booking_id')?.trim() || '';
  const status = url.searchParams.get('status')?.trim() || '';
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 25)));
  const offset = (page - 1) * limit;

  const conditions = [];
  const params = [];

  if (bookingId) {
    if (/^\d+$/.test(bookingId)) {
      conditions.push('w.booking_id = ?');
      params.push(Number(bookingId));
    } else {
      conditions.push('b.booking_id = ?');
      params.push(bookingId);
    }
  }
  if (status) {
    conditions.push('w.status = ?');
    params.push(status);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM whatsapp_messages w LEFT JOIN bookings b ON w.booking_id = b.id ${whereClause}`
  ).bind(...params).first();

  const { results: messages } = await env.DB.prepare(
    `SELECT w.*, b.booking_id AS booking_code, b.patient_name
     FROM whatsapp_messages w
     LEFT JOIN bookings b ON w.booking_id = b.id
     ${whereClause}
     ORDER BY w.created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();

  return jsonResponse({
    messages,
    pagination: {
      total: countRow?.total || 0,
      page,
      limit,
      total_pages: Math.ceil((countRow?.total || 0) / limit),
    },
  }, 200, origin);
}

function verifyWebhook(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  const expectedToken = env.WHATSAPP_VERIFY_TOKEN || 'ranchi_pathology_verify';
  if (mode === 'subscribe' && token === expectedToken && challenge) {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response('Forbidden', { status: 403 });
}

async function handleWebhookEvent(request, env, origin) {
  const rawText = await request.text();

  // Verify X-Hub-Signature-256 if WHATSAPP_APP_SECRET is configured
  if (env.WHATSAPP_APP_SECRET) {
    const sigHeader = request.headers.get('X-Hub-Signature-256') || '';
    if (!sigHeader.startsWith('sha256=')) {
      return errorResponse('Missing webhook signature', 401, origin);
    }
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(env.WHATSAPP_APP_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const mac = await crypto.subtle.sign('HMAC', key, enc.encode(rawText));
    const expectedSig = 'sha256=' + Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (sigHeader !== expectedSig) {
      return errorResponse('Invalid webhook signature', 401, origin);
    }
  }

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return errorResponse('Invalid JSON payload', 400, origin);
  }

  const entries = payload.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const statuses = value.statuses || [];
      for (const st of statuses) {
        const msgId = st.id || null;
        const status = st.status || null;
        const ts = st.timestamp ? new Date(Number(st.timestamp) * 1000).toISOString() : null;

        await env.DB.prepare(
          `INSERT INTO whatsapp_webhook_events (event_type, message_id, status, timestamp_str, raw_payload, processed)
           VALUES ('status_update', ?, ?, ?, ?, 1)`
        ).bind(msgId, status, st.timestamp ? String(st.timestamp) : null, JSON.stringify(st)).run();

        if (msgId && status) {
          if (status === 'delivered') {
            await env.DB.prepare(
              `UPDATE whatsapp_messages SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?), updated_at = datetime('now') WHERE whatsapp_message_id = ?`
            ).bind(ts, msgId).run();
          } else if (status === 'read') {
            await env.DB.prepare(
              `UPDATE whatsapp_messages SET status = 'read', read_at = COALESCE(read_at, ?), updated_at = datetime('now') WHERE whatsapp_message_id = ?`
            ).bind(ts, msgId).run();
          } else if (status === 'failed') {
            const reason = st.errors?.[0]?.title || st.errors?.[0]?.message || 'Delivery failed';
            await env.DB.prepare(
              `UPDATE whatsapp_messages SET status = 'failed', failed_at = COALESCE(failed_at, ?), failure_reason = ?, updated_at = datetime('now') WHERE whatsapp_message_id = ?`
            ).bind(ts, reason, msgId).run();
          } else {
            await env.DB.prepare(
              `UPDATE whatsapp_messages SET status = ?, updated_at = datetime('now') WHERE whatsapp_message_id = ?`
            ).bind(status, msgId).run();
          }
        }
      }
    }
  }

  return jsonResponse({ received: true }, 200, origin);
}
