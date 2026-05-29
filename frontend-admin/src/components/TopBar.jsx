import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  ArrowRightStartOnRectangleIcon,
  ChevronDownIcon,
  KeyIcon,
} from '@heroicons/react/24/outline';
import Modal from './Modal';
import api from '../api';

export default function TopBar() {
  const { user, current, roles, token, logout, switchContext } = useAuth();
  const [ctxOpen, setCtxOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [pwForm, setPwForm] = useState({ current: '', newPw: '', confirm: '' });
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');

  const handleSwitch = async (r) => {
    try {
      await switchContext(r.account_id, r.project_id);
      setCtxOpen(false);
    } catch (e) {
      alert(e.message);
    }
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    setPwError('');
    setPwSuccess('');
    if (pwForm.newPw !== pwForm.confirm) {
      setPwError('Passwords do not match');
      return;
    }
    if (pwForm.newPw.length < 3) {
      setPwError('Password too short');
      return;
    }
    try {
      await api.changePassword(pwForm.current, pwForm.newPw, token);
      setPwSuccess('Password changed successfully');
      setPwForm({ current: '', newPw: '', confirm: '' });
      setTimeout(() => setPwOpen(false), 1000);
    } catch (err) {
      setPwError(err.message);
    }
  };

  return (
    <>
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {current && (
            <div className="relative">
              <button
                onClick={() => setCtxOpen(!ctxOpen)}
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
              >
                <span className="text-gray-900">{current.account_name}</span>
                <span className="text-gray-400">/</span>
                <span className="text-gray-700">{current.project_name}</span>
                <ChevronDownIcon className="h-4 w-4 text-gray-500" />
              </button>
              {ctxOpen && (
                <div className="absolute top-full left-0 mt-1 w-72 bg-white rounded-md shadow-lg border border-gray-200 z-50 max-h-64 overflow-y-auto">
                  {roles.map((r, i) => (
                    <button
                      key={i}
                      onClick={() => handleSwitch(r)}
                      className={`w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex justify-between items-center ${
                        r.account_id === current.account_id && r.project_id === current.project_id
                          ? 'bg-indigo-50 text-indigo-700'
                          : 'text-gray-700'
                      }`}
                    >
                      <span>
                        {r.account_name} / {r.project_name}
                      </span>
                      <span className="text-xs text-gray-400">{r.role}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {current && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-100 text-indigo-700">
              {current.role}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {user && <span className="text-sm text-gray-600">{user.name}</span>}
          <button
            onClick={() => { setPwOpen(true); setPwError(''); setPwSuccess(''); }}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100"
            title="Change Password"
          >
            <KeyIcon className="h-5 w-5" />
          </button>
          <button
            onClick={logout}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100"
            title="Logout"
          >
            <ArrowRightStartOnRectangleIcon className="h-5 w-5" />
          </button>
        </div>
      </header>

      <Modal open={pwOpen} onClose={() => setPwOpen(false)} title="Change Password">
        <form onSubmit={handlePasswordChange} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Current Password</label>
            <input
              type="password"
              required
              value={pwForm.current}
              onChange={(e) => setPwForm({ ...pwForm, current: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
            <input
              type="password"
              required
              value={pwForm.newPw}
              onChange={(e) => setPwForm({ ...pwForm, newPw: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Confirm New Password</label>
            <input
              type="password"
              required
              value={pwForm.confirm}
              onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>
          {pwError && <p className="text-sm text-red-600">{pwError}</p>}
          {pwSuccess && <p className="text-sm text-green-600">{pwSuccess}</p>}
          <div className="flex justify-end">
            <button
              type="submit"
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700"
            >
              Change Password
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
