import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import {
  ArrowLeftIcon,
  CheckCircleIcon,
  ClockIcon,
  PencilSquareIcon,
  DocumentTextIcon,
  ListBulletIcon,
  CodeBracketIcon,
} from '@heroicons/react/24/outline';

// ---------------------------------------------------------------------------
// Lightweight Playwright spec → steps parser (runs client-side)
// ---------------------------------------------------------------------------
function parseStepsFromSpec(specCode) {
  if (!specCode) return [];
  const lines = specCode.split('\n');
  const steps = [];
  let stepIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('//') || line.startsWith('import ') || line.startsWith('const ') ||
        line.startsWith('test(') || line.startsWith('test.') || line.startsWith('});') ||
        line === '{' || line === '}') continue;

    let type = 'unknown';
    let description = line;

    if (/page\.goto\s*\(/.test(line)) {
      type = 'navigate';
      const m = line.match(/page\.goto\s*\(\s*['"`]([^'"`]+)['"`]/);
      description = m ? `Navigate to ${m[1]}` : line;
    } else if (/\.click\s*\(/.test(line)) {
      type = 'click';
      const m = line.match(/\.(?:getBy\w+|locator)\s*\(\s*['"`]([^'"`]+)['"`]/);
      description = m ? `Click "${m[1]}"` : line;
    } else if (/\.fill\s*\(/.test(line)) {
      type = 'fill';
      const m = line.match(/\.fill\s*\(\s*['"`]([^'"`]*)['"`]/);
      description = m ? `Fill with "${m[1]}"` : line;
    } else if (/\.type\s*\(/.test(line)) {
      type = 'type';
      description = line;
    } else if (/\.press\s*\(/.test(line)) {
      type = 'keypress';
      const m = line.match(/\.press\s*\(\s*['"`]([^'"`]+)['"`]/);
      description = m ? `Press "${m[1]}"` : line;
    } else if (/expect\s*\(/.test(line)) {
      type = 'assertion';
      description = line;
    } else if (/\.selectOption\s*\(/.test(line)) {
      type = 'select';
      description = line;
    } else if (/\.check\s*\(/.test(line) || /\.uncheck\s*\(/.test(line)) {
      type = 'checkbox';
      description = line;
    } else if (/\.hover\s*\(/.test(line)) {
      type = 'hover';
      description = line;
    } else if (/waitFor/.test(line) || /\.wait/.test(line)) {
      type = 'wait';
      description = line;
    } else if (/await\s+page\./.test(line) || /await\s+\w+\./.test(line)) {
      type = 'action';
      description = line;
    } else {
      continue; // skip non-action lines
    }

    steps.push({ index: stepIndex++, type, description, line: i + 1 });
  }
  return steps;
}

const TYPE_COLORS = {
  navigate: 'bg-blue-100 text-blue-700',
  click: 'bg-green-100 text-green-700',
  fill: 'bg-purple-100 text-purple-700',
  type: 'bg-purple-100 text-purple-700',
  keypress: 'bg-indigo-100 text-indigo-700',
  assertion: 'bg-amber-100 text-amber-700',
  select: 'bg-teal-100 text-teal-700',
  checkbox: 'bg-teal-100 text-teal-700',
  hover: 'bg-pink-100 text-pink-700',
  wait: 'bg-gray-100 text-gray-600',
  action: 'bg-gray-100 text-gray-700',
  unknown: 'bg-gray-100 text-gray-500',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function TestDetailPage() {
  const { testId } = useParams();
  const navigate = useNavigate();
  const { token } = useAuth();

  const [test, setTest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('steps'); // steps | script
  const [editing, setEditing] = useState(false);
  const [editCode, setEditCode] = useState('');
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getTest(testId, token);
      setTest(data);
      setEditCode(data.spec_code || '');
      setEditName(data.test_name || '');
      setEditUrl(data.target_url || '');
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [testId, token]);

  const steps = test ? parseStepsFromSpec(test.spec_code) : [];

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      const payload = {};
      if (editCode !== test.spec_code) payload.spec_code = editCode;
      if (editName !== test.test_name) payload.test_name = editName;
      if (editUrl !== test.target_url) payload.target_url = editUrl;

      if (Object.keys(payload).length === 0) {
        setSaveMsg('No changes to save');
        setSaving(false);
        return;
      }

      await api.updateTest(testId, payload, token);
      setSaveMsg('Saved successfully');
      setEditing(false);
      await load();
    } catch (err) {
      setSaveMsg(`Error: ${err.message}`);
    }
    setSaving(false);
  };

  const handleApprove = async () => {
    try {
      await api.approveTest(testId, '', token);
      await load();
    } catch (err) { alert(err.message); }
  };

  const handleReject = async () => {
    try {
      await api.rejectTest(testId, '', token);
      navigate('/tests');
    } catch (err) { alert(err.message); }
  };

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;
  if (error) return (
    <div className="text-center py-12">
      <p className="text-red-500 mb-4">{error}</p>
      <button onClick={() => navigate('/tests')} className="text-indigo-600 hover:underline">Back to Tests</button>
    </div>
  );
  if (!test) return null;

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <button
          onClick={() => navigate('/tests')}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-3"
        >
          <ArrowLeftIcon className="h-4 w-4" /> Back to Tests
        </button>
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              {test.status === 'pending' ? (
                <ClockIcon className="h-5 w-5 text-amber-500" />
              ) : (
                <CheckCircleIcon className="h-5 w-5 text-green-500" />
              )}
              {editing ? (
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="text-xl font-semibold text-gray-900 border border-gray-300 rounded px-2 py-1"
                />
              ) : (
                <h2 className="text-xl font-semibold text-gray-900">{test.test_name || test.filename}</h2>
              )}
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                test.status === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'
              }`}>
                {test.status}
              </span>
            </div>
            <div className="mt-1 text-sm text-gray-500 flex flex-wrap gap-4">
              {editing ? (
                <label className="flex items-center gap-1">
                  <span>URL:</span>
                  <input
                    value={editUrl}
                    onChange={(e) => setEditUrl(e.target.value)}
                    className="border border-gray-300 rounded px-2 py-0.5 text-sm w-80"
                  />
                </label>
              ) : (
                test.target_url && <span>URL: <span className="text-gray-700">{test.target_url}</span></span>
              )}
              {test.created_at && <span>Created: {new Date(test.created_at).toLocaleString()}</span>}
              {steps.length > 0 && <span>{steps.length} steps</span>}
            </div>
            {test.prompt && (
              <div className="mt-2 text-sm text-gray-500">
                <span className="font-medium text-gray-600">Prompt:</span> {test.prompt}
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {test.status === 'pending' && !editing && (
              <>
                <button onClick={handleApprove} className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700">
                  Approve
                </button>
                <button onClick={handleReject} className="px-3 py-1.5 text-sm bg-amber-500 text-white rounded-lg hover:bg-amber-600">
                  Reject
                </button>
              </>
            )}
            {!editing ? (
              <button
                onClick={() => setEditing(true)}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
              >
                <PencilSquareIcon className="h-4 w-4" /> Edit
              </button>
            ) : (
              <>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => {
                    setEditing(false);
                    setEditCode(test.spec_code || '');
                    setEditName(test.test_name || '');
                    setEditUrl(test.target_url || '');
                    setSaveMsg('');
                  }}
                  className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
        {saveMsg && (
          <div className={`mt-2 text-sm ${saveMsg.startsWith('Error') ? 'text-red-500' : 'text-green-600'}`}>
            {saveMsg}
          </div>
        )}
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        <button
          onClick={() => setActiveTab('steps')}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            activeTab === 'steps'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          <ListBulletIcon className="h-4 w-4" /> Steps ({steps.length})
        </button>
        <button
          onClick={() => setActiveTab('script')}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            activeTab === 'script'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          <CodeBracketIcon className="h-4 w-4" /> Playwright Script
        </button>
      </div>

      {/* Steps tab */}
      {activeTab === 'steps' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          {steps.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-gray-500">
              No steps could be parsed from the spec file
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {steps.map((step) => (
                <div key={step.index} className="flex items-start gap-3 px-4 py-3 hover:bg-gray-50">
                  <span className="flex-shrink-0 w-7 h-7 rounded-full bg-gray-100 text-gray-500 text-xs font-medium flex items-center justify-center mt-0.5">
                    {step.index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${TYPE_COLORS[step.type] || TYPE_COLORS.unknown}`}>
                        {step.type}
                      </span>
                      <span className="text-xs text-gray-400">line {step.line}</span>
                    </div>
                    <code className="text-sm text-gray-800 break-all">{step.description}</code>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Script tab */}
      {activeTab === 'script' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          {editing ? (
            <textarea
              value={editCode}
              onChange={(e) => setEditCode(e.target.value)}
              className="w-full h-[600px] p-4 font-mono text-sm text-gray-800 bg-gray-50 border-0 focus:outline-none resize-y"
              spellCheck={false}
            />
          ) : (
            <pre className="p-4 overflow-auto max-h-[600px]">
              <code className="text-sm text-gray-800">
                {test.spec_code || '(empty)'}
              </code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
