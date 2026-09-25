import { useEffect, useState, type ReactElement } from 'react'
import { useTheme, ThemeName, CustomThemeColors } from '@renderer/theme/ThemeContext'
import { api, DataDirInfo, type DeepSpacePackStatus } from '@renderer/lib/api'
import { fmtBytes } from '@renderer/lib/deepspace'
import { live, type DriverDiagnostic } from '@renderer/lib/liveApi'
import { QUALITY_LABELS, autoLevel, getQualitySetting, probeGpuName, setQualitySetting, type QualitySetting } from '@renderer/lib/graphicsQuality'

const THEME_OPTIONS: { value: ThemeName; label: string; description: string }[] = [
  { value: 'dark', label: 'Dark', description: 'Default dark UI' },
  { value: 'light', label: 'Light', description: 'Bright, high-contrast UI' },
  { value: 'red', label: 'Red night-vision', description: 'Preserves night-adapted eyes' },
  { value: 'custom', label: 'Custom', description: 'Pick your own palette' }
]

function rgbTripleToHex(triple: string): string {
  const [r, g, b] = triple.split(' ').map(Number)
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
}

function hexToRgbTriple(hex: string): string {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.substring(0, 2), 16)
  const g = parseInt(clean.substring(2, 4), 16)
  const b = parseInt(clean.substring(4, 6), 16)
  return `${r} ${g} ${b}`
}

const CUSTOM_FIELDS: { key: keyof CustomThemeColors; label: string }[] = [
  { key: 'bg', label: 'Background' },
  { key: 'surface', label: 'Surface' },
  { key: 'surfaceRaised', label: 'Surface (raised)' },
  { key: 'border', label: 'Border' },
  { key: 'text', label: 'Text' },
  { key: 'textMuted', label: 'Text (muted)' },
  { key: 'accent', label: 'Accent' },
  { key: 'accentMuted', label: 'Accent (muted)' }
]

const PACK_POLL_MS = 1500

/** How hard the Deep Space 3D views work; matters on integrated or software graphics. */
function GraphicsQuality(): ReactElement {
  const [setting, setSetting] = useState<QualitySetting>(getQualitySetting)
  const [gpu] = useState(probeGpuName)
  return (
    <section className="mt-8 max-w-2xl">
      <h2 className="text-sm font-semibold text-text">3D graphics quality</h2>
      <p className="mt-1 text-xs text-text-muted">
        For the solar system, stars and galaxy views and the zoom-out from a photo. Lower settings draw fewer stars and skip edge smoothing, which helps on integrated or software
        graphics. Takes effect the next time you open a 3D view.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {(Object.keys(QUALITY_LABELS) as QualitySetting[]).map((q) => (
          <button
            key={q}
            onClick={() => {
              setQualitySetting(q)
              setSetting(q)
            }}
            className={`rounded-lg border p-3 text-left transition-colors ${setting === q ? 'border-accent bg-accent-muted/40' : 'border-border bg-surface hover:border-accent/50'}`}
          >
            <div className="text-sm font-medium text-text">{QUALITY_LABELS[q].label}</div>
            <div className="mt-1 text-xs text-text-muted">{QUALITY_LABELS[q].description}</div>
          </button>
        ))}
      </div>
      <div className="mt-2 text-xs text-text-muted">
        Graphics card: {gpu || 'unknown'}
        {setting === 'auto' ? ` · Auto chooses ${autoLevel(gpu)}` : ''}
      </div>
    </section>
  )
}

