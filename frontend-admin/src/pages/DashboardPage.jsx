import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import {
  BuildingOfficeIcon,
  FolderIcon,
  UsersIcon,
  BeakerIcon,
} from '@heroicons/react/24/outline';

export default function DashboardPage() {
  const { user, current, token } = useAuth();
  const [stats, setStats] = useState({ projects: 0, users: 0, pendingTests: 0 });

  useEffect(() => {
    if (!current) return;
    Promise.all([
      api.listProjects(current.account_slug, token).catch(() => ({ projects: [] })),
      api.listUsers(token).catch(() => ({ users: [] })),
      api.listTests(token).catch(() => ({ tests: [] })),
    ]).then(([p, u, t]) => {
      setStats({
        projects: p.projects?.length || 0,
        users: u.users?.length || 0,
        pendingTests: (t.tests || []).filter((x) => x.status === 'pending').length,
      });
    });
  }, [current, token]);

  const cards = [
    { label: 'Account', value: current?.account_name || '-', icon: BuildingOfficeIcon, color: 'bg-blue-500' },
    { label: 'Projects', value: stats.projects, icon: FolderIcon, color: 'bg-green-500' },
    { label: 'Users', value: stats.users, icon: UsersIcon, color: 'bg-purple-500' },
    { label: 'Pending Tests', value: stats.pendingTests, icon: BeakerIcon, color: 'bg-amber-500' },
  ];

  return (
    <div>
      <h2 className="text-xl font-semibold text-gray-900 mb-6">Dashboard</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
            <div className="flex items-center gap-3">
              <div className={`${color} p-2 rounded-lg`}>
                <Icon className="h-5 w-5 text-white" />
              </div>
              <div>
                <p className="text-sm text-gray-500">{label}</p>
                <p className="text-xl font-semibold text-gray-900">{value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h3 className="text-sm font-medium text-gray-500 mb-3">Current Context</h3>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-gray-500">User</dt>
            <dd className="font-medium text-gray-900">{user?.name} ({user?.email})</dd>
          </div>
          <div>
            <dt className="text-gray-500">Role</dt>
            <dd className="font-medium text-gray-900">{current?.role}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Account</dt>
            <dd className="font-medium text-gray-900">{current?.account_name} ({current?.account_slug})</dd>
          </div>
          <div>
            <dt className="text-gray-500">Project</dt>
            <dd className="font-medium text-gray-900">{current?.project_name} ({current?.project_slug})</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
