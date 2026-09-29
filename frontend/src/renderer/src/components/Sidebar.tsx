import { useState, type ReactElement } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useNotifications } from '@renderer/notifications/NotificationContext'

interface NavItem {
  to: string
  label: string
  icon: string
  /** the same page can hold several entries: this one is active only for this view (Deep Space's solar system or its object browser) */
  view?: 'solar' | 'objects'
}

interface NavGroup {
  title: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Overview',
    items: [{ to: '/', label: 'Dashboard', icon: '▦' }]
  },
  {
    title: 'Capture',
    items: [
      { to: '/upload', label: 'Upload & Watch Folder', icon: '⬆' },
      { to: '/live', label: 'Live View', icon: '◈' }
    ]
  },
  {
    title: 'Identify',
    items: [
      { to: '/annotate', label: 'Annotate', icon: '✎' },
      { to: '/objects', label: 'Object Library', icon: '☁' },
      { to: '/train', label: 'Train', icon: '⚡' },
      { to: '/results', label: 'Results Gallery', icon: '▣' }
    ]
  },
  {
    title: 'Explore',
    items: [
      { to: '/sky-overlay', label: 'Sky Overlay', icon: '✧' },
      { to: '/deep-space?view=solar', label: 'Solar System', icon: '✺', view: 'solar' },
      { to: '/earth', label: 'Earth', icon: '◍' },
      { to: '/deep-space', label: 'Deep-Sky Objects', icon: '✧', view: 'objects' },
      { to: '/calendar', label: 'Sky Calendar', icon: '▤' },
      { to: '/star-classifier', label: 'Star Classifier', icon: '✦' },
      { to: '/map', label: 'Map', icon: '◉' }
    ]
  }
]

const BOTTOM_NAV_ITEMS: NavItem[] = [
  { to: '/notifications', label: 'Notifications', icon: '🔔' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
  { to: '/log', label: 'Log', icon: '≡' },
  { to: '/about', label: 'About', icon: 'ⓘ' }
]

const COLLAPSE_STORAGE_KEY = 'sidebar-collapsed'

function getInitialCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function NavRow({ item, collapsed }: { item: NavItem; collapsed: boolean }): ReactElement {
  const { unread } = useNotifications()
  const badge = item.to === '/notifications' && unread > 0 ? unread : 0
  const loc = useLocation()
  const solar = new URLSearchParams(loc.search).get('view') === 'solar'
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
          (item.view ? isActive && solar === (item.view === 'solar') : isActive)
            ? 'bg-accent-muted text-text'
            : 'text-text-muted hover:bg-surface-raised hover:text-text'
        }`
      }
    >
      <span className="relative w-4 text-center text-xs">
        {item.icon}
        {badge > 0 && collapsed && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-accent" />}
      </span>
      {!collapsed && item.label}
      {!collapsed && badge > 0 && <span className="ml-auto rounded-full bg-accent px-1.5 text-[10px] font-semibold text-bg">{badge > 99 ? '99+' : badge}</span>}
    </NavLink>
  )
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
      <div className="flex flex-1 flex-col overflow-y-auto px-2">
        {NAV_GROUPS.map((group, i) => (
          <div key={group.title} className={i > 0 ? 'mt-2 border-t border-border pt-2' : ''}>
            {!collapsed && (
              <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted/70">
                {group.title}
              </div>
            )}
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <NavRow key={item.to} item={item} collapsed={collapsed} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-col gap-0.5 border-t border-border px-2 py-2">
        {BOTTOM_NAV_ITEMS.map((item) => (
          <NavRow key={item.to} item={item} collapsed={collapsed} />
        ))}
      </div>
    </nav>
  )
}
