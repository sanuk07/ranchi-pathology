-- =====================================================
-- Ranchi Pathology — Demo Seed Data
-- Run this ONLY in demo mode for development/testing
-- =====================================================

-- ─── Default Business Settings ───
INSERT OR REPLACE INTO business_settings (key, value) VALUES
  ('business_name', 'Ranchi Pathology'),
  ('business_tagline', 'Your Health, Our Priority'),
  ('currency', 'INR'),
  ('timezone', 'Asia/Kolkata'),
  ('upi_id', '6204522977@ptyes'),
  ('upi_payee_name', 'sanu'),
  ('booking_id_prefix', 'RP'),
  ('qr_validity_minutes', '1440'),
  ('max_report_size_mb', '10'),
  ('home_collection_default_charge', '0'),
  ('environment', 'demo'),
  ('whatsapp_configured', 'false'),
  ('notification_sound_enabled', 'true');

-- ─── Branches ───
INSERT INTO branches (name, slug, address, city, phone, home_collection_charge_type, sort_order) VALUES
  ('Chandwa', 'chandwa', 'Address not yet configured', 'Chandwa', 'Not yet configured', 'free', 1),
  ('Lohardaga', 'lohardaga', 'Address not yet configured', 'Lohardaga', 'Not yet configured', 'free', 2),
  ('Ranchi', 'ranchi', 'Address not yet configured', 'Ranchi', 'Not yet configured', 'free', 3);

-- ─── Test Categories ───
INSERT INTO test_categories (name, slug, icon, sort_order) VALUES
  ('Blood Tests', 'blood-tests', 'droplet', 1),
  ('Diabetes Tests', 'diabetes-tests', 'activity', 2),
  ('Thyroid Tests', 'thyroid-tests', 'shield', 3),
  ('Liver Profile', 'liver-profile', 'clipboard', 4),
  ('Kidney Profile', 'kidney-profile', 'heart', 5),
  ('Heart Health', 'heart-health', 'heart-pulse', 6),
  ('Full Body Checkup', 'full-body-checkup', 'user-check', 7),
  ('Other Tests', 'other-tests', 'flask', 8);