/** Deep Space images are cached as they are viewed; this downloads the popular ones up front. */
function DeepSpacePack(): ReactElement {
  const [status, setStatus] = useState<DeepSpacePackStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const poll = (): void => {
      api
        .get<DeepSpacePackStatus>('/deepspace/pack')
        .then((s) => live && setStatus(s))
        .catch(() => undefined)
    }
    poll()
    // Only keep polling while a download is in progress.
    const id = setInterval(() => status?.running && poll(), PACK_POLL_MS)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [status?.running])

  const act = async (fn: () => Promise<DeepSpacePackStatus>): Promise<void> => {
    setError(null)
    try {
      setStatus(await fn())
    } catch {
      setError('That did not work. Try again in a moment.')
    }
  }

  const pct = status && status.total > 0 ? Math.round((status.done / status.total) * 100) : 0
  return (
    <section className="mt-8 max-w-2xl">
      <h2 className="text-sm font-semibold text-text">Deep Space images</h2>
      <p className="mt-1 text-xs text-text-muted">
        Photos and sky-survey images of objects are downloaded from public archives the first time you look at them, then kept on this computer. Download the pack to
        have every Messier object, the Sun, Moon and planets available offline.
      </p>
      <div className="mt-3 rounded-lg border border-border bg-surface p-4">
        <div className="text-xs text-text-muted">Saved so far: {status ? fmtBytes(status.cache_bytes) : '…'}</div>
        {status?.running && (
          <div className="mt-3">
            <div className="h-2 overflow-hidden rounded bg-bg">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1 text-xs text-text-muted">
              {status.done} of {status.total}
              {status.current ? ` · ${status.current}` : ''}
              {status.failed ? ` · ${status.failed} failed` : ''}
            </div>
          </div>
        )}
        {status && !status.running && status.total > 0 && (
          <div className="mt-2 text-xs text-text-muted">
            Last download: {status.done - status.failed} of {status.total} objects saved{status.failed ? ` (${status.failed} could not be reached; run it again to retry)` : ''}.
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => void act(() => api.post<DeepSpacePackStatus>('/deepspace/pack'))}
            disabled={status?.running}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50"
          >
            {status?.running ? 'Downloading…' : 'Download offline pack'}
          </button>
          <button
            onClick={() => void act(() => api.delete<DeepSpacePackStatus>('/deepspace/cache'))}
            disabled={status?.running}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:border-accent hover:text-text disabled:opacity-50"
          >
            Clear saved images
          </button>
        </div>
        {error && <div className="mt-2 text-xs text-danger">{error}</div>}
      </div>
    </section>
  )
}

