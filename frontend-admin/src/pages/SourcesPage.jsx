import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import ConfirmDialog from '../components/ConfirmDialog';
import Modal from '../components/Modal';
import {
  CloudArrowDownIcon,
  ArrowPathIcon,
  TrashIcon,
  PlusIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DocumentTextIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  PlayIcon,
} from '@heroicons/react/24/outline';

function AddSourceModal({ open, onClose, onAdded }) {
  const { token } = useAuth();
  const [form, setForm] = useState({ repo_url: '', branch: 'main', subdirectory: '', name: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const payload = { repo_url: form.repo_url.trim(), branch: form.branch.trim() || 'main' };
      if (form.subdirectory.trim()) payload.subdirectory = form.subdirectory.trim();
      if (form.name.trim()) payload.name = form.name.trim();
      const result = await api.aggregateSource(payload, token);
      onAdded(result);
      setForm({ repo_url: '', branch: 'main', subdirectory: '', name: '' });
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  };

  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose} title="Add GitHub Source">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Repository URL <span className="text-red-500">*</span></label>
          <input
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            type="url"
            placeholder="https://github.com/org/repo"
            value={form.repo_url}
            onChange={e => setForm(f => ({ ...f, repo_url: e.target.value }))}
            required
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Branch</label>
            <input
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              type="text"
              placeholder="main"
              value={form.branch}
              onChange={e => setForm(f => ({ ...f, branch: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subdirectory <span className="text-gray-400 font-normal">(optional)</span></label>
            <input
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              type="text"
              placeholder="e.g. tests/"
              value={form.subdirectory}
              onChange={e => setForm(f => ({ ...f, subdirectory: e.target.value }))}
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Display Name <span className="text-gray-400 font-normal">(optional)</span></label>
          <input
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            type="text"
            placeholder="e.g. E2E Tests"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          />
        </div>
        {error && (
          <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 border border-red-200 rounded-md p-3">
            <ExclamationCircleIcon className="h-4 w-4 flex-shrink-0" />
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50">
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !form.repo_url}
            className="px-4 py-2 text-sm text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? <ArrowPathIcon className="h-4 w-4 animate-spin" /> : <CloudArrowDownIcon className="h-4 w-4" />}
            {saving ? 'Pulling...' : 'Pull & Import'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const API_BASE = import.meta.env.VITE_API_URL || `${window.location.protocol}//${window.location.hostname}:8000`;

function RunSpecModal({ open, onClose, spec, token }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [lightbox, setLightbox] = useState(null);
  const [baseUrl, setBaseUrl] = useState('https://');

  useEffect(() => {
    if (open) {
      setResult(null);
      setError('');
      setLightbox(null);
    }
  }, [spec?.path, open]);

  const handleRun = async () => {
    setRunning(true);
    setResult(null);
    setError('');
    try {
      const res = await api.runSpec(spec.path, baseUrl.trim() || null, token);
      setResult(res);
    } catch (err) {
      setError(err.message);
    }
    setRunning(false);
  };

  const screenshots = result?.artifacts?.screenshots?.map(p => `${API_BASE}/runner${p}`) || [];

  if (!open) return null;
  return (
    <>
      <Modal open={open} onClose={onClose} title={`Run: ${spec?.file}`}>
        <div className="space-y-4">
          <div className="bg-gray-50 rounded-md p-3 text-xs font-mono text-gray-600 break-all">
            {spec?.path}
          </div>

          {/* Base URL input */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Base URL <span className="text-gray-400 font-normal">(set as <code className="bg-gray-100 px-1 rounded">BASE_URL</code> for the spec)</span>
            </label>
            <input
              type="url"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="https://example.com"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              disabled={running}
            />
          </div>

          {!result && !error && (
            <p className="text-sm text-gray-500">Runs the spec headlessly in the runner container. A video recording will be available after the run.</p>
          )}

          {error && (
            <div className="flex items-start gap-2 text-red-600 text-sm bg-red-50 border border-red-200 rounded-md p-3">
              <ExclamationCircleIcon className="h-4 w-4 flex-shrink-0 mt-0.5" />
              {error}
            </div>
          )}

          {result && (
            <div className="space-y-3">
              {/* Summary bar */}
              <div className={`rounded-md px-3 py-2.5 text-sm border flex items-center gap-3 ${result.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
                {result.ok
                  ? <CheckCircleIcon className="h-5 w-5 flex-shrink-0" />
                  : <ExclamationCircleIcon className="h-5 w-5 flex-shrink-0" />}
                <span className="font-medium">{result.ok ? 'All tests passed' : 'Some tests failed'}</span>
                {result.report && (
                  <span className="ml-auto text-xs font-mono opacity-75">
                    {result.report.passed}/{(result.report.passed || 0) + (result.report.failed || 0)} passed
                    {result.report.duration_ms ? ` · ${(result.report.duration_ms / 1000).toFixed(1)}s` : ''}
                  </span>
                )}
              </div>

              {/* Per-test breakdown */}
              {result.report?.tests?.length > 0 && (
                <div className="border border-gray-200 rounded-md overflow-hidden">
                  <div className="bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-500 uppercase">Test Results</div>
                  <ul className="divide-y divide-gray-100">
                    {result.report.tests.map((t, i) => (
                      <li key={i} className="px-3 py-2">
                        <div className="flex items-start gap-2">
                          {t.status === 'passed'
                            ? <CheckCircleIcon className="h-4 w-4 text-green-500 flex-shrink-0 mt-0.5" />
                            : <ExclamationCircleIcon className="h-4 w-4 text-red-400 flex-shrink-0 mt-0.5" />}
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-gray-800 font-medium leading-snug">{t.title}</div>
                            {t.duration_ms > 0 && (
                              <div className="text-xs text-gray-400 mt-0.5">{(t.duration_ms / 1000).toFixed(2)}s</div>
                            )}
                            {t.error && (
                              <pre className="mt-1.5 text-xs text-red-700 bg-red-50 border border-red-100 rounded p-2 whitespace-pre-wrap break-all font-mono max-h-28 overflow-y-auto">
                                {t.error}
                              </pre>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Top-level error (e.g. compile error) */}
              {result.report?.error && !result.report?.tests?.length && (
                <pre className="text-xs text-red-700 bg-red-50 border border-red-100 rounded p-3 whitespace-pre-wrap break-all font-mono max-h-40 overflow-y-auto">
                  {result.report.error}
                </pre>
              )}

              {/* Video preview */}
              {result.artifacts?.videoUrl && (
                <div>
                  <div className="text-xs font-medium text-gray-500 uppercase mb-2">Video Recording</div>
                  <video
                    key={result.artifacts.videoUrl}
                    src={`${API_BASE}/runner${result.artifacts.videoUrl}`}
                    controls
                    autoPlay
                    loop
                    className="w-full rounded-md border border-gray-200 bg-black"
                    style={{ maxHeight: '280px' }}
                  />
                </div>
              )}

              {/* Screenshots */}
              {screenshots.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-gray-500 uppercase mb-2">Screenshots ({screenshots.length})</div>
                  <div className="grid grid-cols-2 gap-2">
                    {screenshots.map((url, i) => (
                      <button
                        key={i}
                        onClick={() => setLightbox(url)}
                        className="block rounded-md overflow-hidden border border-gray-200 hover:border-indigo-400 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      >
                        <img
                          src={url}
                          alt={`Screenshot ${i + 1}`}
                          className="w-full h-32 object-cover object-top"
                          onError={e => { e.target.style.display = 'none'; }}
                        />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50">
              Close
            </button>
            <button
              onClick={handleRun}
              disabled={running}
              className="px-4 py-2 text-sm text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
            >
              {running ? <ArrowPathIcon className="h-4 w-4 animate-spin" /> : <PlayIcon className="h-4 w-4" />}
              {running ? 'Running...' : result ? 'Run Again' : 'Run'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Lightbox for full-size screenshot */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox}
            alt="Screenshot"
            className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
            onClick={e => e.stopPropagation()}
          />
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white text-2xl font-bold leading-none"
            onClick={() => setLightbox(null)}
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}

function SourceRow({ source, onSync, onDelete }) {
  const { token } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [runSpec, setRunSpec] = useState(null);

  const handleSync = async () => {
    setSyncing(true);
    await onSync(source.source_id);
    setSyncing(false);
  };

  const repoShort = source.repo_url.replace('https://github.com/', '').replace('https://', '');

  return (
    <>
      <tr className="hover:bg-gray-50">
        <td className="px-4 py-3">
          <button
            onClick={() => setExpanded(e => !e)}
            className="flex items-center gap-2 text-sm font-medium text-gray-900"
          >
            {expanded
              ? <ChevronDownIcon className="h-4 w-4 text-gray-400" />
              : <ChevronRightIcon className="h-4 w-4 text-gray-400" />}
            {source.name}
          </button>
        </td>
        <td className="px-4 py-3 text-sm text-gray-500 max-w-xs">
          <a href={source.repo_url} target="_blank" rel="noopener noreferrer"
            className="text-indigo-600 hover:underline truncate block">{repoShort}</a>
        </td>
        <td className="px-4 py-3 text-sm text-gray-500">
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">
            {source.branch}
          </span>
        </td>
        <td className="px-4 py-3 text-sm text-gray-500">
          <span className="inline-flex items-center gap-1">
            <DocumentTextIcon className="h-4 w-4" />
            {source.spec_files?.length ?? 0}
          </span>
        </td>
        <td className="px-4 py-3 text-sm text-gray-500">
          <span className="font-mono text-xs">{source.commit_sha || '—'}</span>
        </td>
        <td className="px-4 py-3 text-sm text-gray-500">
          {source.synced_at ? new Date(source.synced_at).toLocaleString() : '—'}
        </td>
        <td className="px-4 py-3 text-right">
          <div className="flex justify-end gap-2">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="text-indigo-500 hover:text-indigo-700 disabled:opacity-40"
              title="Sync latest"
            >
              <ArrowPathIcon className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={() => onDelete(source.source_id)}
              className="text-red-400 hover:text-red-600"
              title="Delete source"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-gray-50">
          <td colSpan={7} className="px-8 pb-3 pt-1">
            <div className="text-xs font-medium text-gray-500 uppercase mb-2">Spec Files ({source.spec_files?.length ?? 0})</div>
            {source.spec_files?.length ? (
              <div className="space-y-1">
                {source.spec_files.map(file => (
                  <div key={file} className="flex items-center justify-between py-1 px-3 bg-white rounded border border-gray-200">
                    <span className="font-mono text-xs text-gray-700">{file}</span>
                    <button
                      onClick={() => setRunSpec({ file, path: `${source.specs_dir}/${file}` })}
                      className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                    >
                      <PlayIcon className="h-3 w-3" />
                      Run
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400 italic">No spec files found</p>
            )}
          </td>
        </tr>
      )}
      <RunSpecModal
        open={!!runSpec}
        onClose={() => setRunSpec(null)}
        spec={runSpec}
        token={token}
      />
    </>
  );
}

export default function SourcesPage() {
  const { token } = useAuth();
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [delTarget, setDelTarget] = useState(null);
  const [toast, setToast] = useState('');

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.listSources(token);
      setSources(data.sources || []);
    } catch { setSources([]); }
    setLoading(false);
  };

  useEffect(() => { load(); }, [token]);

  const handleAdded = (result) => {
    setAddOpen(false);
    showToast(`Imported ${result.source?.spec_files?.length ?? 0} spec files from ${result.source?.name}`);
    load();
  };

  const handleSync = async (sourceId) => {
    try {
      const result = await api.syncSource(sourceId, token);
      showToast(`Synced — ${result.added} added, ${result.removed} removed`);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDelete = async () => {
    if (!delTarget) return;
    try {
      await api.deleteSource(delTarget, token);
      showToast('Source deleted');
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Test Sources</h2>
          <p className="text-sm text-gray-500 mt-0.5">Pull Playwright specs from GitHub repos into the runner</p>
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-indigo-600 rounded-md hover:bg-indigo-700"
        >
          <PlusIcon className="h-4 w-4" />
          Add Source
        </button>
      </div>

      {/* Toast */}
      {toast && (
        <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-green-50 border border-green-200 text-green-800 text-sm rounded-md">
          <CheckCircleIcon className="h-4 w-4 flex-shrink-0" />
          {toast}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Repository</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Branch</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Specs</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Commit</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Synced</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {sources.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center">
                    <CloudArrowDownIcon className="h-8 w-8 text-gray-300 mx-auto mb-2" />
                    <p className="text-sm text-gray-500">No sources yet</p>
                    <p className="text-xs text-gray-400 mt-1">Click "Add Source" to pull specs from a GitHub repo</p>
                  </td>
                </tr>
              ) : (
                sources.map(source => (
                  <SourceRow
                    key={source.source_id}
                    source={source}
                    onSync={handleSync}
                    onDelete={setDelTarget}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <AddSourceModal open={addOpen} onClose={() => setAddOpen(false)} onAdded={handleAdded} />

      <ConfirmDialog
        open={!!delTarget}
        onClose={() => setDelTarget(null)}
        onConfirm={handleDelete}
        title="Delete Source"
        message="This will remove the source and all its spec files from the store. This action cannot be undone."
      />
    </div>
  );
}
