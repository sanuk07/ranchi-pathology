/* =====================================================
   Ranchi Pathology — Core API Client
   Handles all fetch requests to the backend Worker
   ===================================================== */

const API = (() => {
  const BASE = '/api';

  function getAuthHeaders() {
    const token = sessionStorage.getItem('rp_admin_token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  async function request(method, path, body = null, isFormData = false) {
    const opts = { method, headers: isFormData ? {} : getAuthHeaders() };
    if (isFormData) {
      const token = sessionStorage.getItem('rp_admin_token');
      if (token) opts.headers['Authorization'] = `Bearer ${token}`;
      opts.body = body;
    } else if (body) {
      opts.body = JSON.stringify(body);
    }
    try {
      const res = await fetch(`${BASE}${path}`, opts);
      if (res.status === 401) {
        sessionStorage.removeItem('rp_admin_token');
        if (window.location.pathname.startsWith('/admin') && !window.location.pathname.endsWith('login.html')) {
          window.location.href = '/admin/login.html';
        }
        throw { status: 401, message: 'Session expired. Please log in again.' };
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw { status: res.status, message: data.error || 'Request failed', data };
      return data;
    } catch (err) {
      if (err.status) throw err;
      throw { status: 0, message: 'Network error. Please check your connection.' };
    }
  }

  return {
    get:    (path)       => request('GET', path),
    post:   (path, body) => request('POST', path, body),
    put:    (path, body) => request('PUT', path, body),
    patch:  (path, body) => request('PATCH', path, body),
    del:    (path)       => request('DELETE', path),
    upload: (path, formData) => request('POST', path, formData, true),
  };
})();
