import { useEffect, useState, type ReactElement } from 'react'
import { useTheme, ThemeName, CustomThemeColors } from '@renderer/theme/ThemeContext'
import { api, DataDirInfo, type DeepSpacePackStatus } from '@renderer/lib/api'
import { fmtBytes } from '@renderer/lib/deepspace'
import { fmtAge } from '@renderer/lib/satelliteText'
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

/** Orbit data for the satellite overlays: what has been downloaded from CelesTrak and how old it is. */
interface SatelliteStatus {
  datasets: Record<string, { count: number; fetched_at: number; age_s: number; bytes: number } | null>
  errors: Record<string, string>
  min_refetch_s: number
  credit: string
}

const SAT_DATASETS: [string, string][] = [
  ['stations', 'ISS, Tiangong & other stations'],
  ['visual', 'Bright satellites'],
  ['active', 'All active satellites (includes Starlink)']
]

function SatelliteData(): ReactElement {
  const [status, setStatus] = useState<SatelliteStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<SatelliteStatus>('/satellites/status')
      .then(setStatus)
      .catch(() => setNote('Could not reach the backend.'))
  }, [])

  const refresh = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const r = await api.post<SatelliteStatus & { result: Record<string, string> }>('/satellites/refresh')
      setStatus(r)
      const res = Object.values(r.result)
      setNote(
        res.includes('failed')
          ? `Could not download everything: ${Object.values(r.errors)[0] ?? 'no connection?'}`
          : res.every((v) => v === 'recent')
            ? 'Already up to date. CelesTrak publishes new orbit data every two hours.'
            : 'Orbit data updated.'
      )
    } catch {
      setNote('That did not work. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-8 max-w-2xl">
      <h2 className="text-sm font-semibold text-text">Satellite orbit data</h2>
      <p className="mt-1 text-xs text-text-muted">
        The satellite overlays (Sky Overlay, Live View, Deep Space) download orbit data from CelesTrak the first time you turn a group on, and refresh it in the background when it is over six hours old.
        Without a connection they keep using the last download. Orbits drift, so data more than a few days from the moment you are looking at gets less accurate.
      </p>
      <div className="mt-3 rounded-lg border border-border bg-surface p-4">
        <div className="space-y-1 text-xs">
          {SAT_DATASETS.map(([id, label]) => {
            const d = status?.datasets[id]
            return (
              <div key={id} className="flex justify-between gap-3">
                <span className="text-text">{label}</span>
                <span className="text-text-muted">{!status ? '…' : d ? `${d.count.toLocaleString()} objects · ${fmtAge(d.fetched_at)} · ${fmtBytes(d.bytes)}` : 'not downloaded yet'}</span>
              </div>
            )
          })}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button onClick={() => void refresh()} disabled={busy} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50">
            {busy ? 'Downloading…' : 'Refresh now'}
          </button>
          <span className="text-[11px] text-text-muted">{status?.credit}</span>
        </div>
        {note && <div className="mt-2 text-xs text-text-muted">{note}</div>}
      </div>
    </section>
  )
}

interface LightningStatusOut {
  enabled: boolean
  connected: boolean
  server: string | null
  per_minute: number
  held: number
  error: string | null
  credit: string
}

