import { useEffect, useState, type ReactElement } from 'react'
import { api } from '@renderer/lib/api'
import { usePlace } from '@renderer/components/dashboard/usePlace'
import {
  CATEGORY_INFO,
  GROUP_ORDER,
  goToRoute,
  useNotifications,
  type DeliveryOverride,
  type NotificationCategory,
  type NotificationParams,
  type NotificationSettings
} from '@renderer/notifications/NotificationContext'

import { usePageState } from '@renderer/lib/pageState'
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
    <label className={`flex items-start gap-3 py-2 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[rgb(var(--color-accent))]" />
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

const field = 'rounded-md border border-border bg-bg px-2 py-1 text-xs text-text disabled:opacity-50'

/** The numbers each type can be tuned with. */
interface ParamField {
  key: keyof NotificationParams
  label: string
  kind: 'number' | 'checkbox' | 'select'
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: { value: number; label: string }[]
}

const PARAM_FIELDS: Partial<Record<NotificationCategory, ParamField[]>> = {
  issPass: [
    { key: 'issLeadMin', label: 'Tell me this long before it rises', kind: 'number', min: 1, max: 60, unit: 'min' },
    { key: 'issMinElevation', label: 'Only passes that climb higher than', kind: 'number', min: 5, max: 80, unit: '°' },
    { key: 'issVisibleOnly', label: 'Only passes I could actually see (the ISS in sunlight, you in twilight or dark)', kind: 'checkbox' }
  ],
  lightningNear: [
    {
      key: 'lightningKm',
      label: 'Lightning closer than',
      kind: 'select',
      options: [10, 25, 50, 100, 250].map((v) => ({ value: v, label: `${v} km` }))
    },
    { key: 'lightningCooldownMin', label: 'Then stay quiet for', kind: 'number', min: 5, max: 240, unit: 'min' }
  ],
  stormApproaching: [
    { key: 'stormKm', label: 'Warn when the storm is within', kind: 'number', min: 40, max: 300, step: 10, unit: 'km' },
    { key: 'stormMinSpeedKmH', label: 'and closing in faster than', kind: 'number', min: 5, max: 80, unit: 'km/h' }
  ],
  clearNight: [
    {
      key: 'clearNightLeadMin',
      label: 'Send it',
      kind: 'select',
      options: [
        { value: 0, label: 'at sunset' },
        { value: 30, label: '30 min before sunset' },
        { value: 60, label: '1 hour before sunset' },
        { value: 120, label: '2 hours before sunset' }
      ]
    },
    { key: 'clearNightMaxCloud', label: 'Clear means at most', kind: 'number', min: 5, max: 70, step: 5, unit: '% cloud while dark' }
  ],
  auroraChance: [{ key: 'auroraChancePct', label: 'Tell me when the chance over me reaches', kind: 'number', min: 3, max: 90, step: 1, unit: '% (and it is dark). Again only after it has dropped and come back, at least 3 hours later' }],
  solarFlare: [{ key: 'flareMinM', label: 'Tell me for flares of at least', kind: 'number', min: 1, max: 100, step: 1, unit: 'in M-class units (1 = M1, 5 = M5, 10 = X1, 50 = X5)' }],
  bzSouth: [{ key: 'bzSouthNt', label: 'Tell me when Bz stays below minus', kind: 'number', min: 4, max: 30, step: 1, unit: 'nT for 15 minutes (aurora fuel). Again only after it has eased and 3 hours have passed' }],
  dstStorm: [{ key: 'dstStormNt', label: 'Tell me when Dst reaches minus', kind: 'number', min: 30, max: 300, step: 10, unit: 'nT (50 = moderate storm, 100 = intense)' }],
  skyEvent: [
    { key: 'eventLeadH', label: 'Remind me', kind: 'number', min: 1, max: 24, step: 1, unit: 'hours before the best moment to look' },
    { key: 'eventMinScore', label: 'Only when the conditions score at least', kind: 'number', min: 0, max: 100, step: 5, unit: 'out of 100 (cloud, Moon, darkness; events you marked yourself always remind)' }
  ],
  geomagneticStorm: [{ key: 'stormKp', label: 'Tell me when Kp reaches', kind: 'number', min: 4, max: 9, step: 1, unit: '(5 = minor storm, G1)' }],
  cameraHealth: [
    { key: 'batteryPct', label: 'Battery low at', kind: 'number', min: 5, max: 60, unit: '%' },
    { key: 'shotsLeft', label: 'Memory card nearly full at', kind: 'number', min: 10, max: 2000, step: 10, unit: 'shots left' }
  ],
  quakeNear: [
    { key: 'quakeNearMag', label: 'Earthquakes of at least', kind: 'select', options: [2, 2.5, 3, 3.5, 4, 5, 6].map((v) => ({ value: v, label: `magnitude ${v}` })) },
    { key: 'quakeNearKm', label: 'within', kind: 'select', options: [50, 100, 200, 300, 500, 1000].map((v) => ({ value: v, label: `${v} km of me` })) }
  ],
  quakeBig: [{ key: 'quakeBigMag', label: 'Earthquakes of at least', kind: 'select', options: [5, 5.5, 6, 6.5, 7, 7.5, 8].map((v) => ({ value: v, label: `magnitude ${v}` })) }],
  quakeSwarm: [
    { key: 'swarmCount', label: 'At least', kind: 'number', min: 3, max: 30, unit: 'earthquakes (magnitude 2.5+) within 60 km in an hour' },
    { key: 'swarmWithinKm', label: 'Only swarms within', kind: 'select', options: [{ value: 0, label: 'anywhere in the world' }, ...[100, 250, 500, 1000].map((v) => ({ value: v, label: `${v} km of me` }))] }
  ],
  volcanoAlert: [{ key: 'volcanoKm', label: 'Volcanoes', kind: 'select', options: [{ value: 0, label: 'anywhere in the world' }, ...[250, 500, 1000, 2500].map((v) => ({ value: v, label: `within ${v} km of me` }))] }],
  dataStale: [{ key: 'staleDays', label: 'Orbit data counts as out of date after', kind: 'number', min: 2, max: 25, unit: 'days' }],
  diskSpace: [{ key: 'diskFreeGB', label: 'Warn when less than', kind: 'number', min: 1, max: 200, unit: 'GB is free' }]
}

/** Types that need a saved location / need lightning collection, to say so beside them. */
const NEEDS_PLACE: NotificationCategory[] = ['issPass', 'quakeNear', 'quakeSwarm', 'lightningNear', 'stormApproaching', 'clearNight', 'auroraChance', 'skyEvent']
const NEEDS_LIGHTNING: NotificationCategory[] = ['lightningNear', 'stormApproaching']

function OverrideSelect({ label, value, onChange, disabled }: { label: string; value: boolean | undefined; onChange: (v: boolean | undefined) => void; disabled: boolean }): ReactElement {
  return (
    <label className="flex items-center gap-2 text-xs text-text-muted">
      {label}
      <select
        className={field}
        disabled={disabled}
        value={value === undefined ? 'default' : value ? 'on' : 'off'}
        onChange={(e) => onChange(e.target.value === 'default' ? undefined : e.target.value === 'on')}
      >
        <option value="default">Like the general setting</option>
        <option value="on">Always</option>
        <option value="off">Never</option>
      </select>
    </label>
  )
}

function TypeRow({ category, warning }: { category: NotificationCategory; warning: string | null }): ReactElement {
  const { settings, setSettings, sendTest } = useNotifications()
  const [open, setOpen] = useState(false)
  const info = CATEGORY_INFO[category]
  const off = !settings.enabled
  const enabled = settings.categories[category]
  const over: DeliveryOverride = settings.overrides[category] ?? {}
  const fields = PARAM_FIELDS[category] ?? []
  const setOver = (p: DeliveryOverride): void => {
    const next = { ...over, ...p }
    const cleaned: DeliveryOverride = {}
    for (const k of ['inApp', 'windows', 'sound'] as const) if (next[k] !== undefined) cleaned[k] = next[k]
    setSettings({ ...settings, overrides: { ...settings.overrides, [category]: cleaned } })
  }
  const setParam = <K extends keyof NotificationParams>(key: K, value: NotificationParams[K]): void => setSettings({ ...settings, params: { ...settings.params, [key]: value } })
  const customised = Object.keys(over).length > 0

  return (
    <div className="py-1">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Toggle
            label={info.label}
            description={info.description}
            checked={enabled}
            disabled={off}
            onChange={(v) => setSettings({ ...settings, categories: { ...settings.categories, [category]: v } })}
          />
          {enabled && warning && <div className="-mt-1 mb-1 pl-7 text-xs text-warning">{warning}</div>}
        </div>
        <button
          onClick={() => setOpen((o) => !o)}
          disabled={off}
          className={`mt-2 shrink-0 rounded-md border px-2 py-0.5 text-[11px] hover:text-text disabled:opacity-50 ${customised ? 'border-accent text-text' : 'border-border text-text-muted'}`}
        >
          {open ? 'Hide options' : 'Options'}
        </button>
      </div>
      {open && !off && (
        <div className="mb-2 ml-7 space-y-3 rounded-md border border-border bg-bg/40 p-3">
          {fields.length > 0 && (
            <div className="space-y-2">
              {fields.map((f) => (
                <label key={f.key} className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                  {f.kind === 'checkbox' ? (
                    <>
                      <input type="checkbox" checked={settings.params[f.key] as boolean} onChange={(e) => setParam(f.key, e.target.checked as never)} className="accent-[rgb(var(--color-accent))]" />
                      <span className="text-text">{f.label}</span>
                    </>
                  ) : f.kind === 'select' ? (
                    <>
                      {f.label}
                      <select className={field} value={settings.params[f.key] as number} onChange={(e) => setParam(f.key, Number(e.target.value) as never)}>
                        {f.options!.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : (
                    <>
                      {f.label}
                      <input
                        type="number"
                        className={`${field} w-20`}
                        min={f.min}
                        max={f.max}
                        step={f.step ?? 1}
                        value={settings.params[f.key] as number}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          if (Number.isFinite(v)) setParam(f.key, Math.min(f.max ?? v, Math.max(f.min ?? v, v)) as never)
                        }}
                      />
                      {f.unit}
                    </>
                  )}
                </label>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-3">
            <OverrideSelect label="Pop-up" value={over.inApp} onChange={(inApp) => setOver({ inApp })} disabled={false} />
            <OverrideSelect label="Windows notification" value={over.windows} onChange={(windows) => setOver({ windows })} disabled={false} />
            <OverrideSelect label="Sound" value={over.sound} onChange={(sound) => setOver({ sound })} disabled={false} />
            <button onClick={() => sendTest(category)} className="ml-auto rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-accent hover:text-text">
              Send a test
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const LEVEL_DOT = { info: 'bg-accent', success: 'bg-success', error: 'bg-danger' } as const

const ago = (t: number): string => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function History(): ReactElement {
  const { history, clearHistory, markAllRead } = useNotifications()
  const items = [...history].reverse()

  useEffect(() => {
    const t = window.setTimeout(markAllRead, 1500) // seen once you have looked at the list for a moment
    return () => window.clearTimeout(t)
  }, [markAllRead, history.length])

  return (
    <section className="mt-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">The last {Math.max(history.length, 0)} notifications (up to 200), including ones held back by quiet hours. Click one to open its page.</p>
        {items.length > 0 && (
          <button onClick={clearHistory} className="rounded-md border border-border px-3 py-1 text-xs text-text-muted hover:border-danger hover:text-danger">
            Clear history
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <div className="mt-3 rounded-lg border border-border bg-surface px-4 py-6 text-center text-sm text-text-muted">Nothing yet. Notifications will be listed here.</div>
      ) : (
        <div className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {items.map((h) => (
            <button
              key={h.id}
              onClick={() => h.route && goToRoute(h.route)}
              className={`flex w-full items-start gap-3 px-4 py-3 text-left ${h.route ? 'hover:bg-surface-raised' : 'cursor-default'}`}
            >
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${LEVEL_DOT[h.level]} ${h.read ? 'opacity-30' : ''}`} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className={`text-sm ${h.read ? 'text-text-muted' : 'font-medium text-text'}`}>{h.title}</span>
                  {h.quiet && <span className="rounded border border-border px-1 text-[10px] text-text-muted">held back: quiet hours</span>}
                </span>
                <span className="block break-words text-xs text-text-muted">{h.body}</span>
              </span>
              <span className="shrink-0 text-right text-[11px] text-text-muted">
                <span className="block">{ago(h.t)}</span>
                <span className="block">{h.category === 'test' ? 'test' : CATEGORY_INFO[h.category].label}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

