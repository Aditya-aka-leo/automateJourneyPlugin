import { NavLink } from 'react-router-dom';
import {
  HomeIcon,
  BuildingOfficeIcon,
  FolderIcon,
  UsersIcon,
  BeakerIcon,
  CloudArrowDownIcon,
} from '@heroicons/react/24/outline';

const links = [
  { to: '/', icon: HomeIcon, label: 'Dashboard' },
  { to: '/accounts', icon: BuildingOfficeIcon, label: 'Accounts' },
  { to: '/projects', icon: FolderIcon, label: 'Projects' },
  { to: '/users', icon: UsersIcon, label: 'Users' },
  { to: '/tests', icon: BeakerIcon, label: 'Tests' },
  { to: '/sources', icon: CloudArrowDownIcon, label: 'Sources' },
];

export default function Sidebar() {
  return (
    <aside className="w-56 bg-gray-900 text-gray-300 flex flex-col min-h-screen">
      <div className="px-5 py-5 border-b border-gray-700">
        <h1 className="text-lg font-bold text-white tracking-tight">Autotest Admin</h1>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1">
        {links.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-gray-800 text-white'
                  : 'hover:bg-gray-800 hover:text-white'
              }`
            }
          >
            <Icon className="h-5 w-5" />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
