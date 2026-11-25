# Ranchi Pathology — Complete Setup, Deployment & Operations Guide

This guide is written in simple, step-by-step language so you can set up, test, and launch **Ranchi Pathology** even if you are new to coding or Cloudflare.

---

## 1. Prerequisites (Free Tools to Install)

1. **Node.js (LTS version)**: Download and install from [https://nodejs.org](https://nodejs.org).
2. **Cloudflare Account**: Create a free account at [https://dash.cloudflare.com](https://dash.cloudflare.com).
3. **Wrangler CLI** (Cloudflare's command-line tool): Open Command Prompt / PowerShell inside the `ranchi-pathology` folder and run:
   ```powershell
   npm install -g wrangler
   wrangler login
   ```
   A browser window will open—log in to your Cloudflare account and approve access.

---

## 2. Demo Mode Setup (Local Testing First)

Demo Mode lets you test the entire customer website and admin dashboard safely with sample tests, packages, and simulated WhatsApp messages (no real WhatsApp messages are sent).

### Step 2.1 — Create the D1 Database & R2 Bucket
Run these commands inside `c:\Users\MSI1\Documents\rancho pathlogy\ranchi-pathology`:

```powershell
wrangler d1 create ranchi-pathology-db
wrangler r2 bucket create ranchi-pathology-reports
```

Look at the output of `wrangler d1 create`. It will print a `database_id` (a UUID like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).
Open **`wrangler.toml`** and replace `YOUR_D1_DATABASE_ID` with that ID:
```toml
[[d1_databases]]
binding = "DB"
database_name = "ranchi-pathology-db"
database_id = "paste-your-actual-database-id-here"
```

### Step 2.2 — Run Database Schema & Demo Seed Locally
```powershell
wrangler d1 execute ranchi-pathology-db --local --file=database/migrations/001_schema.sql
wrangler d1 execute ranchi-pathology-db --local --file=database/seeds/demo_data.sql
```

### Step 2.3 — Create Local Secrets File (`.dev.vars`)
Create a file named **`.dev.vars`** inside `ranchi-pathology/` (never commit this file to Git):
```ini
ENVIRONMENT=demo
ADMIN_JWT_SECRET=replace-with-a-random-32-character-secret-string
```

### Step 2.4 — Start Local Server
```powershell
wrangler pages dev public --d1=DB=ranchi-pathology-db --r2=REPORTS_BUCKET=ranchi-pathology-reports
```
Open the printed local URL (usually `http://localhost:8788`):
- Customer Website: `http://localhost:8788/`
- Admin Login / Initial Setup: `http://localhost:8788/admin/login.html`

> **Important:** In Demo Mode, a yellow **Demo Mode** banner appears, and WhatsApp QR actions are logged locally as `simulated` without calling Meta servers.

---

## 3. Initial Admin Account Setup

There is **no hardcoded default admin password** and **no public signup page**.

1. After creating your database (`001_schema.sql`), visit `/admin/login.html`.
2. Because no admin account exists yet, the page automatically shows the **Initial Super Admin Setup** form (or click "First-time setup").
3. Enter your Display Name, Username, optional Email, and a strong password (minimum 8 characters).
4. Submit the form (`POST /api/admin/setup`).
5. Once the first admin is created, `/api/admin/setup` permanently locks itself and returns `403` if anyone tries to call it again.

---

## 4. UPI Configuration Guide

The initial UPI configuration defaults to:
- **UPI ID**: `6204522977@ptyes`
- **Payee Name**: `sanu`
- **Currency**: `INR`

### Where These Values Live
1. **Fallback defaults**: `wrangler.toml` (`DEFAULT_UPI_ID`, `DEFAULT_UPI_PAYEE`) and `.env.example`.
2. **Active database settings**: `business_settings` table (`upi_id`, `upi_payee_name`, `qr_validity_minutes`).
3. **Editing from Admin Dashboard**:
   - Log in to `/admin/login.html`.
   - Go to **Settings** (`/admin/settings.html`).
   - Update **UPI ID**, **UPI Payee Name**, and **QR Validity (minutes)**, then click **Save Settings**.

### How Payment Verification Works (Security Rule)
- Clicking **"Generate & Send UPI QR"** creates a booking-specific payment reference (`PAY-...`) and dynamic UPI QR with the server-calculated exact amount.
- Opening the QR or clicking "Open UPI App" **never** marks a booking as paid.
- After checking your bank/UPI app for the actual credit, open the booking or **Payments** page (`/admin/payments.html`), enter the **UTR / Transaction Reference**, and click **Verify Payment**. Duplicate verification of an already verified payment is blocked by the backend.

---

## 5. WhatsApp Business Cloud API Setup Guide

Ranchi Pathology uses the **official Meta WhatsApp Business Cloud API** (not unofficial scraping libraries).

### Step 5.1 — Meta Developer Setup
1. Create a Meta App at [https://developers.facebook.com](https://developers.facebook.com) and choose **Business** type.
2. Add the **WhatsApp** product to your app.
3. In **WhatsApp → API Setup**, collect:
   - **Phone Number ID** (`WHATSAPP_PHONE_NUMBER_ID`)
   - **WhatsApp Business Account ID** (`WHATSAPP_BUSINESS_ACCOUNT_ID`)
   - **Permanent System User Access Token** (`WHATSAPP_ACCESS_TOKEN`) from Meta Business Manager (temporary 24-hour tokens expire!).
4. In **App Settings → Basic**, copy **App Secret** (`WHATSAPP_APP_SECRET`) for webhook signature verification.
5. Choose a random string for your **Webhook Verify Token** (`WHATSAPP_VERIFY_TOKEN`, e.g., `rp_wh_2026_secret`).

### Step 5.2 — Create Approved Message Templates
In **WhatsApp Manager → Message Templates**, create and submit for approval:
1. Payment request template (e.g., `ranchi_payment_qr`) with body placeholders for Patient Name, Booking ID, Payable Amount, and UPI ID.
2. Report ready template (e.g., `ranchi_report_ready`) with body placeholders for Patient Name and Booking ID.

Once approved by Meta, enter the exact template names in **Admin → Settings** (`whatsapp_template_name`, `whatsapp_report_template_name`, `whatsapp_template_lang`).

### Step 5.3 — Configure Webhook in Meta
- **Callback URL**: `https://your-domain.com/api/webhooks/whatsapp`
- **Verify Token**: the exact `WHATSAPP_VERIFY_TOKEN` secret you set.
- Subscribe to the **`messages`** webhook field so sent/delivered/read/failed updates sync automatically to `/admin/whatsapp.html`.

---

## 6. Production Mode & Cloudflare Deployment Guide

### Step 6.1 — Apply Schema to Remote (Production) D1 Database
```powershell
wrangler d1 execute ranchi-pathology-db --remote --file=database/migrations/001_schema.sql
```
*(In production, do **not** run `demo_data.sql` unless you want the initial branch rows; instead, insert only the 3 real branches and default settings, or edit the seeded branches in Admin → Branches and remove demo tests/offers.)*

To seed only the 3 branches and production settings cleanly, run:
```powershell
wrangler d1 execute ranchi-pathology-db --remote --command="INSERT OR IGNORE INTO branches (name, slug, city, sort_order) VALUES ('Chandwa','chandwa','Chandwa',1),('Lohardaga','lohardaga','Lohardaga',2),('Ranchi','ranchi','Ranchi',3);"
```

### Step 6.2 — Switch `wrangler.toml` to Production
Edit `ranchi-pathology/wrangler.toml`:
```toml
[vars]
ENVIRONMENT = "production"
APP_NAME = "Ranchi Pathology"
TIMEZONE = "Asia/Kolkata"
CURRENCY = "INR"
DEFAULT_UPI_ID = "6204522977@ptyes"
DEFAULT_UPI_PAYEE = "sanu"
GRAPH_API_VERSION = "v21.0"
```

### Step 6.3 — Deploy to Cloudflare Pages
1. Push the `ranchi-pathology` repository to GitHub (or deploy directly with Wrangler):
   ```powershell
   wrangler pages project create ranchi-pathology --production-branch=main
   wrangler pages deploy public
   ```
   *(If deploying via GitHub integration in Cloudflare Dashboard: set **Build output directory** to `public`, **Root directory** to `ranchi-pathology` if nested.)*
2. In **Cloudflare Dashboard → Workers & Pages → ranchi-pathology → Settings → Functions**:
   - **D1 database bindings**: Variable name `DB` → select `ranchi-pathology-db`
   - **R2 bucket bindings**: Variable name `REPORTS_BUCKET` → select `ranchi-pathology-reports`
3. In **Settings → Environment variables (Production)**, add **Encrypted** variables (never put these in `public/` JS!):
   - `ENVIRONMENT` = `production`
   - `ADMIN_JWT_SECRET` = *(strong 64-char random string)*
   - `ALLOWED_ORIGIN` = `https://your-domain.com`
   - `WHATSAPP_ACCESS_TOKEN` = *(Meta permanent token)*
   - `WHATSAPP_PHONE_NUMBER_ID` = *(Meta Phone Number ID)*
   - `WHATSAPP_BUSINESS_ACCOUNT_ID` = *(Meta WABA ID)*
   - `WHATSAPP_VERIFY_TOKEN` = *(your webhook verify token)*
   - `WHATSAPP_APP_SECRET` = *(Meta App Secret)*

---

## 7. Custom Domain Connection Guide (Hostinger + Cloudflare DNS)

1. In **Cloudflare Dashboard**, click **Add a Site** and enter your domain (e.g., `ranchipathology.in`). Select the **Free** plan.
2. Cloudflare will show you **2 Cloudflare Nameservers** (e.g., `anna.ns.cloudflare.com`, `bob.ns.cloudflare.com`).
3. Log in to **Hostinger** (or your domain registrar) → **Domains → DNS / Nameservers → Change Nameservers**, and replace the existing nameservers with the 2 Cloudflare nameservers. Wait 15–60 minutes for propagation.
4. Back in **Cloudflare Dashboard → Workers & Pages → ranchi-pathology → Custom Domains**, click **Set up a custom domain**, enter `ranchipathology.in` (and `www.ranchipathology.in`), and activate.
5. In **Cloudflare SSL/TLS**, set encryption mode to **Full (strict)** and enable **Always Use HTTPS**.

---

## 8. Post-Launch Business Configuration Checklist

Once live, sign in to `/admin/login.html` and configure:
- [ ] **Branches (`/admin/branches.html`)**: Enter real addresses, phone numbers, email, opening hours, map links, and home collection charges for **Chandwa**, **Lohardaga**, and **Ranchi**.
- [ ] **Appointment Slots (`/admin/branches.html`)**: Create date/time slots and capacities for Branch Visit and Home Collection.
- [ ] **Categories, Tests & Packages (`/admin/tests.html`, `/admin/packages.html`)**: Add real test prices, fasting instructions, and turnaround times.
- [ ] **UPI & Settings (`/admin/settings.html`)**: Confirm UPI ID, Payee Name, QR validity, max report size, and template names.

---

## 9. Testing Checklist

### Customer Flow Tests
- [ ] Homepage loads categories, featured packages, and 3 branches from `/api/*`.
- [ ] Test catalogue searches, filters by category, sorts by price, and adds/removes items from cart.
- [ ] Booking flow blocks submission on holidays/weekly offs and enforces home address for home collection.
- [ ] Package + overlapping individual test in the same cart does **not** double-charge the included test.
- [ ] Two concurrent bookings for the last capacity (`max_capacity = 1`) on a slot: first succeeds (`201`), second fails (`409`).
- [ ] Coupon validation rejects expired, below-minimum, or over-limit coupons; browser cannot alter final amount.
- [ ] Tracking page (`/track-booking.html`) requires valid unguessable token; hides expired QRs.
- [ ] Reports page (`/reports.html`) denies wrong phone number and prevents downloading another patient's report.

### Admin Flow Tests
- [ ] `/admin/login.html` opens Setup only when 0 admins exist; locks out after 5 failed login attempts.
- [ ] Unauthenticated requests to `/api/admin/*` return `401`.
- [ ] Dashboard KPIs count **verified (`paid`) payments only** in `total_revenue`.
- [ ] Generating UPI QR creates a unique `payment_ref` and expires prior active pending QRs.
- [ ] Verifying the same payment twice returns `409 Conflict`.
- [ ] Report upload rejects non-PDF/JPG/PNG files or spoofed extensions (magic-byte check).
- [ ] WhatsApp Demo Mode logs `simulated` (never claims live delivery); Live Mode displays Meta errors accurately on failure.
- [ ] Audit logs record booking updates, payment verifications, report uploads/downloads, and settings changes.

---

## 10. Known Limitations

1. **QR Code Format for WhatsApp**: The built-in pure-JS QR generator produces crisp SVG QR codes (`data:image/svg+xml;base64,...`) without external dependencies for browser display and download. Meta WhatsApp Cloud API image headers require PNG/JPEG; therefore in production template sends, text/template parameters (Booking ID, Amount, UPI ID) are sent via Graph API, while the customer's tracking link displays the scannable QR and "Open UPI App" button. To attach a raster PNG QR directly in WhatsApp media upload, configure an external SVG-to-PNG renderer or pass a public PNG QR URL if needed later.
2. **Distance-Based Home Collection Fee**: Currently supports `free` and `fixed` per-branch or default charges out of the box; distance-slab calculation requires supplying branch GPS coordinates and a distance matrix API key.
3. **Local Runtime Verification**: In environments without `wrangler` / Node installed locally, runtime execution must be tested using `wrangler pages dev` or deployed to a staging Cloudflare Pages preview branch.
