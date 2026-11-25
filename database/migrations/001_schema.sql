-- =====================================================
-- Ranchi Pathology — Database Schema
-- Cloudflare D1 (SQLite-compatible)
-- =====================================================

-- ─── Admins ───
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT 'Admin',
  email TEXT,
  role TEXT NOT NULL DEFAULT 'super_admin',
  is_active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Branches ───
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL DEFAULT 'Address not yet configured',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'Jharkhand',
  pincode TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT 'Not yet configured',
  email TEXT NOT NULL DEFAULT '',
  map_link TEXT NOT NULL DEFAULT '',
  opening_time TEXT NOT NULL DEFAULT '08:00',
  closing_time TEXT NOT NULL DEFAULT '20:00',
  weekly_off TEXT NOT NULL DEFAULT '',
  home_collection_available INTEGER NOT NULL DEFAULT 1,
  home_collection_charge_type TEXT NOT NULL DEFAULT 'free',
  home_collection_charge_amount REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Test Categories ───
CREATE TABLE IF NOT EXISTS test_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT 'flask',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Tests ───
CREATE TABLE IF NOT EXISTS tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category_id INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL,
  discounted_price REAL,
  sample_type TEXT NOT NULL DEFAULT 'Blood',
  preparation TEXT NOT NULL DEFAULT 'No special preparation required',
  fasting_required INTEGER NOT NULL DEFAULT 0,
  fasting_hours INTEGER,
  report_time TEXT NOT NULL DEFAULT '24 hours',
  home_collection_available INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (category_id) REFERENCES test_categories(id)
);
CREATE INDEX IF NOT EXISTS idx_tests_category ON tests(category_id);
CREATE INDEX IF NOT EXISTS idx_tests_active ON tests(is_active);

-- ─── Test Branch Availability ───
CREATE TABLE IF NOT EXISTS test_branches (
  test_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  PRIMARY KEY (test_id, branch_id),
  FOREIGN KEY (test_id) REFERENCES tests(id),
  FOREIGN KEY (branch_id) REFERENCES branches(id)
);

-- ─── Packages ───
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  original_price REAL NOT NULL,
  offer_price REAL NOT NULL,
  discount_percent REAL,
  home_collection_available INTEGER NOT NULL DEFAULT 1,
  validity_days INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Package Tests ───
CREATE TABLE IF NOT EXISTS package_tests (
  package_id INTEGER NOT NULL,
  test_id INTEGER NOT NULL,
  PRIMARY KEY (package_id, test_id),
  FOREIGN KEY (package_id) REFERENCES packages(id),
  FOREIGN KEY (test_id) REFERENCES tests(id)
);

-- ─── Package Branch Availability ───
CREATE TABLE IF NOT EXISTS package_branches (
  package_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  PRIMARY KEY (package_id, branch_id),
  FOREIGN KEY (package_id) REFERENCES packages(id),
  FOREIGN KEY (branch_id) REFERENCES branches(id)
);

-- ─── Offers / Coupons ───
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  discount_type TEXT NOT NULL DEFAULT 'percentage',
  discount_value REAL NOT NULL,
  min_order_amount REAL NOT NULL DEFAULT 0,
  max_discount_amount REAL,
  applicable_to TEXT NOT NULL DEFAULT 'all',
  applicable_ids TEXT NOT NULL DEFAULT '',
  branch_ids TEXT NOT NULL DEFAULT '',
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  total_usage_limit INTEGER,
  per_customer_limit INTEGER NOT NULL DEFAULT 1,
  times_used INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_offers_code ON offers(code);
CREATE INDEX IF NOT EXISTS idx_offers_active ON offers(is_active, valid_from, valid_until);

-- ─── Customers ───
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  gender TEXT,
  date_of_birth TEXT,
  address TEXT,
  city TEXT,
  pincode TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

-- ─── Appointment Slots ───
CREATE TABLE IF NOT EXISTS appointment_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL,
  slot_type TEXT NOT NULL DEFAULT 'branch_visit',
  slot_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  max_capacity INTEGER NOT NULL DEFAULT 5,
  booked_count INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (branch_id) REFERENCES branches(id)
);
CREATE INDEX IF NOT EXISTS idx_slots_branch_date ON appointment_slots(branch_id, slot_date);
CREATE INDEX IF NOT EXISTS idx_slots_available ON appointment_slots(branch_id, slot_date, slot_type, is_active);