-- ─── Demo Tests (prices are demo placeholders) ───
INSERT INTO tests (test_code, name, category_id, description, price, discounted_price, sample_type, fasting_required, fasting_hours, report_time) VALUES
  ('CBC001', 'Complete Blood Count (CBC)', 1, 'Measures red blood cells, white blood cells, hemoglobin, hematocrit, and platelets.', 350, 299, 'Blood', 0, NULL, '6 hours'),
  ('HB001', 'Hemoglobin Test', 1, 'Measures the level of hemoglobin in your blood.', 150, NULL, 'Blood', 0, NULL, '4 hours'),
  ('ESR001', 'ESR (Erythrocyte Sedimentation Rate)', 1, 'Measures inflammation in the body.', 200, NULL, 'Blood', 0, NULL, '6 hours'),
  ('FBS001', 'Fasting Blood Sugar', 2, 'Measures blood glucose level after fasting.', 100, 80, 'Blood', 1, 8, '4 hours'),
  ('PPBS001', 'Post Prandial Blood Sugar', 2, 'Measures blood sugar 2 hours after eating.', 100, NULL, 'Blood', 0, NULL, '4 hours'),
  ('HBA1C001', 'HbA1c (Glycated Hemoglobin)', 2, 'Shows average blood sugar over past 2-3 months.', 450, 399, 'Blood', 0, NULL, '24 hours'),
  ('TSH001', 'TSH (Thyroid Stimulating Hormone)', 3, 'Screens for thyroid disorders.', 300, 249, 'Blood', 0, NULL, '24 hours'),
  ('T3001', 'T3 (Triiodothyronine)', 3, 'Measures T3 thyroid hormone level.', 350, NULL, 'Blood', 0, NULL, '24 hours'),
  ('T4001', 'T4 (Thyroxine)', 3, 'Measures T4 thyroid hormone level.', 350, NULL, 'Blood', 0, NULL, '24 hours'),
  ('LFT001', 'Liver Function Test (LFT)', 4, 'Comprehensive panel to assess liver health.', 600, 499, 'Blood', 1, 10, '24 hours'),
  ('SGPT001', 'SGPT / ALT', 4, 'Measures ALT enzyme level for liver assessment.', 200, NULL, 'Blood', 0, NULL, '12 hours'),
  ('SGOT001', 'SGOT / AST', 4, 'Measures AST enzyme level for liver assessment.', 200, NULL, 'Blood', 0, NULL, '12 hours'),
  ('KFT001', 'Kidney Function Test (KFT)', 5, 'Comprehensive kidney health assessment panel.', 650, 549, 'Blood', 1, 8, '24 hours'),
  ('CREAT001', 'Serum Creatinine', 5, 'Measures creatinine for kidney function.', 200, NULL, 'Blood', 0, NULL, '12 hours'),
  ('UREA001', 'Blood Urea', 5, 'Measures urea nitrogen in blood.', 200, NULL, 'Blood', 0, NULL, '12 hours'),
  ('LIPID001', 'Lipid Profile', 6, 'Measures cholesterol, triglycerides, HDL and LDL.', 500, 399, 'Blood', 1, 12, '24 hours'),
  ('ECG001', 'ECG Report Analysis', 6, 'Electrocardiogram report analysis.', 300, NULL, 'N/A', 0, NULL, '2 hours'),
  ('UA001', 'Urine Analysis', 8, 'Complete urine examination.', 150, NULL, 'Urine', 0, NULL, '6 hours'),
  ('WIDAL001', 'Widal Test', 8, 'Tests for typhoid fever.', 250, NULL, 'Blood', 0, NULL, '12 hours'),
  ('VDRL001', 'VDRL Test', 8, 'Screening test for syphilis.', 300, NULL, 'Blood', 0, NULL, '24 hours');

-- ─── Link all tests to all branches ───
INSERT INTO test_branches (test_id, branch_id)
SELECT t.id, b.id FROM tests t CROSS JOIN branches b;

-- ─── Demo Packages ───
INSERT INTO packages (name, slug, description, original_price, offer_price, discount_percent) VALUES
  ('Basic Health Checkup', 'basic-health-checkup', 'Essential tests for routine health screening including blood count, sugar, and urine analysis.', 700, 549, 22),
  ('Diabetes Care Package', 'diabetes-care-package', 'Complete diabetes monitoring with fasting sugar, post-prandial sugar, and HbA1c.', 650, 499, 23),
  ('Thyroid Profile Complete', 'thyroid-profile-complete', 'Full thyroid assessment with TSH, T3, and T4 tests.', 1000, 749, 25),
  ('Full Body Checkup', 'full-body-checkup', 'Comprehensive health screening covering blood, liver, kidney, thyroid, lipid, and urine.', 3500, 2499, 29);

-- ─── Link tests to packages ───
INSERT INTO package_tests (package_id, test_id) VALUES
  (1, 1), (1, 4), (1, 18),
  (2, 4), (2, 5), (2, 6),
  (3, 7), (3, 8), (3, 9),
  (4, 1), (4, 4), (4, 6), (4, 7), (4, 10), (4, 13), (4, 16), (4, 18);

-- ─── Link packages to all branches ───
INSERT INTO package_branches (package_id, branch_id)
SELECT p.id, b.id FROM packages p CROSS JOIN branches b;

-- ─── Demo Offer ───
INSERT INTO offers (code, title, description, discount_type, discount_value, min_order_amount, max_discount_amount, valid_from, valid_until, total_usage_limit, per_customer_limit)
VALUES ('WELCOME10', 'Welcome Offer', '10% off on your first booking', 'percentage', 10, 200, 500, '2026-01-01', '2027-12-31', 1000, 1);