/** Whether the backend collects live lightning strikes while the app is open (they cost a few KB a second and feed the globe, the dashboard card and the thunder cue). */
function LightningSettings(): ReactElement {
  const [status, setStatus] = useState<LightningStatusOut | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    const load = (): void => {
      api
        .get<LightningStatusOut>('/lightning/status')
        .then(setStatus)
        .catch(() => setNote('Could not reach the backend.'))
    }
    load()
    const t = window.setInterval(load, 4000)
    return () => window.clearInterval(t)
  }, [])

  const toggle = async (enabled: boolean): Promise<void> => {
    try {
      setStatus(await api.put<LightningStatusOut>('/lightning/collect', { enabled }))
      setNote(null)
    } catch {
      setNote('That did not work. Try again in a moment.')
    }
  }

  return (
    <section className="mt-8 max-w-2xl">
      <h2 className="text-sm font-semibold text-text">Lightning</h2>
      <p className="mt-1 text-xs text-text-muted">
        While the app is open, the backend listens to the Blitzortung volunteer lightning network and keeps the last hour of strikes, so the Deep Space globe, the Dashboard card and the thunder cue are ready the moment you look. It uses a few KB
        a second. Coverage is best over Europe, North America, Australia and Japan and thinner over oceans and parts of Africa.
      </p>
      <div className="mt-3 rounded-lg border border-border bg-surface p-4">
        <label className="flex items-center gap-2 text-xs text-text">
          <input type="checkbox" checked={status?.enabled ?? true} onChange={(e) => void toggle(e.target.checked)} className="accent-accent" />
          Collect lightning strikes in the background
        </label>
        <div className="mt-2 text-xs text-text-muted">
          {!status
            ? '…'
            : !status.enabled
              ? 'Switched off: nothing is collected or downloaded.'
              : status.connected
                ? `Connected (${status.server}): ${status.per_minute} strikes in the last minute, ${status.held.toLocaleString()} held.`
                : `Connecting…${status.error ? ` (${status.error})` : ''}`}
        </div>
        <div className="mt-1 text-[11px] text-text-muted">{status?.credit}</div>
        {note && <div className="mt-2 text-xs text-text-muted">{note}</div>}
      </div>
    </section>
  )
}

/** An optional free NASA key for the Sun's CME catalogue (the shared demo key allows 30 requests an hour, plenty for one person, but shared with everyone using it). */
function SunSettings(): ReactElement {
  const [has, setHas] = useState<boolean | null>(null)
  const [key, setKey] = useState('')
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ has_nasa_api_key: boolean }>('/sun/settings')
      .then((r) => setHas(r.has_nasa_api_key))
      .catch(() => setNote('Could not reach the backend.'))
  }, [])

  const save = async (value: string): Promise<void> => {
    try {
      const r = await api.put<{ has_nasa_api_key: boolean }>('/sun/settings', { nasa_api_key: value })
      setHas(r.has_nasa_api_key)
      setKey('')
      setNote(value ? 'Saved.' : 'Removed: the shared demo key is used.')
    } catch (e) {
      setNote(e instanceof Error && /does not look/.test(e.message) ? 'That does not look like a NASA API key.' : 'That did not work. Try again in a moment.')
    }
  }

  return (
    <section className="mt-8 max-w-2xl">
      <h2 className="text-sm font-semibold text-text">The Sun</h2>
      <p className="mt-1 text-xs text-text-muted">
        The Sun's live pictures come from NASA and ESA through Helioviewer, and flares and sunspots from NOAA: none of that needs an account. The list of coronal mass ejections (CMEs) comes from NASA's DONKI service, which is free but
        rate-limited on its shared demo key (30 requests an hour, shared with everyone using that key). The app asks at most once an hour, so the demo key is normally enough. If you ever see "no connection" for CMEs, a free personal key from
        api.nasa.gov removes the limit.
      </p>
      <div className="mt-3 rounded-lg border border-border bg-surface p-4">
        <div className="text-xs text-text">{has === null ? '…' : has ? 'A personal NASA API key is saved.' : 'Using the shared demo key.'}</div>
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (key.trim()) void save(key.trim())
          }}
        >
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste a NASA API key" className="w-72 rounded border border-border bg-bg px-2 py-1 text-xs text-text" spellCheck={false} />
          <button type="submit" disabled={!key.trim()} className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-accent hover:text-text disabled:opacity-40">
            Save
          </button>
          {has && (
            <button type="button" onClick={() => void save('')} className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-danger hover:text-danger">
              Remove
            </button>
          )}
        </form>
        {note && <div className="mt-2 text-xs text-text-muted">{note}</div>}
      </div>
    </section>
  )
}

