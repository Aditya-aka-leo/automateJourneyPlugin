import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import Modal from '../components/Modal';
import {
  PlusIcon,
  PencilIcon,
  ShieldCheckIcon,
  NoSymbolIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline';

const ROLES = ['write-only', 'read-write', 'read-write-approve', 'admin'];

const ROLE_COLORS = {
  'admin': 'bg-red-100 text-red-700',
  'read-write-approve': 'bg-amber-100 text-amber-700',
  'read-write': 'bg-blue-100 text-blue-700',
  'write-only': 'bg-gray-100 text-gray-600',
};

export default function UsersPage() {
  const { token, current } = useAuth();
  const [users, setUsers] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [accountProjects, setAccountProjects] = useState({});
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [roleUser, setRoleUser] = useState(null);
  const [expandedUser, setExpandedUser] = useState(null);
  const [allRoles, setAllRoles] = useState({});
  const [form, setForm] = useState({ email: '', name: '', password: '', account_id: '', project_id: '', role: 'read-write' });
  const [editForm, setEditForm] = useState({ name: '', password: '' });
  const [roleForm, setRoleForm] = useState({ account_id: '', project_id: '', role: 'read-write' });
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [u, a] = await Promise.all([
        api.listUsers(token),
        api.listAccounts(token),
      ]);
      setUsers(u.users || []);
      setAccounts(a.accounts || []);
    } catch { setUsers([]); }
    setLoading(false);
  };

  useEffect(() => { if (current) load(); }, [current, token]);

  // Load projects for a specific account (cached)
  const loadProjectsForAccount = async (accountSlug, accountId) => {
    if (accountProjects[accountId]) return accountProjects[accountId];
    try {
      // We need to be in the right context to list projects, so use a workaround
      // The listProjects API checks account_slug matches auth context
      // For now, use the projects from current context if matching, else try the API
      const data = await api.listProjects(accountSlug, token);
      const projects = data.projects || [];
      setAccountProjects(prev => ({ ...prev, [accountId]: projects }));
      return projects;
    } catch {
      return [];
    }
  };

  // Load all roles for a user (across all accounts)
  const loadUserRoles = async (userId) => {
    try {
      const data = await api.listUserRoles(userId, token);
      const roles = data.roles || [];
      setAllRoles(prev => ({ ...prev, [userId]: roles }));
      return roles;
    } catch {
      return [];
    }
  };

  const toggleExpand = async (userId) => {
    if (expandedUser === userId) {
      setExpandedUser(null);
    } else {
      setExpandedUser(userId);
      await loadUserRoles(userId);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const roles = [];
      if (form.account_id && form.project_id && form.role) {
        roles.push({ account_id: form.account_id, project_id: form.project_id, role: form.role });
      }
      await api.createUser({ email: form.email, name: form.name, password: form.password, roles }, token);
      setForm({ email: '', name: '', password: '', account_id: '', project_id: '', role: 'read-write' });
      setCreateOpen(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const data = {};
      if (editForm.name) data.name = editForm.name;
      if (editForm.password) data.password = editForm.password;
      await api.updateUser(editUser.id, data, token);
      setEditUser(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleToggleDisable = async (user) => {
    try {
      await api.updateUser(user.id, { disabled: !user.disabled_at ? true : false }, token);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleAddRole = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.addRole(
        roleUser.id,
        { account_id: roleForm.account_id, project_id: roleForm.project_id, role: roleForm.role },
        token
      );
      setRoleUser(null);
      // Refresh the expanded roles
      if (expandedUser === roleUser.id) {
        await loadUserRoles(roleUser.id);
      }
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRemoveRole = async (userId, roleId) => {
    try {
      await api.removeRole(userId, roleId, token);
      await loadUserRoles(userId);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  // When account changes in create form, load its projects
  const handleCreateAccountChange = async (accountId) => {
    setForm(f => ({ ...f, account_id: accountId, project_id: '' }));
    if (accountId) {
      const acc = accounts.find(a => a.id === accountId);
      if (acc) await loadProjectsForAccount(acc.slug, accountId);
    }
  };

  // When account changes in add-role form, load its projects
  const handleRoleAccountChange = async (accountId) => {
    setRoleForm(f => ({ ...f, account_id: accountId, project_id: '' }));
    if (accountId) {
      const acc = accounts.find(a => a.id === accountId);
      if (acc) await loadProjectsForAccount(acc.slug, accountId);
    }
  };

  const createFormProjects = accountProjects[form.account_id] || [];
  const roleFormProjects = accountProjects[roleForm.account_id] || [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Users</h2>
          <p className="text-sm text-gray-500">Account: {current?.account_name}</p>
        </div>
        <button
          onClick={() => {
            setCreateOpen(true);
            setError('');
            // Pre-select current account
            setForm(f => ({ ...f, account_id: current.account_id, project_id: current.project_id }));
            loadProjectsForAccount(current.account_slug, current.account_id);
          }}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700"
        >
          <PlusIcon className="h-4 w-4" /> New User
        </button>
      </div>

      {/* Users List */}
      <div className="space-y-3">
        {loading ? (
          <div className="text-center py-12 text-gray-500">Loading...</div>
        ) : users.length === 0 ? (
          <div className="text-center py-12 text-gray-500">No users found</div>
        ) : users.map((u) => (
          <div key={u.id} className={`bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden ${u.disabled_at ? 'opacity-60' : ''}`}>
            {/* User row */}
            <div className="px-6 py-4 flex items-center gap-4">
              <button onClick={() => toggleExpand(u.id)} className="text-gray-400 hover:text-gray-600 shrink-0">
                {expandedUser === u.id
                  ? <ChevronDownIcon className="h-4 w-4" />
                  : <ChevronRightIcon className="h-4 w-4" />}
              </button>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-900">{u.name}</span>
                  <span className="text-sm text-gray-400">{u.email}</span>
                  {u.disabled_at ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-600">
                      <NoSymbolIcon className="h-3 w-3" /> Disabled
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-600">
                      <CheckCircleIcon className="h-3 w-3" /> Active
                    </span>
                  )}
                </div>
                {/* Inline role summary */}
                <div className="flex flex-wrap gap-1 mt-1">
                  {(u.roles || []).map((r) => (
                    <span
                      key={r.role_id}
                      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ROLE_COLORS[r.role] || 'bg-gray-100 text-gray-700'}`}
                    >
                      {r.project_slug} &middot; {r.role}
                    </span>
                  ))}
                  {(!u.roles || u.roles.length === 0) && (
                    <span className="text-xs text-gray-400 italic">No roles assigned</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => { setEditUser(u); setEditForm({ name: u.name, password: '' }); setError(''); }}
                  className="p-1.5 text-gray-400 hover:text-indigo-600 rounded hover:bg-gray-100"
                  title="Edit user"
                >
                  <PencilIcon className="h-4 w-4" />
                </button>
                <button
                  onClick={() => {
                    setRoleUser(u);
                    setRoleForm({ account_id: current.account_id, project_id: '', role: 'read-write' });
                    loadProjectsForAccount(current.account_slug, current.account_id);
                    setError('');
                  }}
                  className="p-1.5 text-gray-400 hover:text-indigo-600 rounded hover:bg-gray-100"
                  title="Add role"
                >
                  <ShieldCheckIcon className="h-4 w-4" />
                </button>
                <button
                  onClick={() => handleToggleDisable(u)}
                  className={`p-1.5 rounded hover:bg-gray-100 ${u.disabled_at ? 'text-green-500 hover:text-green-700' : 'text-red-400 hover:text-red-600'}`}
                  title={u.disabled_at ? 'Enable user' : 'Disable user'}
                >
                  {u.disabled_at ? <CheckCircleIcon className="h-4 w-4" /> : <NoSymbolIcon className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Expanded: all roles across all accounts */}
            {expandedUser === u.id && (
              <div className="px-6 pb-4 pt-0 border-t border-gray-100 bg-gray-50">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mt-3 mb-2">
                  All Role Assignments
                </h4>
                {!allRoles[u.id] ? (
                  <p className="text-sm text-gray-400">Loading...</p>
                ) : allRoles[u.id].length === 0 ? (
                  <p className="text-sm text-gray-400 italic">No roles assigned</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-500 uppercase">
                        <th className="text-left py-1 pr-4">Account</th>
                        <th className="text-left py-1 pr-4">Project</th>
                        <th className="text-left py-1 pr-4">Role</th>
                        <th className="text-right py-1">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allRoles[u.id].map((r) => (
                        <tr key={r.role_id} className="border-t border-gray-200">
                          <td className="py-2 pr-4 text-gray-700">{r.account_name} <span className="text-gray-400 text-xs">({r.account_slug})</span></td>
                          <td className="py-2 pr-4 text-gray-700">{r.project_name} <span className="text-gray-400 text-xs">({r.project_slug})</span></td>
                          <td className="py-2 pr-4">
                            <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${ROLE_COLORS[r.role] || 'bg-gray-100 text-gray-700'}`}>
                              {r.role}
                            </span>
                          </td>
                          <td className="py-2 text-right">
                            <button
                              onClick={() => handleRemoveRole(u.id, r.role_id)}
                              className="text-xs text-red-500 hover:text-red-700 font-medium"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <button
                  onClick={() => {
                    setRoleUser(u);
                    setRoleForm({ account_id: current.account_id, project_id: '', role: 'read-write' });
                    loadProjectsForAccount(current.account_slug, current.account_id);
                    setError('');
                  }}
                  className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800"
                >
                  <PlusIcon className="h-3 w-3" /> Add Role Assignment
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Create User Modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create User">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email / Username</label>
            <input
              type="text"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Display Name</label>
            <input
              type="text"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>

          <div className="border-t border-gray-200 pt-4">
            <p className="text-sm font-medium text-gray-700 mb-3">Initial Role Assignment</p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Account</label>
                <select
                  value={form.account_id}
                  onChange={(e) => handleCreateAccountChange(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                >
                  <option value="">Select account...</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.slug})</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Project</label>
                <select
                  value={form.project_id}
                  onChange={(e) => setForm({ ...form, project_id: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                  disabled={!form.account_id}
                >
                  <option value="">Select project...</option>
                  {createFormProjects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.slug})</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Role</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                >
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end">
            <button type="submit" className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700">
              Create User
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit User Modal */}
      <Modal open={!!editUser} onClose={() => setEditUser(null)} title={`Edit: ${editUser?.name}`}>
        <form onSubmit={handleUpdate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Display Name</label>
            <input
              type="text"
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">New Password (leave blank to keep)</label>
            <input
              type="password"
              value={editForm.password}
              onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              placeholder="Leave blank to keep current"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end">
            <button type="submit" className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700">
              Save Changes
            </button>
          </div>
        </form>
      </Modal>

      {/* Add Role Modal */}
      <Modal open={!!roleUser} onClose={() => setRoleUser(null)} title={`Add Role: ${roleUser?.name}`}>
        <form onSubmit={handleAddRole} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Account</label>
            <select
              value={roleForm.account_id}
              onChange={(e) => handleRoleAccountChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              required
            >
              <option value="">Select account...</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.slug})</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Project</label>
            <select
              value={roleForm.project_id}
              onChange={(e) => setRoleForm({ ...roleForm, project_id: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              required
              disabled={!roleForm.account_id}
            >
              <option value="">Select project...</option>
              {roleFormProjects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.slug})</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
            <select
              value={roleForm.role}
              onChange={(e) => setRoleForm({ ...roleForm, role: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            >
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end">
            <button type="submit" className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700">
              Add Role
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
