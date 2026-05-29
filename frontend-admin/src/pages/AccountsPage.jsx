import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import Modal from '../components/Modal';
import { PlusIcon, ArrowsRightLeftIcon } from '@heroicons/react/24/outline';

export default function AccountsPage() {
  const { token, current, roles, switchContext, refreshRoles } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ slug: '', name: '' });
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.listAccounts(token);
      setAccounts(data.accounts || []);
    } catch { setAccounts([]); }
    setLoading(false);
  };

  useEffect(() => { load(); }, [token]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.createAccount(form.slug, form.name, token);
      await refreshRoles();
      setForm({ slug: '', name: '' });
      setModalOpen(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSwitch = async (acc) => {
    try {
      // Find a role the user has for this account to get a valid project_id
      const role = roles.find((r) => r.account_id === acc.id);
      if (role) {
        await switchContext(acc.id, role.project_id);
      } else {
        alert('No role found for this account. Assign a role first.');
      }
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Accounts</h2>
        <button
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700"
        >
          <PlusIcon className="h-4 w-4" /> New Account
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Slug</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr><td colSpan={4} className="px-6 py-8 text-center text-sm text-gray-500">Loading...</td></tr>
            ) : accounts.length === 0 ? (
              <tr><td colSpan={4} className="px-6 py-8 text-center text-sm text-gray-500">No accounts found</td></tr>
            ) : accounts.map((acc) => (
              <tr key={acc.id} className={acc.id === current?.account_id ? 'bg-indigo-50' : ''}>
                <td className="px-6 py-4 text-sm font-medium text-gray-900">{acc.name}</td>
                <td className="px-6 py-4 text-sm text-gray-500 font-mono">{acc.slug}</td>
                <td className="px-6 py-4 text-sm text-gray-500">{new Date(acc.created_at).toLocaleString()}</td>
                <td className="px-6 py-4 text-right">
                  {acc.id !== current?.account_id && (
                    <button
                      onClick={() => handleSwitch(acc)}
                      className="inline-flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-800"
                    >
                      <ArrowsRightLeftIcon className="h-4 w-4" /> Switch
                    </button>
                  )}
                  {acc.id === current?.account_id && (
                    <span className="text-xs text-indigo-600 font-medium">Current</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Create Account">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Account Name</label>
            <input
              type="text"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-indigo-500 focus:border-indigo-500"
              placeholder="My Organization"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Slug</label>
            <input
              type="text"
              required
              pattern="[a-z0-9-]+"
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:ring-indigo-500 focus:border-indigo-500"
              placeholder="my-org"
            />
            <p className="mt-1 text-xs text-gray-400">Lowercase letters, numbers, and hyphens only</p>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end">
            <button
              type="submit"
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700"
            >
              Create Account
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