/** An optional free aisstream.io key that turns the ship layer on for the whole world (without it, only the Baltic Sea). */
function ShipSettings(): ReactElement {
  const [has, setHas] = useState<boolean | null>(null)
  const [key, setKey] = useState('')
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ has_key: boolean }>('/ships/status')
      .then((r) => setHas(r.has_key))
      .catch(() => setNote('Could not reach the backend.'))
  }, [])

  const save = async (value: string): Promise<void> => {
    try {
      const r = await api.put<{ has_key: boolean }>('/ships/key', { key: value })
      setHas(r.has_key)
      setKey('')
      setNote(value ? 'Saved. Ships worldwide appear within a minute of switching Ships on in Deep Space.' : 'Removed: only the Baltic Sea is covered.')
    } catch (e) {
      setNote(e instanceof Error && /does not look/.test(e.message) ? 'That does not look like an aisstream.io key.' : 'That did not work. Try again in a moment.')
    }
  }

  return (
    <section className="mt-8 max-w-2xl">
      <h2 className="text-sm font-semibold text-text">Ships</h2>
      <p className="mt-1 text-xs text-text-muted">
        The ships on the 3D Earth come from their AIS transponders. The Baltic Sea and the Finnish coast are covered with no account, from the Finnish Digitraffic service. For the whole world, sign up (free) at aisstream.io, create an API key and paste it
        here: ships everywhere then appear, wherever the world's coastal receivers and satellites hear them (the open ocean is patchy). The connection only runs while you have Ships switched on in Deep Space.
      </p>
      <div className="mt-3 rounded-lg border border-border bg-surface p-4">
        <div className="text-xs text-text">{has === null ? '…' : has ? 'An aisstream.io key is saved: ships worldwide.' : 'No key: the Baltic Sea only.'}</div>
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (key.trim()) void save(key.trim())
          }}
        >
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste an aisstream.io API key" className="w-80 rounded border border-border bg-bg px-2 py-1 text-xs text-text" spellCheck={false} />
          <button type="submit" disabled={!key.trim()} className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-accent hover:text-text disabled:opacity-40">
            Save
          </button>
          {has && (
            <button type="button" onClick={() => void save('')} className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-danger hover:text-danger">
              Remove
            </button>
          )}
        </form>
        {note && <div className="mt-2 text-xs text-text-muted">{note}</div>}
      </div>
    </section>
  )
}

interface GeoipDbInfo {
  available: boolean
  built?: string
  downloaded?: boolean
}

/** Refresh buttons for the two offline IP-address databases the "Web traffic" layer uses: places (city) and network owners (ASN). */
function TrafficSettings(): ReactElement {
  const [status, setStatus] = useState<{ city: GeoipDbInfo; asn: GeoipDbInfo } | null>(null)
  const [busy, setBusy] = useState<'city' | 'asn' | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = (): void => {
    api
      .get<{ city: GeoipDbInfo; asn: GeoipDbInfo }>('/traffic/database/status')
      .then(setStatus)
      .catch(() => setNote('Could not reach the backend.'))
  }
  useEffect(load, [])

  const refresh = async (which: 'city' | 'asn'): Promise<void> => {
    setBusy(which)
    setNote(null)
    try {
      await api.post(which === 'city' ? '/traffic/database/update' : '/traffic/database/update-asn')
      load()
      setNote(which === 'city' ? 'Places database updated.' : 'Network-owner database updated.')
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'That did not work. Try again in a moment.')
    } finally {
      setBusy(null)
    }
  }

  const row = (which: 'city' | 'asn', label: string, info: GeoipDbInfo | undefined): ReactElement => (
    <div className="flex flex-wrap items-center gap-2">
      <button className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-accent hover:text-text disabled:opacity-40" disabled={busy !== null} onClick={() => void refresh(which)}>
        {busy === which ? 'Working…' : `Refresh ${label}`}
      </button>
      <span className="text-xs text-text-muted">{info?.available ? `From ${info.built}${info.downloaded ? ' (downloaded)' : ' (bundled)'}` : 'Not available'}</span>
    </div>
  )

  return (
    <section className="mt-8 max-w-2xl">
      <h2 className="text-sm font-semibold text-text">Web traffic databases</h2>
      <p className="mt-1 text-xs text-text-muted">
        Where an address is (city-level) and who it belongs to (its network owner, e.g. &quot;Cloudflare, Inc.&quot;) both come from free, offline DB-IP databases bundled with the app. Refreshing downloads DB-IP&apos;s newest monthly release; it only fetches the database, it never sends any address anywhere.
      </p>
      <div className="mt-3 space-y-2 rounded-lg border border-border bg-surface p-4">
        {row('city', 'places database', status?.city)}
        {row('asn', 'network-owner database', status?.asn)}
        {note && <div className="text-xs text-text-muted">{note}</div>}
      </div>
    </section>
  )
}

