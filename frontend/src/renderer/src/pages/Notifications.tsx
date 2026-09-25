import type { ReactElement } from 'react'
import {
  CATEGORY_INFO,
  useNotifications,
  type NotificationCategory,
  type NotificationSettings
} from '@renderer/notifications/NotificationContext'

function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}): ReactElement {
  return (
    <label
      className={`flex items-start gap-3 py-2 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-[rgb(var(--color-accent))]"
      />
      <span>
        <span className="block text-sm text-text">{label}</span>
        {description && <span className="block text-xs text-text-muted">{description}</span>}
      </span>
    </label>
  )
}

const POSITIONS: { value: NotificationSettings['position']; label: string }[] = [
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-right', label: 'Bottom right' },
  { value: 'top-left', label: 'Top left' },
  { value: 'bottom-left', label: 'Bottom left' }
]

export function Notifications(): ReactElement {
  const { settings, setSettings, sendTest } = useNotifications()
  const patch = (p: Partial<NotificationSettings>): void => setSettings({ ...settings, ...p })
  const off = !settings.enabled

  return (
    <div className="flex h-full flex-col overflow-y-auto p-8">
      <h1 className="text-xl font-semibold text-text">Notifications</h1>
      <section className="mt-6 max-w-2xl">
      <p className="mt-1 text-xs text-text-muted">
        Get told when long-running work finishes, in the app and/or as a Windows notification.
      </p>

      <div className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface px-4">
        <Toggle
          label="Enable notifications"
          checked={settings.enabled}
          onChange={(enabled) => patch({ enabled })}
        />

        <div className="py-2">
          <div className="pt-1 text-xs font-medium uppercase tracking-wide text-text-muted">Delivery</div>
          <Toggle
            label="In-app pop-ups"
            description="Small toasts shown inside the window"
            checked={settings.inApp}
            disabled={off}
            onChange={(inApp) => patch({ inApp })}
          />
          <Toggle
            label="Windows notifications"
            description="Native Windows toasts that appear in the notification area"
            checked={settings.windows}
            disabled={off}
            onChange={(windows) => patch({ windows })}
          />
          <div className="pl-7">
            <Toggle
              label="Only when the app isn't in focus"
              checked={settings.windowsOnlyWhenUnfocused}
              disabled={off || !settings.windows}
              onChange={(windowsOnlyWhenUnfocused) => patch({ windowsOnlyWhenUnfocused })}
            />
            <Toggle
              label="Play notification sound"
              checked={settings.sound}
              disabled={off || !settings.windows}
              onChange={(sound) => patch({ sound })}
            />
          </div>
        </div>

        <div className="py-2">
          <div className="pt-1 text-xs font-medium uppercase tracking-wide text-text-muted">
            Notify me about
          </div>
          {(Object.keys(CATEGORY_INFO) as NotificationCategory[]).map((key) => (
            <Toggle
              key={key}
              label={CATEGORY_INFO[key].label}
              description={CATEGORY_INFO[key].description}
              checked={settings.categories[key]}
              disabled={off}
              onChange={(v) => patch({ categories: { ...settings.categories, [key]: v } })}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-6 py-3">
          <label className="flex items-center gap-2 text-xs text-text-muted">
            Pop-up position
            <select
              value={settings.position}
              disabled={off || !settings.inApp}
              onChange={(e) => patch({ position: e.target.value as NotificationSettings['position'] })}
              className="rounded-md border border-border bg-bg px-2 py-1 text-text disabled:opacity-50"
            >
              {POSITIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-text-muted">
            Show for
            <input
              type="range"
              min={2}
              max={20}
              value={settings.durationSec}
              disabled={off || !settings.inApp}
              onChange={(e) => patch({ durationSec: Number(e.target.value) })}
              className="disabled:opacity-50"
            />
            <span className="w-8 text-text">{settings.durationSec}s</span>
          </label>
          <button
            onClick={sendTest}
            className="ml-auto rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:border-accent hover:text-text"
          >
            Send test notification
          </button>
        </div>
      </div>
      </section>
    </div>
  )
}
