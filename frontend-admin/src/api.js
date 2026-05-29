// Auto-detect backend URL: same host, port 8000 (orchestrator)
const API_BASE = import.meta.env.VITE_API_URL || `${window.location.protocol}//${window.location.hostname}:8000`;

let onUnauthorized = null;

export function setOnUnauthorized(fn) {
  onUnauthorized = fn;
}

async function request(method, path, body, token, { skipUnauthorized = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    if (!skipUnauthorized && onUnauthorized) {
      onUnauthorized();
    }
    throw new Error('Session expired');
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Request failed');
  return data;
}

const api = {
  // Auth (handled directly by orchestrator)
  login: (email, password) => request('POST', '/auth/login', { email, password }),
  logout: (token) => request('POST', '/auth/logout', null, token),
  switchContext: (account_id, project_id, token) =>
    request('POST', '/auth/switch-context', { account_id, project_id }, token),
  getMe: (token) => request('GET', '/me', null, token, { skipUnauthorized: true }),
  changePassword: (current_password, new_password, token) =>
    request('PUT', '/registry/me/password', { current_password, new_password }, token),

  // Accounts (via orchestrator /registry prefix)
  listAccounts: (token) => request('GET', '/registry/accounts', null, token),
  createAccount: (slug, name, token) => request('POST', '/registry/accounts', { slug, name }, token),

  // Projects
  listProjects: (slug, token) => request('GET', `/registry/accounts/${slug}/projects`, null, token),
  createProject: (slug, projectSlug, projectName, token) =>
    request('POST', `/registry/accounts/${slug}/projects`, { slug: projectSlug, name: projectName }, token),
  deleteProject: (slug, pslug, token) =>
    request('DELETE', `/registry/accounts/${slug}/projects/${pslug}`, null, token),

  // Users
  listUsers: (token) => request('GET', '/registry/users', null, token),
  createUser: (data, token) => request('POST', '/registry/users', data, token),
  updateUser: (id, data, token) => request('PUT', `/registry/users/${id}`, data, token),
  disableUser: (id, token) => request('DELETE', `/registry/users/${id}`, null, token),
  addRole: (userId, data, token) => request('POST', `/registry/users/${userId}/roles`, data, token),
  removeRole: (userId, roleId, token) =>
    request('DELETE', `/registry/users/${userId}/roles/${roleId}`, null, token),
  listUserRoles: (userId, token) => request('GET', `/registry/users/${userId}/roles`, null, token),

  // Tests
  listTests: (token) => request('GET', '/registry/tests', null, token),
  getTest: (id, token) => request('GET', `/registry/tests/${id}`, null, token),
  updateTest: (id, data, token) => request('PUT', `/registry/tests/${id}`, data, token),
  approveTest: (id, comment, token) =>
    request('POST', `/registry/tests/${id}/approve`, { comment: comment || '' }, token),
  rejectTest: (id, comment, token) =>
    request('POST', `/registry/tests/${id}/reject`, { comment: comment || '' }, token),
  deleteTest: (id, token) => request('DELETE', `/registry/tests/${id}`, null, token),
};

export default api;
