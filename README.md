# Ranchi Pathology — Complete Diagnostic Platform

A full-stack, mobile-first web application for **Ranchi Pathology** serving three branches in Jharkhand, India (**Chandwa**, **Lohardaga**, and **Ranchi**). Built with HTML5, CSS3 (Glassmorphism UI), Vanilla JavaScript, Cloudflare Pages Functions / Workers, Cloudflare D1 (SQLite), and Cloudflare R2 (private medical report storage).

---

## Architecture Overview & Why Cloudflare Was Chosen

- **Frontend (`public/`)**: Static HTML5, CSS3 (`design-system.css` & `admin.css`), and modular Vanilla JavaScript (`api.js`, `ui.js`, `components.js`, `admin-common.js`) hosted on **Cloudflare Pages**.
- **Backend API (`worker/` + `functions/api/[[path]].js`)**: Serverless API router running on **Cloudflare Workers / Pages Functions**. Because `functions/api/[[path]].js` delegates directly to `worker/index.js`, deploying to Cloudflare Pages serves both the website and `/api/*` from the same domain.
- **Database (`database/migrations/001_schema.sql`)**: **Cloudflare D1** relational SQLite database with 22 normalized tables, foreign keys, indexes, and atomic slot capacity updates (`booked_count < max_capacity`).
- **Private Storage**: **Cloudflare R2** bucket (`ranchi-pathology-reports`) storing patient medical reports privately, served only through authenticated endpoints after checking file magic bytes (PDF/JPEG/PNG) and token/admin authorization.

> **Why not Google Sheets / Apps Script?**
> Concurrent slot booking requires atomic database updates to prevent double-booking, private medical reports require authenticated binary storage with magic-byte validation, and admin sessions/audit logs require proper relational integrity. Cloudflare D1 + R2 + Pages/Workers provides all of this within Cloudflare's generous free tier.

---

## Project Structure

```
/ranchi-pathology
├── .env.example                 # Template for secret & environment variables
├── .gitignore
├── wrangler.toml                # Cloudflare Worker / D1 / R2 configuration
├── README.md                    # Project overview & quickstart
├── docs/
│   ├── SETUP_AND_DEPLOYMENT.md  # Beginner step-by-step setup, Cloudflare, Domain, WhatsApp, UPI & Testing guide
│   └── API_REFERENCE.md         # Complete REST API documentation
├── database/
│   ├── migrations/
│   │   └── 001_schema.sql       # Full 22-table database schema
│   └── seeds/
│       └── demo_data.sql        # Demo branches, categories, tests, packages & offer
├── functions/
│   └── api/
│       └── [[path]].js          # Cloudflare Pages Functions proxy to worker/index.js
├── worker/
│   ├── index.js                 # Worker entry point & route dispatcher
│   ├── utils/
│   │   ├── auth.js              # Web Crypto PBKDF2 password hashing & HMAC-SHA256 JWT
│   │   └── helpers.js           # ID/token generators, UPI URI, pure-JS SVG QR encoder, CORS & security headers
│   └── routes/
│       ├── auth.js              # Admin setup, login (rate-limited), logout, profile
│       ├── tests.js             # Test catalogue & category CRUD
│       ├── packages.js          # Health packages CRUD
│       ├── branches.js          # Branches, appointment slots & holidays
│       ├── bookings.js          # Booking wizard API, atomic slot locking, tracking
│       ├── payments.js          # Dynamic UPI QR generation & manual UTR verification
│       ├── offers.js            # Coupon creation & server-side validation
│       ├── reports.js           # Private R2 report upload, identity verification & download
│       ├── whatsapp.js          # Meta WhatsApp Cloud API integration & webhook handler
│       ├── dashboard.js         # Admin KPIs, charts data, customers, notifications & audit logs
│       └── settings.js          # Public & admin business settings + contact inquiry form
└── public/
    ├── index.html               # Customer homepage
    ├── tests.html               # Searchable/filterable test catalogue + cart
    ├── packages.html            # Health packages
    ├── offers.html              # Active coupon offers
    ├── booking.html             # Multi-step appointment booking wizard
    ├── track-booking.html       # Token-based live booking tracker & UPI QR view
    ├── reports.html             # Verified patient report portal
    ├── about.html               # About Ranchi Pathology
    ├── contact.html             # Branch details & contact form
    ├── privacy.html             # Privacy policy
    ├── terms.html               # Terms, Cancellation/Refund Policy & FAQ
    ├── robots.txt
    ├── sitemap.xml
    ├── assets/
    │   ├── css/
    │   │   ├── design-system.css
    │   │   └── admin.css
    │   └── js/
    │       ├── api.js
    │       ├── ui.js
    │       ├── components.js
    │       └── admin/
    │           └── admin-common.js
    └── admin/
        ├── index.html           # Redirects to dashboard
        ├── login.html           # Admin login & first-time setup
        ├── dashboard.html       # Real-time KPIs & Canvas charts
        ├── bookings.html        # Full booking lifecycle management
        ├── tests.html           # Test & category management
        ├── packages.html        # Package management
        ├── offers.html          # Coupon & offer management
        ├── branches.html        # Branch details, slots & holidays
        ├── customers.html       # Customer directory & history
        ├── payments.html        # UPI QR & manual UTR verification
        ├── reports.html         # R2 report upload, replace & WhatsApp notify
        ├── whatsapp.html        # WhatsApp delivery logs & retry
        ├── settings.html        # Business, UPI, booking & integration settings
        └── audit-logs.html      # Admin action audit trail
```

---

## Quick Start (Beginner Friendly)

Read the full step-by-step guide in [`docs/SETUP_AND_DEPLOYMENT.md`](docs/SETUP_AND_DEPLOYMENT.md) for detailed instructions on:
1. Running in **Demo Mode** locally
2. Creating the **Cloudflare D1** database and **R2** bucket
3. Setting **Production Secrets** (`ADMIN_JWT_SECRET`, Meta WhatsApp credentials)
4. Creating your **Initial Admin Account**
5. Connecting a **Custom Domain** (e.g., from Hostinger) via Cloudflare DNS
6. Configuring **UPI** (`6204522977@ptyes` / `sanu`) and **WhatsApp Cloud API**
7. Complete **Testing Checklist** and **Known Limitations**
