/* =====================================================
   Ranchi Pathology — UI Utility Functions
   Toast, Modal, Loading, Validation, Formatting
   ===================================================== */

const UI = (() => {

  /* ─── Toast ─── */
  function ensureToastContainer() {
    let c = document.getElementById('toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toast-container';
      c.className = 'toast-container';
      c.setAttribute('role', 'alert');
      c.setAttribute('aria-live', 'polite');
      document.body.appendChild(c);
    }
    return c;
  }

  function toast(message, type = 'info', duration = 4000) {
    const container = ensureToastContainer();
    const icons = {
      success: '<svg width="20" height="20" fill="none" stroke="#10B981" stroke-width="2" viewBox="0 0 24 24"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>',
      error: '<svg width="20" height="20" fill="none" stroke="#EF4444" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
      warning: '<svg width="20" height="20" fill="none" stroke="#F59E0B" stroke-width="2" viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>',
      info: '<svg width="20" height="20" fill="none" stroke="#3B82F6" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>'
    };
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `
      ${icons[type] || icons.info}
      <span class="toast-message">${escapeHtml(message)}</span>
      <button class="toast-close" aria-label="Close">&times;</button>
    `;
    el.querySelector('.toast-close').onclick = () => removeToast(el);
    container.appendChild(el);
    if (duration > 0) setTimeout(() => removeToast(el), duration);
  }

  function removeToast(el) {
    el.style.opacity = '0';
    el.style.transform = 'translateX(100%)';
    setTimeout(() => el.remove(), 300);
  }

  /* ─── Modal ─── */
  function openModal(id) {
    const overlay = document.getElementById(id);
    if (overlay) {
      overlay.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
  }

  function closeModal(id) {
    const overlay = document.getElementById(id);
    if (overlay) {
      overlay.classList.remove('open');
      document.body.style.overflow = '';
    }
  }

  function confirm(message, onConfirm, title = 'Confirm') {
    let overlay = document.getElementById('confirm-modal-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'confirm-modal-overlay';
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" style="max-width:420px">
          <div class="modal-header">
            <h3 class="modal-title" id="confirm-title"></h3>
            <button class="modal-close" id="confirm-cancel-x" aria-label="Close">&times;</button>
          </div>
          <div class="modal-body"><p id="confirm-message"></p></div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="confirm-cancel-btn">Cancel</button>
            <button class="btn btn-primary" id="confirm-ok-btn">Confirm</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
    }
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';

    const close = () => { overlay.classList.remove('open'); document.body.style.overflow = ''; };
    document.getElementById('confirm-cancel-btn').onclick = close;
    document.getElementById('confirm-cancel-x').onclick = close;
    document.getElementById('confirm-ok-btn').onclick = () => { close(); onConfirm(); };
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
  }

  /* ─── Loading ─── */
  function showLoading(message = 'Loading...') {
    let el = document.getElementById('loading-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'loading-overlay';
      el.className = 'loading-overlay';
      el.innerHTML = `<div class="spinner"></div><p id="loading-text"></p>`;
      document.body.appendChild(el);
    }
    document.getElementById('loading-text').textContent = message;
    el.style.display = 'flex';
  }

  function hideLoading() {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.display = 'none';
  }

  function setButtonLoading(btn, loading) {
    if (loading) {
      btn.dataset.originalText = btn.textContent;
      btn.classList.add('loading');
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.originalText || btn.textContent;
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  /* ─── Formatting ─── */
  function formatCurrency(amount) {
    return '₹' + Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function formatDateTime(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function formatTime(timeStr) {
    if (!timeStr) return '—';
    const [h, m] = timeStr.split(':');
    const hour = parseInt(h);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const h12 = hour % 12 || 12;
    return `${h12}:${m} ${ampm}`;
  }

  function formatPhone(phone) {
    if (!phone) return '—';
    phone = phone.replace(/\D/g, '');
    if (phone.length === 10) return `${phone.slice(0,5)} ${phone.slice(5)}`;
    return phone;
  }

  function timeAgo(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return formatDate(dateStr);
  }

  /* ─── Validation ─── */
  function validatePhone(phone) {
    return /^[6-9]\d{9}$/.test(phone.replace(/\D/g, ''));
  }

  function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function validatePincode(pin) {
    return /^\d{6}$/.test(pin);
  }

  function showFieldError(input, message) {
    input.classList.add('error');
    let err = input.parentElement.querySelector('.form-error');
    if (!err) {
      err = document.createElement('div');
      err.className = 'form-error';
      input.parentElement.appendChild(err);
    }
    err.textContent = message;
  }

  function clearFieldError(input) {
    input.classList.remove('error');
    const err = input.parentElement.querySelector('.form-error');
    if (err) err.remove();
  }

  function clearAllErrors(form) {
    form.querySelectorAll('.error').forEach(el => el.classList.remove('error'));
    form.querySelectorAll('.form-error').forEach(el => el.remove());
  }

  /* ─── Sanitize ─── */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* ─── Mobile Menu ─── */
  function initMobileMenu() {
    const btn = document.getElementById('mobile-menu-btn');
    const menu = document.getElementById('mobile-menu');
    const close = document.getElementById('mobile-menu-close');
    if (!btn || !menu) return;
    btn.addEventListener('click', () => menu.classList.add('open'));
    if (close) close.addEventListener('click', () => menu.classList.remove('open'));
    menu.addEventListener('click', (e) => { if (e.target === menu) menu.classList.remove('open'); });
  }

  /* ─── Debounce ─── */
  function debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  /* ─── Init ─── */
  document.addEventListener('DOMContentLoaded', () => {
    initMobileMenu();
  });

  return {
    toast, openModal, closeModal, confirm,
    showLoading, hideLoading, setButtonLoading,
    formatCurrency, formatDate, formatDateTime, formatTime, formatPhone, timeAgo,
    validatePhone, validateEmail, validatePincode,
    showFieldError, clearFieldError, clearAllErrors,
    escapeHtml, debounce,
  };
})();
