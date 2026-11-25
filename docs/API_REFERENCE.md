# Ranchi Pathology — REST API Reference

Base URL: `/api` (served via Cloudflare Pages Functions `functions/api/[[path]].js` or Cloudflare Worker `worker/index.js`).

All admin endpoints require:
```
Authorization: Bearer <JWT_TOKEN>
```

---

## 1. Public Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check & current environment (`demo` or `production`) |
| `GET` | `/api/settings/public` | Public business settings + `has_admin` / `needs_setup` flags |
| `POST` | `/api/contact` | Submit a contact inquiry (creates an admin notification) |
| `GET` | `/api/categories` | List active test categories |
| `GET` | `/api/tests` | List active tests (`?search=`, `?category=`, `?branch_id=`, `?sort=`) |
| `GET` | `/api/tests/:id` | Single test details with branch availability |
| `GET` | `/api/packages` | List active packages with included tests (`?branch_id=`) |
| `GET` | `/api/packages/:id` | Single package details with included tests & branches |
| `GET` | `/api/branches` | List active branches |
| `GET` | `/api/branches/:id` | Branch details & upcoming holidays |
| `GET` | `/api/branches/:id/slots` | Available slots for `?date=YYYY-MM-DD&type=branch_visit|home_collection` |
| `GET` | `/api/offers/active` | Active non-expired public offers |
| `POST` | `/api/offers/validate` | Server-side coupon validation (`{ code, subtotal, branch_id, items, customer_phone }`) |
| `POST` | `/api/bookings` | Create booking with atomic slot locking & server-side price snapshot |
| `GET` | `/api/bookings/track/:token` | Track booking by unguessable `tracking_token` |
| `POST` | `/api/reports/verify` | Verify `{ bookingId, phone }` to access available reports |
| `GET` | `/api/reports/download/:id?token=...` | Authenticated report download (also `GET /api/reports/:id/download`) |
| `GET` | `/api/webhooks/whatsapp` | Meta WhatsApp webhook verification (`hub.mode`, `hub.verify_token`, `hub.challenge`) |
| `POST` | `/api/webhooks/whatsapp` | Meta WhatsApp delivery/read/failed status webhook (`X-Hub-Signature-256`) |

---

## 2. Admin Authentication Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/admin/setup` | One-time initial super admin creation (disabled once any admin exists) |
| `POST` | `/api/admin/login` | Admin login (locks account for 15 min after 5 failed attempts) |
| `POST` | `/api/admin/logout` | Audit-logged logout |
| `GET` | `/api/admin/me` | Current authenticated admin profile |

---

## 3. Admin Operations & Catalog Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/admin/dashboard` | KPIs, branch counts, trend series & recent bookings (`?branch_id=`, `?date_from=`, `?date_to=`) |
| `GET` | `/api/admin/bookings` | Paginated bookings with search & filters |
| `GET` | `/api/admin/bookings/:id` | Full booking details (customer, items, payments, reports, WhatsApp logs) |
| `PATCH` | `/api/admin/bookings/:id/status` | Update booking/payment/sample/report status (frees slot on cancel) |
| `POST` | `/api/admin/bookings/:id/notes` | Append timestamped internal admin note |
| `POST` | `/api/admin/payments/:bookingId/generate-qr` | Generate booking-specific UPI QR & expire older pending QRs |
| `GET` | `/api/admin/payments/:bookingId` | Get all payment records & QR data for a booking |
| `POST` | `/api/admin/payments/:paymentId/verify` | Manually verify payment with UTR (blocks duplicate verification) |
| `GET` | `/api/admin/payments` | Paginated payment records |
| `POST` | `/api/admin/reports/upload` | Multipart R2 upload (validates PDF/JPEG/PNG magic bytes & size) |
| `GET` | `/api/admin/reports` | List uploaded reports |
| `PATCH` | `/api/admin/reports/:id` | Toggle report availability or update title |
| `POST` | `/api/admin/whatsapp/send-qr/:bookingId` | Send payment QR or `report_ready` WhatsApp notification |
| `GET` | `/api/admin/whatsapp/messages` | Paginated WhatsApp delivery log |
| `POST` | `/api/admin/tests` | Create test |
| `PUT` | `/api/admin/tests/:id` | Update test |
| `DELETE` | `/api/admin/tests/:id` | Deactivate test (`is_active = 0`) |
| `POST` | `/api/admin/categories` | Create test category |
| `PUT` | `/api/admin/categories/:id` | Update test category |
| `POST` | `/api/admin/packages` | Create health package |
| `PUT` | `/api/admin/packages/:id` | Update health package |
| `GET` | `/api/admin/offers` | List all offers |
| `POST` | `/api/admin/offers` | Create coupon/offer |
| `PUT` | `/api/admin/offers/:id` | Update coupon/offer |
| `PUT` | `/api/admin/branches/:id` | Update branch details & home collection charge settings |
| `POST` | `/api/admin/branches/:id/slots` | Create appointment slots for a branch |
| `POST` | `/api/admin/branches/:id/holidays` | Add branch holiday |
| `DELETE` | `/api/admin/branches/:id/holidays/:holidayId` | Remove branch holiday |
| `GET` | `/api/admin/customers` | Search customers |
| `GET` | `/api/admin/customers/:id` | Customer booking, payment & report history |
| `GET` | `/api/admin/notifications` | List admin notifications & unread count |
| `PATCH` | `/api/admin/notifications/:id/read` | Mark notification read |
| `GET` | `/api/admin/audit-logs` | Paginated admin audit trail |
| `GET` | `/api/admin/settings` | Read all `business_settings` |
| `PUT` | `/api/admin/settings` | Update `business_settings` |