export function Notifications(): ReactElement {
  const { settings, setSettings, sendTest, unread } = useNotifications()
  const { place } = usePlace()
  const [tab, setTab] = usePageState<'settings' | 'history'>('notifications', 'tab', 'settings', (v) => (v === 'settings' || v === 'history' ? v : undefined))
  const [lightningOff, setLightningOff] = useState(false)
  const patch = (p: Partial<NotificationSettings>): void => setSettings({ ...settings, ...p })
  const off = !settings.enabled

  useEffect(() => {
    api
      .get<{ enabled: boolean }>('/lightning/status')
      .then((s) => setLightningOff(!s.enabled))
      .catch(() => undefined)
  }, [])

  const warningFor = (c: NotificationCategory): string | null => {
    if (NEEDS_PLACE.includes(c) && !place) return 'Needs your location: set it at the top of the Dashboard.'
    if (NEEDS_LIGHTNING.includes(c) && lightningOff) return 'Lightning collection is switched off (Settings → Lightning), so this cannot work.'
    return null
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-8">
      <div className="flex items-end justify-between gap-4">
        <h1 className="text-xl font-semibold text-text">Notifications</h1>
        <div className="flex overflow-hidden rounded-md border border-border text-xs">
          <button onClick={() => setTab('settings')} className={`px-4 py-1.5 ${tab === 'settings' ? 'bg-accent/25 text-text' : 'text-text-muted hover:text-text'}`}>
            Settings
          </button>
          <button onClick={() => setTab('history')} className={`px-4 py-1.5 ${tab === 'history' ? 'bg-accent/25 text-text' : 'text-text-muted hover:text-text'}`}>
            History{unread > 0 ? ` (${unread} new)` : ''}
          </button>
        </div>
      </div>

      {tab === 'history' ? (
        <History />
      ) : (
        <section className="mt-6 max-w-3xl space-y-5">
          <p className="text-xs text-text-muted">Get told when long-running work finishes, when something in the sky is worth looking at, and when the camera or the computer needs attention: in the app and/or as a Windows notification.</p>

          <div className="divide-y divide-border rounded-lg border border-border bg-surface px-4">
            <Toggle label="Enable notifications" checked={settings.enabled} onChange={(enabled) => patch({ enabled })} />

            <div className="py-2">
              <div className="pt-1 text-xs font-medium uppercase tracking-wide text-text-muted">Delivery</div>
              <Toggle label="In-app pop-ups" description="Small toasts shown inside the window; click one to open its page" checked={settings.inApp} disabled={off} onChange={(inApp) => patch({ inApp })} />
              <Toggle label="Windows notifications" description="Native Windows toasts that appear in the notification area; click one to open the app at its page" checked={settings.windows} disabled={off} onChange={(windows) => patch({ windows })} />
              <div className="pl-7">
                <Toggle label="Only when the app isn't in focus" checked={settings.windowsOnlyWhenUnfocused} disabled={off || !settings.windows} onChange={(windowsOnlyWhenUnfocused) => patch({ windowsOnlyWhenUnfocused })} />
                <Toggle label="Play notification sound" checked={settings.sound} disabled={off || !settings.windows} onChange={(sound) => patch({ sound })} />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-6 py-3">
              <label className="flex items-center gap-2 text-xs text-text-muted">
                Pop-up position
                <select value={settings.position} disabled={off || !settings.inApp} onChange={(e) => patch({ position: e.target.value as NotificationSettings['position'] })} className={field}>
                  {POSITIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs text-text-muted">
                Show for
                <input type="range" min={2} max={20} value={settings.durationSec} disabled={off || !settings.inApp} onChange={(e) => patch({ durationSec: Number(e.target.value) })} className="disabled:opacity-50" />
                <span className="w-8 text-text">{settings.durationSec}s</span>
              </label>
              <button onClick={() => sendTest()} className="ml-auto rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:border-accent hover:text-text">
                Send test notification
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-surface px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-text-muted">Quiet hours</div>
            <Toggle
              label="Stay quiet during these hours"
              description="Nothing pops up and nothing makes a sound, whatever the type. Everything is still kept in the History."
              checked={settings.quiet.enabled}
              disabled={off}
              onChange={(enabled) => patch({ quiet: { ...settings.quiet, enabled } })}
            />
            <div className="flex items-center gap-3 pl-7 text-xs text-text-muted">
              from
              <input type="time" className={field} value={settings.quiet.start} disabled={off || !settings.quiet.enabled} onChange={(e) => patch({ quiet: { ...settings.quiet, start: e.target.value || '23:00' } })} />
              to
              <input type="time" className={field} value={settings.quiet.end} disabled={off || !settings.quiet.enabled} onChange={(e) => patch({ quiet: { ...settings.quiet, end: e.target.value || '07:00' } })} />
              <span>(this computer&apos;s time; it may run past midnight)</span>
            </div>
          </div>

          {GROUP_ORDER.map((group) => (
            <div key={group} className="rounded-lg border border-border bg-surface px-4 py-2">
              <div className="pt-1 text-xs font-medium uppercase tracking-wide text-text-muted">{group === 'Sky' ? 'Sky (needs the app running)' : group}</div>
              <div className="divide-y divide-border">
                {(Object.keys(CATEGORY_INFO) as NotificationCategory[])
                  .filter((c) => CATEGORY_INFO[c].group === group)
                  .map((c) => (
                    <TypeRow key={c} category={c} warning={warningFor(c)} />
                  ))}
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
