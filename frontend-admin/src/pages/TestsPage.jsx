import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import ConfirmDialog from '../components/ConfirmDialog';
import {
  CheckCircleIcon,
  XCircleIcon,
  TrashIcon,
  ClockIcon,
  EyeIcon,
} from '@heroicons/react/24/outline';

export default function TestsPage() {
  const navigate = useNavigate();
  const { token, current } = useAuth();
  const [tests, setTests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [delTarget, setDelTarget] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.listTests(token);
      setTests(data.tests || []);
    } catch { setTests([]); }
    setLoading(false);
  };

  useEffect(() => { load(); }, [current, token]);

  const handleApprove = async (id) => {
    try {
      await api.approveTest(id, '', token);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleReject = async (id) => {
    try {
      await api.rejectTest(id, '', token);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDelete = async () => {
    if (!delTarget) return;
    try {
      await api.deleteTest(delTarget, token);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const pending = tests.filter((t) => t.status === 'pending');
  const approved = tests.filter((t) => t.status === 'approved');

  const renderTable = (items, title, showApproval) => (
    <div className="mb-8">
      <h3 className="text-lg font-medium text-gray-900 mb-3">
        {title} <span className="text-sm text-gray-400">({items.length})</span>
      </h3>
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Test Name</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Target URL</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {items.length === 0 ? (
              <tr><td colSpan={4} className="px-6 py-8 text-center text-sm text-gray-500">No tests</td></tr>
            ) : items.map((t) => (
              <tr key={t.test_id}>
                <td className="px-6 py-4 text-sm font-medium text-gray-900">
                  <div className="flex items-center gap-2">
                    {t.status === 'pending' ? (
                      <ClockIcon className="h-4 w-4 text-amber-500" />
                    ) : (
                      <CheckCircleIcon className="h-4 w-4 text-green-500" />
                    )}
                    <button
                      onClick={() => navigate(`/tests/${t.test_id}`)}
                      className="text-indigo-600 hover:text-indigo-800 hover:underline text-left"
                    >
                      {t.test_name || t.filename}
                    </button>
                  </div>
                </td>
                <td className="px-6 py-4 text-sm text-gray-500 max-w-xs truncate">{t.target_url || '-'}</td>
                <td className="px-6 py-4 text-sm text-gray-500">
                  {t.created_at ? new Date(t.created_at).toLocaleString() : '-'}
                </td>
                <td className="px-6 py-4 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => navigate(`/tests/${t.test_id}`)}
                      className="text-indigo-500 hover:text-indigo-700"
                      title="View Details"
                    >
                      <EyeIcon className="h-5 w-5" />
                    </button>
                    {showApproval && (
                      <>
                        <button
                          onClick={() => handleApprove(t.test_id)}
                          className="text-green-500 hover:text-green-700"
                          title="Approve"
                        >
                          <CheckCircleIcon className="h-5 w-5" />
                        </button>
                        <button
                          onClick={() => handleReject(t.test_id)}
                          className="text-amber-500 hover:text-amber-700"
                          title="Reject"
                        >
                          <XCircleIcon className="h-5 w-5" />
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => setDelTarget(t.test_id)}
                      className="text-red-500 hover:text-red-700"
                      title="Delete"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Tests</h2>
        <p className="text-sm text-gray-500">
          {current?.account_name} / {current?.project_name}
        </p>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : (
        <>
          {renderTable(pending, 'Pending', true)}
          {renderTable(approved, 'Approved', false)}
        </>
      )}

      <ConfirmDialog
        open={!!delTarget}
        onClose={() => setDelTarget(null)}
        onConfirm={handleDelete}
        title="Delete Test"
        message="Are you sure you want to delete this test? This action cannot be undone."
      />
    </div>
  );
}