/** An optional free NASA FIRMS map key that turns on the satellite heat spots (lava, hot vents and wildfires) on the 3D Earth. */
function HeatSettings(): ReactElement {
  const [has, setHas] = useState<boolean | null>(null)
  const [key, setKey] = useState('')
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ has_firms_key: boolean }>('/hazards/status')
      .then((r) => setHas(r.has_firms_key))
      .catch(() => setNote('Could not reach the backend.'))
  }, [])

  const save = async (value: string): Promise<void> => {
    try {
      const r = await api.put<{ has_firms_key: boolean }>('/hazards/firms-key', { key: value })
      setHas(r.has_firms_key)
      setKey('')
      setNote(value ? 'Saved. Switch Heat spots on in Deep Space (Hazards menu).' : 'Removed: the heat spots layer is off.')
    } catch (e) {
      setNote(e instanceof Error && /does not look/.test(e.message) ? 'That does not look like a FIRMS map key.' : 'That did not work. Try again in a moment.')
    }
  }

  return (
    <section className="mt-8 max-w-2xl">
      <h2 className="text-sm font-semibold text-text">Earthquakes, volcanoes and heat spots</h2>
      <p className="mt-1 text-xs text-text-muted">
        Earthquakes come from the USGS and volcano activity from the Smithsonian / USGS weekly report and the USGS alert levels: none of that needs an account. The satellite heat spots (lava, hot vents and wildfires, from NASA's FIRMS) need a free
        map key: request one at firms.modaps.eosdis.nasa.gov/api/map_key (it arrives by email) and paste it here. It is different from the NASA key in the Sun section.
      </p>
      <div className="mt-3 rounded-lg border border-border bg-surface p-4">
        <div className="text-xs text-text">{has === null ? '…' : has ? 'A FIRMS map key is saved.' : 'No FIRMS key: the heat spots layer is off.'}</div>
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (key.trim()) void save(key.trim())
          }}
        >
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste a FIRMS map key" className="w-80 rounded border border-border bg-bg px-2 py-1 text-xs text-text" spellCheck={false} />
          <button type="submit" disabled={!key.trim()} className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-accent hover:text-text disabled:opacity-40">
            Save
          </button>
          {has && (
            <button type="button" onClick={() => void save('')} className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-danger hover:text-danger">
              Remove
            </button>
          )}
        </form>
        {note && <div className="mt-2 text-xs text-text-muted">{note}</div>}
      </div>
    </section>
  )
}

