import { useState, type ReactElement } from 'react'
import { NavLink } from 'react-router-dom'

interface NavItem {
  to: string
  label: string
  icon: string
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: '▦' },
  { to: '/upload', label: 'Upload & Watch Folder', icon: '⬆' },
  { to: '/live', label: 'Live View', icon: '◈' },
  { to: '/annotate', label: 'Annotate', icon: '✎' },
  { to: '/objects', label: 'Object Library', icon: '☁' },
  { to: '/train', label: 'Train', icon: '⚡' },
  { to: '/results', label: 'Results Gallery', icon: '▣' },
  { to: '/sky-overlay', label: 'Sky Overlay', icon: '✧' },
  { to: '/deep-space', label: 'Deep Space', icon: '✺' },
  { to: '/star-classifier', label: 'Star Classifier', icon: '✦' },
  { to: '/map', label: 'Map', icon: '◉' }
]

const BOTTOM_NAV_ITEMS: NavItem[] = [
  { to: '/notifications', label: 'Notifications', icon: '🔔' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
  { to: '/log', label: 'Log', icon: '≡' }
]

const COLLAPSE_STORAGE_KEY = 'sidebar-collapsed'

function getInitialCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function Sidebar(): ReactElement {
  const [collapsed, setCollapsed] = useState(getInitialCollapsed)

  const toggleCollapsed = (): void => {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next))
      } catch {
        // ignore storage failures (e.g. private mode)
      }
      return next
    })
  }

  return (
    <nav
      className={`flex h-full shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-150 ${
        collapsed ? 'w-14' : 'w-56'
      }`}
    >
      <div className="flex items-center gap-2 px-4 py-4">
        <span className="text-lg text-accent">{'✦'}</span>
        {!collapsed && (
          <span className="flex-1 text-sm font-semibold tracking-wide text-text">
            Night Identifier
          </span>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`flex h-[1.9375rem] w-[1.9375rem] items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-raised hover:text-text ${
            collapsed ? 'mx-auto' : ''
          }`}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            title={collapsed ? item.label : undefined}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'bg-accent-muted text-text'
                  : 'text-text-muted hover:bg-surface-raised hover:text-text'
              }`
            }
          >
            <span className="w-4 text-center text-xs">{item.icon}</span>
            {!collapsed && item.label}
          </NavLink>
        ))}
      </div>
      <div className="mt-2 flex flex-col gap-0.5 border-t border-border px-2 py-2">
        {BOTTOM_NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            title={collapsed ? item.label : undefined}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'bg-accent-muted text-text'
                  : 'text-text-muted hover:bg-surface-raised hover:text-text'
              }`
            }
          >
            <span className="w-4 text-center text-xs">{item.icon}</span>
            {!collapsed && item.label}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