/** Which camera types can work on this computer right now, and where Live View saves its files. */
function LiveViewSettings(): ReactElement {
  const [drivers, setDrivers] = useState<DriverDiagnostic[] | null>(null)
  const [folder, setFolder] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    live
      .diagnostics()
      .then((d) => alive && setDrivers(d))
      .catch(() => alive && setError('Could not reach the backend.'))
    live
      .folder()
      .then((f) => alive && setFolder(f.path))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  return (
    <section className="mt-8 max-w-2xl">
      <h2 className="text-sm font-semibold text-text">Live View cameras</h2>
      <p className="mt-1 text-xs text-text-muted">
        Camera types Live View can use on this computer. Some need extra software (the ASCOM Platform, a vendor library) which the app cannot install for you.
      </p>
      <div className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface">
        {drivers?.map((d) => (
          <div key={d.kind} className="flex items-start gap-3 px-4 py-2.5 text-xs">
            <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${d.available ? 'bg-success' : 'bg-danger'}`} />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-text">
                {d.label}
                <span className="ml-2 text-[11px] text-text-muted">{d.available ? 'ready' : 'needs setup'}</span>
              </div>
              {d.note && <div className="mt-0.5 text-text-muted">{d.note}</div>}
            </div>
            <span className="shrink-0 text-[11px] text-text-muted">
              {d.tested === 'untested' ? 'not tried on real hardware' : d.tested === 'simulated' ? 'tested with a simulator' : 'tested on hardware'}
            </span>
          </div>
        ))}
        {!drivers && !error && <div className="px-4 py-3 text-xs text-text-muted">Checking…</div>}
        {error && <div className="px-4 py-3 text-xs text-danger">{error}</div>}
      </div>
      <div className="mt-3 flex items-center gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-text-muted">Captures, recordings, sequences and motion events are saved in</div>
          <div className="mt-1 truncate rounded-md bg-bg px-3 py-2 font-mono text-xs text-text-muted">{folder ?? '…'}</div>
        </div>
        <button
          onClick={() => folder && void window.api.openPath(folder)}
          disabled={!folder}
          className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:border-accent hover:text-text disabled:opacity-50"
        >
          Open folder
        </button>
      </div>
    </section>
  )
}

export function Settings(): ReactElement {
  const { theme, setTheme, customColors, setCustomColors } = useTheme()
  const [dataDir, setDataDir] = useState<DataDirInfo | null>(null)
  const [changing, setChanging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingRestart, setPendingRestart] = useState(false)

  useEffect(() => {
    api.get<DataDirInfo>('/settings/data-dir').then(setDataDir).catch(() => {})
  }, [])

  const handleChangeLocation = async (): Promise<void> => {
    const dir = await window.api.selectDirectory()
    if (!dir) return
    setChanging(true)
    setError(null)
    try {
      await api.put('/settings/data-dir', { path: dir })
      setPendingRestart(true)
    } catch {
      setError('Failed to move the data folder. Make sure the target location is empty and writable.')
    } finally {
      setChanging(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-8">
      <h1 className="text-xl font-semibold text-text">Settings</h1>
      <p className="mt-2 text-sm text-text-muted">Storage paths, appearance, and training defaults.</p>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-text">Appearance</h2>
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setTheme(opt.value)}
              className={`rounded-lg border p-4 text-left transition-colors ${
                theme === opt.value
                  ? 'border-accent bg-accent-muted/40'
                  : 'border-border bg-surface hover:border-accent/50'
              }`}
            >
              <div className="text-sm font-medium text-text">{opt.label}</div>
              <div className="mt-1 text-xs text-text-muted">{opt.description}</div>
            </button>
          ))}
        </div>

        {theme === 'custom' && (
          <div className="mt-4 grid grid-cols-2 gap-4 rounded-lg border border-border bg-surface p-4 lg:grid-cols-4">
            {CUSTOM_FIELDS.map((field) => (
              <label key={field.key} className="flex flex-col gap-1 text-xs text-text-muted">
                {field.label}
                <input
                  type="color"
                  value={rgbTripleToHex(customColors[field.key])}
                  onChange={(e) =>
                    setCustomColors({
                      ...customColors,
                      [field.key]: hexToRgbTriple(e.target.value)
                    })
                  }
                  className="h-8 w-full cursor-pointer rounded border border-border bg-transparent"
                />
              </label>
            ))}
          </div>
        )}
      </section>

      <LiveViewSettings />
      <GraphicsQuality />
      <DeepSpacePack />

      <section className="mt-8 max-w-2xl">
        <h2 className="text-sm font-semibold text-text">Storage location</h2>
        <p className="mt-1 text-xs text-text-muted">
          Everything the app manages &mdash; the image library, previews, trained models, and the
          annotation database &mdash; lives under this one folder.
        </p>

        {pendingRestart ? (
          <div className="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-4">
            <div className="text-sm text-text">
              Data folder moved to <span className="font-mono">{dataDir?.path}</span>.
            </div>
            <div className="mt-1 text-xs text-text-muted">Restart the app to finish switching over.</div>
            <button
              onClick={() => window.api.restartApp()}
              className="mt-3 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-bg"
            >
              Restart now
            </button>
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-border bg-surface p-4">
            <div className="truncate rounded-md bg-bg px-3 py-2 font-mono text-xs text-text-muted">
              {dataDir?.path ?? 'Loading...'}
            </div>
            <button
              onClick={handleChangeLocation}
              disabled={changing}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:border-accent hover:text-text disabled:opacity-50"
            >
              {changing ? 'Moving...' : 'Change location'}
            </button>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
            {error}
          </div>
        )}
      </section>
    </div>
  )
}
