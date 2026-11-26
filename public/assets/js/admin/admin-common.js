/* =====================================================
   Ranchi Pathology — Shared Admin Common Module
   Sidebar, Header, Auth Verification, Notifications
   ===================================================== */

const AdminCommon = (() => {
  let currentAdmin = null;
  let pollTimer = null;
  let notifications = [];
  let audioCtx = null;
  let soundInitialized = false;
  let lastSeenNotifId = Number(sessionStorage.getItem('rp_last_notif_id') || 0);

  function isSoundMuted() {
    return localStorage.getItem('rp_admin_sound_muted') === '1';
  }

  function unlockAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch {
      // Ignore if browser blocks audio
    }
  }

  function playNotificationChime() {
    if (isSoundMuted()) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      if (audioCtx.state !== 'running') return;

      const now = audioCtx.currentTime;
      const notes = [880, 1174.66]; // A5 -> D6 clean chime
      notes.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + i * 0.12);
        gain.gain.setValueAtTime(0.001, now + i * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.14, now + i * 0.12 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.28);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now + i * 0.12);
        osc.stop(now + i * 0.12 + 0.3);
      });
    } catch {
      // Ignore audio errors
    }
  }

  function soundIcon(muted) {
    if (muted) {
      return '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M23 9l-6 6M17 9l6 6"/></svg>';
    }
    return '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14"/></svg>';
  }

  const NAV_SECTIONS = [
    {
      label: 'Overview',
      items: [
        { id: 'dashboard', label: 'Dashboard', href: '/admin/dashboard.html', icon: 'barChart' },
      ],
    },
    {
      label: 'Operations',
      items: [
        { id: 'bookings', label: 'Bookings', href: '/admin/bookings.html', icon: 'calendar' },
        { id: 'payments', label: 'Payments', href: '/admin/payments.html', icon: 'qrCode' },
        { id: 'reports', label: 'Reports', href: '/admin/reports.html', icon: 'fileText' },
        { id: 'customers', label: 'Customers', href: '/admin/customers.html', icon: 'users' },
      ],
    },
    {
      label: 'Catalog & Branches',
      items: [
        { id: 'tests', label: 'Tests', href: '/admin/tests.html', icon: 'flask' },
        { id: 'packages', label: 'Packages', href: '/admin/packages.html', icon: 'package' },
        { id: 'offers', label: 'Offers', href: '/admin/offers.html', icon: 'tag' },
        { id: 'branches', label: 'Branches & Slots', href: '/admin/branches.html', icon: 'building' },
      ],
    },
    {
      label: 'Communication & System',
      items: [
        { id: 'whatsapp', label: 'WhatsApp Logs', href: '/admin/whatsapp.html', icon: 'whatsapp' },
        { id: 'settings', label: 'Settings', href: '/admin/settings.html', icon: 'settings' },
        { id: 'audit-logs', label: 'Audit Logs', href: '/admin/audit-logs.html', icon: 'clipboard' },
      ],
    },
  ];

  function getToken() {
    return sessionStorage.getItem('rp_admin_token');
  }

  function requireToken() {
    const token = getToken();
    if (!token) {
      window.location.replace('/admin/login.html');
      return false;
    }
    return true;
  }

  function renderSidebar(activePage) {
    const sidebar = document.getElementById('admin-sidebar');
    if (!sidebar) return;

    const navHtml = NAV_SECTIONS.map(section => {
      const links = section.items.map(item => `
        <a href="${item.href}" class="admin-nav-link ${activePage === item.id ? 'active' : ''}">
          ${Components.icon(item.icon)}
          <span>${UI.escapeHtml(item.label)}</span>
        </a>
      `).join('');
      return `<div class="admin-nav-section">${UI.escapeHtml(section.label)}</div>${links}`;
    }).join('');

    sidebar.innerHTML = `
      <div class="admin-sidebar-header">
        <a href="/admin/dashboard.html" class="admin-brand">
          ${Components.logoSVG(34)}
          <div>
            <span>Ranchi Pathology</span>
            <small>Admin Console</small>
          </div>
        </a>
        <button class="admin-sidebar-close" id="admin-sidebar-close" aria-label="Close sidebar">
          ${Components.icon('close')}
        </button>
      </div>
      <nav class="admin-nav" aria-label="Admin Navigation">
        ${navHtml}
      </nav>
      <div class="admin-sidebar-footer">
        <a href="/" target="_blank" rel="noopener" class="btn btn-secondary btn-sm btn-block">
          ${Components.icon('eye')}
          <span>View Public Site</span>
        </a>
      </div>
    `;

    const closeBtn = document.getElementById('admin-sidebar-close');
    const backdrop = document.getElementById('admin-sidebar-backdrop');
    if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
    if (backdrop) backdrop.addEventListener('click', closeSidebar);
  }

  function renderHeader(title, subtitle = '') {
    const header = document.getElementById('admin-header');
    if (!header) return;

    header.innerHTML = `
      <div class="admin-header-left">
        <button class="admin-menu-toggle" id="admin-menu-toggle" aria-label="Open menu">
          ${Components.icon('menu')}
        </button>
        <div style="min-width:0">
          <h1 class="admin-page-title">${UI.escapeHtml(title)}</h1>
          ${subtitle ? `<p class="admin-page-subtitle">${UI.escapeHtml(subtitle)}</p>` : ''}
        </div>
      </div>
      <div class="admin-header-right">
        <span id="admin-env-badge" class="env-badge demo" style="display:none"></span>
        <button class="notif-btn" id="sound-toggle-btn" aria-label="Toggle notification sound" title="Notification Sound">
          ${soundIcon(isSoundMuted())}
        </button>
        <div class="notif-wrapper" id="notif-wrapper">
          <button class="notif-btn" id="notif-toggle-btn" aria-label="Notifications" title="Notifications">
            ${Components.icon('bell')}
            <span class="notif-badge" id="notif-badge">0</span>
          </button>
          <div class="notif-dropdown" id="notif-dropdown">
            <div class="notif-dropdown-header">
              <span>Notifications</span>
              <button class="btn btn-sm btn-secondary" id="notif-refresh-btn" style="min-height:28px;padding:2px 10px" title="Refresh">
                ${Components.icon('refresh')}
              </button>
            </div>
            <div class="notif-dropdown-list" id="notif-dropdown-list">
              <div style="padding:1.5rem;text-align:center;color:var(--muted);font-size:var(--fs-sm)">
                Loading notifications...
              </div>
            </div>
          </div>
        </div>
        <div class="admin-user-chip" id="admin-user-chip">
          <div class="admin-avatar" id="admin-avatar">A</div>
          <span class="admin-user-name" id="admin-user-name">Admin</span>
        </div>
        <button class="btn btn-secondary btn-sm" id="admin-logout-btn" title="Logout">
          ${Components.icon('logout')}
          <span class="hide-sm">Logout</span>
        </button>
      </div>
    `;

    const toggleBtn = document.getElementById('admin-menu-toggle');
    if (toggleBtn) toggleBtn.addEventListener('click', openSidebar);

    const logoutBtn = document.getElementById('admin-logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', logout);

    const soundBtn = document.getElementById('sound-toggle-btn');
    if (soundBtn) {
      const updateSoundBtn = () => {
        const muted = isSoundMuted();
        soundBtn.innerHTML = soundIcon(muted);
        soundBtn.title = muted ? 'Notification Sound Muted (Click to Enable)' : 'Notification Sound On (Click to Mute)';
      };
      updateSoundBtn();
      soundBtn.addEventListener('click', () => {
        const nextMuted = !isSoundMuted();
        localStorage.setItem('rp_admin_sound_muted', nextMuted ? '1' : '0');
        updateSoundBtn();
        if (!nextMuted) {
          unlockAudio();
          playNotificationChime();
          UI.toast('Notification sound enabled', 'success');
        } else {
          UI.toast('Notification sound muted', 'info');
        }
      });
    }

    // Unlock Web Audio on first user interaction in admin panel
    ['pointerdown', 'keydown'].forEach(evt => {
      document.addEventListener(evt, unlockAudio, { once: true, passive: true });
    });

    const notifBtn = document.getElementById('notif-toggle-btn');
    const notifDropdown = document.getElementById('notif-dropdown');
    const notifRefresh = document.getElementById('notif-refresh-btn');

    if (notifBtn && notifDropdown) {
      notifBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        notifDropdown.classList.toggle('open');
      });
      document.addEventListener('click', (e) => {
        const wrapper = document.getElementById('notif-wrapper');
        if (wrapper && !wrapper.contains(e.target)) {
          notifDropdown.classList.remove('open');
        }
      });
    }
    if (notifRefresh) {
      notifRefresh.addEventListener('click', (e) => {
        e.stopPropagation();
        fetchNotifications();
      });
    }
  }

  function openSidebar() {
    document.getElementById('admin-sidebar')?.classList.add('open');
    document.getElementById('admin-sidebar-backdrop')?.classList.add('open');
  }

  function closeSidebar() {
    document.getElementById('admin-sidebar')?.classList.remove('open');
    document.getElementById('admin-sidebar-backdrop')?.classList.remove('open');
  }

  async function verifyAuth() {
    try {
      const res = await API.get('/admin/me');
      const admin = res.admin || res.user || res;
      currentAdmin = admin;
      const name = admin.display_name || admin.displayName || admin.username || 'Admin';
      const nameEl = document.getElementById('admin-user-name');
      const avatarEl = document.getElementById('admin-avatar');
      if (nameEl) nameEl.textContent = name;
      if (avatarEl) avatarEl.textContent = name.charAt(0).toUpperCase();
      return admin;
    } catch (err) {
      if (err.status === 401) {
        sessionStorage.removeItem('rp_admin_token');
        window.location.replace('/admin/login.html');
      }
      throw err;
    }
  }

  async function loadEnvBadge() {
    try {
      const data = await API.get('/settings/public');
      const env = (data.environment || data.settings?.environment || '').toLowerCase();
      const badge = document.getElementById('admin-env-badge');
      if (badge && env) {
        badge.style.display = 'inline-flex';
        badge.className = `env-badge ${env === 'production' ? 'production' : 'demo'}`;
        badge.textContent = env === 'production' ? 'Live Mode' : 'Demo Mode';
      }
    } catch {
      // Non-critical
    }
  }

  async function fetchNotifications() {
    try {
      const res = await API.get('/admin/notifications');
      notifications = unwrapList(res, ['notifications', 'items', 'data']);
      const unreadCount = res.unread_count ?? res.unreadCount ?? notifications.filter(n => !n.is_read).length;

      const badge = document.getElementById('notif-badge');
      if (badge) {
        badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        badge.classList.toggle('visible', unreadCount > 0);
      }

      const maxId = notifications.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0);
      if (!soundInitialized) {
        soundInitialized = true;
        if (maxId > lastSeenNotifId) {
          lastSeenNotifId = maxId;
          sessionStorage.setItem('rp_last_notif_id', String(lastSeenNotifId));
        }
      } else if (maxId > lastSeenNotifId) {
        const newUnread = notifications.filter(n => (Number(n.id) || 0) > lastSeenNotifId && !n.is_read);
        lastSeenNotifId = maxId;
        sessionStorage.setItem('rp_last_notif_id', String(lastSeenNotifId));
        if (newUnread.length > 0) {
          playNotificationChime();
          UI.toast(newUnread[0].title || 'New booking / notification arrived', 'info', 5000);
        }
      }

      renderNotificationsList();
    } catch {
      // Fail silently during background poll
    }
  }

  function renderNotificationsList() {
    const list = document.getElementById('notif-dropdown-list');
    if (!list) return;

    if (!notifications.length) {
      list.innerHTML = `<div style="padding:1.5rem;text-align:center;color:var(--muted);font-size:var(--fs-sm)">No notifications yet</div>`;
      return;
    }

    list.innerHTML = notifications.slice(0, 20).map(n => `
      <div class="notif-item ${n.is_read ? '' : 'unread'}" data-notif-id="${n.id}" data-ref-type="${UI.escapeHtml(n.reference_type || '')}" data-ref-id="${n.reference_id || ''}">
        <span class="notif-dot"></span>
        <div style="flex:1;min-width:0">
          <div class="notif-item-title">${UI.escapeHtml(n.title || 'Notification')}</div>
          <div class="notif-item-msg">${UI.escapeHtml(n.message || '')}</div>
          <div class="notif-item-time">${UI.timeAgo(n.created_at)}</div>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.notif-item').forEach(el => {
      el.addEventListener('click', async () => {
        const id = el.dataset.notifId;
        const refType = el.dataset.refType;
        try {
          await API.patch(`/admin/notifications/${id}/read`, {});
          el.classList.remove('unread');
          const item = notifications.find(x => String(x.id) === String(id));
          if (item) item.is_read = 1;
          const unread = notifications.filter(n => !n.is_read).length;
          const badge = document.getElementById('notif-badge');
          if (badge) {
            badge.textContent = String(unread);
            badge.classList.toggle('visible', unread > 0);
          }
        } catch {
          // ignore
        }
        if (refType === 'booking') window.location.href = '/admin/bookings.html';
        else if (refType === 'payment') window.location.href = '/admin/payments.html';
      });
    });
  }

  function startNotificationPolling() {
    fetchNotifications();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(fetchNotifications, 30000);
  }

  async function logout() {
    try {
      await API.post('/admin/logout', {});
    } catch {
      // Best-effort server logout
    }
    if (pollTimer) clearInterval(pollTimer);
    sessionStorage.removeItem('rp_admin_token');
    window.location.replace('/admin/login.html');
  }

  async function init({ page = '', title = 'Admin', subtitle = '' } = {}) {
    if (!requireToken()) return null;
    renderSidebar(page);
    renderHeader(title, subtitle);
    bindModalOverlays();
    loadEnvBadge();
    startNotificationPolling();
    return await verifyAuth();
  }

  /* ─── Shared Helpers ─── */
  function unwrapList(res, keys = ['data', 'items']) {
    if (Array.isArray(res)) return res;
    if (!res || typeof res !== 'object') return [];
    for (const k of keys) {
      if (Array.isArray(res[k])) return res[k];
    }
    for (const val of Object.values(res)) {
      if (Array.isArray(val)) return val;
    }
    return [];
  }

  function statusBadge(status) {
    const s = String(status || 'pending').toLowerCase();
    const map = {
      new: 'status-new',
      pending: 'status-pending',
      confirmed: 'status-confirmed',
      sample_collected: 'status-processing',
      processing: 'status-processing',
      completed: 'status-completed',
      cancelled: 'status-cancelled',
      queued: 'status-pending',
      sent: 'status-new',
      delivered: 'status-confirmed',
      read: 'status-completed',
      failed: 'status-cancelled',
    };
    const cls = map[s] || 'status-pending';
    return `<span class="status ${cls}">${UI.escapeHtml(s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))}</span>`;
  }

  function paymentBadge(status) {
    const s = String(status || 'pending').toLowerCase();
    const map = {
      verified: 'badge-green',
      paid: 'badge-green',
      pending: 'badge-yellow',
      partial: 'badge-blue',
      failed: 'badge-red',
      rejected: 'badge-red',
      expired: 'badge-gray',
      refunded: 'badge-gray',
    };
    const cls = map[s] || 'badge-gray';
    return `<span class="badge ${cls}">${UI.escapeHtml(s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))}</span>`;
  }

  function bindModalOverlays() {
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.classList.remove('open');
          document.body.style.overflow = '';
        }
      });
    });
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => UI.closeModal(btn.dataset.closeModal));
    });
  }

  function emptyStateHTML(iconName, title, message) {
    return `
      <div class="empty-state">
        ${Components.icon(iconName)}
        <h3>${UI.escapeHtml(title)}</h3>
        <p>${UI.escapeHtml(message)}</p>
      </div>
    `;
  }

  function renderPagination(containerId, page, totalPages, onPageChange) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!totalPages || totalPages <= 1) {
      el.innerHTML = '';
      return;
    }
    let html = `<button ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">Prev</button>`;
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, page + 2);
    for (let p = start; p <= end; p++) {
      html += `<button class="${p === page ? 'active' : ''}" data-page="${p}">${p}</button>`;
    }
    html += `<button ${page >= totalPages ? 'disabled' : ''} data-page="${page + 1}">Next</button>`;
    el.innerHTML = html;
    el.querySelectorAll('button[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = parseInt(btn.dataset.page, 10);
        if (target >= 1 && target <= totalPages && target !== page) onPageChange(target);
      });
    });
  }

  return {
    init,
    logout,
    fetchNotifications,
    unwrapList,
    statusBadge,
    paymentBadge,
    emptyStateHTML,
    renderPagination,
    getAdmin: () => currentAdmin,
  };
})();