/** A required free OpenAQ key that turns on the air quality station layer on the 3D Earth (OpenAQ has no keyless tier at all). */
function AqiSettings(): ReactElement {
  const [has, setHas] = useState<boolean | null>(null)
  const [key, setKey] = useState('')
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ has_openaq_key: boolean }>('/aqi/status')
      .then((r) => setHas(r.has_openaq_key))
      .catch(() => setNote('Could not reach the backend.'))
  }, [])

  const save = async (value: string): Promise<void> => {
    try {
      const r = await api.put<{ has_openaq_key: boolean }>('/aqi/openaq-key', { key: value })
      setHas(r.has_openaq_key)
      setKey('')
      setNote(value ? 'Saved. Switch Air quality on in Deep Space (Hazards menu).' : 'Removed: the air quality layer is off.')
    } catch (e) {
      setNote(e instanceof Error && /does not look/.test(e.message) ? 'That does not look like an OpenAQ key.' : 'That did not work. Try again in a moment.')
    }
  }

  return (
    <section className="mt-8 max-w-2xl">
      <h2 className="text-sm font-semibold text-text">Air quality</h2>
      <p className="mt-1 text-xs text-text-muted">
        Air quality stations (from OpenAQ) need a free API key &mdash; unlike this app&apos;s other optional keys, the layer shows nothing at all without one. Sign up at explore.openaq.org and paste the key it gives you here.
      </p>
      <div className="mt-3 rounded-lg border border-border bg-surface p-4">
        <div className="text-xs text-text">{has === null ? '…' : has ? 'An OpenAQ key is saved.' : 'No OpenAQ key: the air quality layer is off.'}</div>
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (key.trim()) void save(key.trim())
          }}
        >
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste an OpenAQ key" className="w-80 rounded border border-border bg-bg px-2 py-1 text-xs text-text" spellCheck={false} />
          <button type="submit" disabled={!key.trim()} className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-accent hover:text-text disabled:opacity-40">
            Save
          </button>
          {has && (
            <button type="button" onClick={() => void save('')} className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-danger hover:text-danger">
              Remove
            </button>
          )}
        </form>
        {note && <div className="mt-2 text-xs text-text-muted">{note}</div>}
      </div>
    </section>
  )
}

/** The second-monitor window: open it, and choose whether it opens by itself at start-up. */
function MonitorSettings(): ReactElement {
  const [st, setSt] = useState<{ open: boolean; fullscreen: boolean; autoOpen: boolean } | null>(null)
  useEffect(() => {
    void window.api.monitor.state().then(setSt)
  }, [])
  return (
    <section className="mt-8 max-w-2xl">
      <h2 className="text-sm font-semibold text-text">Monitoring window</h2>
      <p className="mt-1 text-xs text-text-muted">
        A second window of live cards for another monitor: a 3D Earth with live clouds, wind, planes, ships, lightning and the ISS, plus weather, aurora, space weather and Sun activity. You arrange its cards yourself (Customize in that window). It remembers which
        screen it was on, and F11 fills that screen.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-4">
        <button
          className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-accent hover:text-text"
          onClick={() => void (st?.open ? window.api.monitor.close() : window.api.monitor.open()).then(setSt)}
        >
          {st?.open ? 'Close the monitoring window' : 'Open the monitoring window'}
        </button>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-text">
          <input type="checkbox" checked={!!st?.autoOpen} onChange={(e) => void window.api.monitor.setAutoOpen(e.target.checked).then(setSt)} className="accent-accent" />
          Open it automatically when the app starts
        </label>
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
              {d.sdk_path && (
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-text-muted">Put its files in</span>
                  <code className="truncate rounded bg-bg px-1.5 py-0.5 font-mono text-[11px] text-text-muted">{d.sdk_path}</code>
                  <button onClick={() => void window.api.openPath(d.sdk_path!)} className="shrink-0 text-[11px] text-accent hover:underline">
                    Open folder
                  </button>
                </div>
              )}
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
      <SatelliteData />
      <LightningSettings />
      <SunSettings />
      <ShipSettings />
      <TrafficSettings />
      <HeatSettings />
      <AqiSettings />
      <MonitorSettings />

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