-- ─── Bookings ───
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  appointment_type TEXT NOT NULL DEFAULT 'branch_visit',
  appointment_date TEXT NOT NULL,
  appointment_time TEXT NOT NULL,
  slot_id INTEGER,
  patient_name TEXT NOT NULL,
  patient_phone TEXT NOT NULL,
  patient_age INTEGER,
  patient_gender TEXT,
  patient_email TEXT,
  home_address TEXT,
  home_pincode TEXT,
  home_landmark TEXT,
  home_city TEXT,
  home_contact_instructions TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  home_collection_charge REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  coupon_code TEXT,
  total_amount REAL NOT NULL DEFAULT 0,
  notes TEXT,
  consent_given INTEGER NOT NULL DEFAULT 0,
  booking_status TEXT NOT NULL DEFAULT 'new',
  payment_status TEXT NOT NULL DEFAULT 'pending',
  sample_status TEXT NOT NULL DEFAULT 'pending',
  report_status TEXT NOT NULL DEFAULT 'pending',
  tracking_token TEXT NOT NULL,
  tracking_token_expires_at TEXT,
  internal_notes TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (branch_id) REFERENCES branches(id),
  FOREIGN KEY (slot_id) REFERENCES appointment_slots(id)
);
CREATE INDEX IF NOT EXISTS idx_bookings_booking_id ON bookings(booking_id);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_branch ON bookings(branch_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(booking_status);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(appointment_date);
CREATE INDEX IF NOT EXISTS idx_bookings_tracking ON bookings(tracking_token);

-- ─── Booking Items (snapshot of tests/packages at booking time) ───
CREATE TABLE IF NOT EXISTS booking_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  item_type TEXT NOT NULL DEFAULT 'test',
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  item_code TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0,
  total_price REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);
CREATE INDEX IF NOT EXISTS idx_booking_items_booking ON booking_items(booking_id);

-- ─── Payments ───
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  payment_ref TEXT NOT NULL UNIQUE,
  amount REAL NOT NULL,
  upi_id TEXT NOT NULL,
  payee_name TEXT NOT NULL,
  payment_uri TEXT NOT NULL,
  qr_generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  qr_expires_at TEXT,
  qr_status TEXT NOT NULL DEFAULT 'active',
  payment_status TEXT NOT NULL DEFAULT 'pending',
  utr_number TEXT,
  transaction_date TEXT,
  verified_at TEXT,
  verified_by INTEGER,
  admin_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (booking_id) REFERENCES bookings(id),
  FOREIGN KEY (verified_by) REFERENCES admins(id)
);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_ref ON payments(payment_ref);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(payment_status);

-- ─── Medical Reports ───
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  file_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  is_available INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER,
  replaced_by INTEGER,
  replaced_at TEXT,
  replace_reason TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (booking_id) REFERENCES bookings(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (uploaded_by) REFERENCES admins(id)
);
CREATE INDEX IF NOT EXISTS idx_reports_booking ON reports(booking_id);
CREATE INDEX IF NOT EXISTS idx_reports_customer ON reports(customer_id);

-- ─── Private Report File Chunks (D1 fallback when R2 is not enabled) ───
CREATE TABLE IF NOT EXISTS report_file_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  data_b64 TEXT NOT NULL,
  FOREIGN KEY (report_id) REFERENCES reports(id)
);
CREATE INDEX IF NOT EXISTS idx_report_chunks_report ON report_file_chunks(report_id, chunk_index);

-- ─── WhatsApp Messages ───
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER,
  customer_phone TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'payment_qr',
  template_name TEXT,
  whatsapp_message_id TEXT,
  media_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  sent_at TEXT,
  delivered_at TEXT,
  read_at TEXT,
  failed_at TEXT,
  failure_reason TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  request_payload TEXT,
  response_payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);
CREATE INDEX IF NOT EXISTS idx_wa_booking ON whatsapp_messages(booking_id);
CREATE INDEX IF NOT EXISTS idx_wa_status ON whatsapp_messages(status);

-- ─── WhatsApp Webhook Events ───
CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  message_id TEXT,
  status TEXT,
  timestamp_str TEXT,
  raw_payload TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Notifications ───
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  reference_type TEXT,
  reference_id INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read, created_at);

-- ─── Business Settings ───
CREATE TABLE IF NOT EXISTS business_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Audit Logs ───
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  old_value TEXT,
  new_value TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (admin_id) REFERENCES admins(id)
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_admin ON audit_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_date ON audit_logs(created_at);

-- ─── Holiday Calendar ───
CREATE TABLE IF NOT EXISTS branch_holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL,
  holiday_date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (branch_id) REFERENCES branches(id),
  UNIQUE(branch_id, holiday_date)
);
