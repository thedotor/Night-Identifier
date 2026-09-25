import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@renderer/lib/api'
import { loadCatalogue } from '@renderer/lib/skyCatalogue'
import { GALACTIC_NORTH_ECLIPTIC } from '@renderer/lib/galaxyMath'
import { KIND_LABEL, type BodyKind, type DistancesData, type HostsData, type LocalGroupData, type OrbitData, type StarsData, type TextureData } from '@renderer/lib/solarSystemData'
import { useTheme } from '@renderer/theme/ThemeContext'
import { DEFAULT_LAYERS, SolarSystemEngine, type BodyInfo, type Layers, type ListItem } from './solarSystemEngine'
import { ScaleRuler, type ScaleStop } from './ScaleRuler'
import { loadUniverse } from './universeLoader'

interface Props {
  /** simulation start time (ms since epoch), e.g. the moment a photo was taken */
  startMs: number
  /** true when startMs is a photo's time, so the bar can offer a way back to it */
  fromPhoto: boolean
  focus: string | null
}

const DAY_MS = 86_400_000
const SLIDER_DAYS = 366
const SPEEDS: { label: string; days: number }[] = [
  { label: '1 hour / s', days: 1 / 24 },
  { label: '1 day / s', days: 1 },
  { label: '1 week / s', days: 7 },
  { label: '1 month / s', days: 30.44 },
  { label: '1 year / s', days: 365.25 },
  { label: '10 years / s', days: 3652.5 },
  { label: '100 years / s', days: 36_525 },
  { label: '1,000 years / s', days: 365_250 },
  { label: '10,000 years / s', days: 3_652_500 },
  { label: '100,000 years / s', days: 36_525_000 }
]
const HOME_DIRECTION: [number, number, number] = [0.35, -1, 0.7]
/** One-click scales from a planet to the neighbouring galaxies. */
const STOPS: ScaleStop[] = [
  { label: 'Inner', au: 4, focus: 'sun', title: 'The Sun and Mercury to Mars' },
  { label: 'Outer', au: 45, focus: 'sun', title: 'Out to Neptune and Pluto' },
  { label: 'Full', au: 160, focus: 'sun', title: 'The Kuiper belt and the distant dwarf planets' },
  { label: 'Stars', au: 2e6, focus: 'sun', title: 'The Sun and the stars around it, in 3D' },
  { label: 'Galaxy', au: 1.1e10, focus: 'milkyway', direction: [...GALACTIC_NORTH_ECLIPTIC], title: 'The Milky Way from above' },
  { label: 'Local Group', au: 6e11, focus: 'milkyway', direction: HOME_DIRECTION, title: 'The Milky Way, Andromeda and their neighbours' },
  { label: 'Beyond', au: 5e12, focus: 'milkyway', direction: HOME_DIRECTION, title: 'Galaxies out to the Virgo Cluster' }
]
const LAYER_LABELS: { key: keyof Layers; label: string }[] = [
  { key: 'orbits', label: 'Orbits' },
  { key: 'labels', label: 'Labels' },
  { key: 'moons', label: 'Moons' },
  { key: 'minor', label: 'Dwarfs, asteroids, comets' },
  { key: 'belts', label: 'Belts' },
  { key: 'stars', label: 'Stars' },
  { key: 'constellations', label: 'Constellations' },
  { key: 'hosts', label: 'Planet hosts' },
  { key: 'deepsky', label: 'Nebulae & clusters' },
  { key: 'galaxies', label: 'Galaxies' }
]
const GROUP_ORDER: { kind: BodyKind; label: string }[] = [
  { kind: 'star', label: 'Stars' },
  { kind: 'planet', label: 'Planets' },
  { kind: 'dwarf', label: 'Dwarf planets' },
  { kind: 'asteroid', label: 'Asteroids' },
  { kind: 'comet', label: 'Comets' },
  { kind: 'moon', label: 'Moons' },
  { kind: 'nebula', label: 'Nebulae' },
  { kind: 'cluster', label: 'Star clusters' },
  { kind: 'galaxy', label: 'Galaxies' },
  { kind: 'constellation', label: 'Constellations (3D)' }
]
/** Long groups show this many until you search or expand them. */
const GROUP_PREVIEW = 30

const RED_NIGHT_FILTER = 'grayscale(1) sepia(1) hue-rotate(-50deg) saturate(6) brightness(0.85)'
const J2000_MS = Date.UTC(2000, 0, 1, 12)
/** Beyond this many years from J2000 the planets are not computed (the stars keep moving). */
const PLANET_YEARS_OK = 2000
const yearsFromJ2000 = (ms: number): number => (ms - J2000_MS) / (365.25 * DAY_MS)
/** Value for a datetime-local box; blank when the year is outside what the box can show. */
const utcInput = (ms: number): string => {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  return y >= 1000 && y <= 9999 ? d.toISOString().slice(0, 19) : ''
}
const fmtYear = (ms: number): string => {
  const y = Math.round(2000 + yearsFromJ2000(ms))
  return y > 0 ? `year ${y.toLocaleString()} CE` : `${(1 - y).toLocaleString()} BCE`
}

const btn = 'rounded-md border border-border bg-surface px-2.5 py-1 text-xs text-text-muted hover:border-accent hover:text-text disabled:opacity-40'

/** The 3D solar system: orbit any body, fly to it, and scrub time from the photo's moment. */
export function SolarSystemView({ startMs, fromPhoto, focus }: Props): ReactElement {
  const navigate = useNavigate()
  const { theme } = useTheme()
  const mount = useRef<HTMLDivElement>(null)
  const engine = useRef<SolarSystemEngine | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [items, setItems] = useState<ListItem[]>([])
  const [selected, setSelected] = useState(focus ?? 'sun')
  const [info, setInfo] = useState<BodyInfo | null>(null)
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS)
  const [ms, setMs] = useState(startMs)
  const [sliderBase, setSliderBase] = useState(startMs)
  const [playing, setPlaying] = useState(false)
  const [speedIdx, setSpeedIdx] = useState(1)
  const [reverse, setReverse] = useState(false)
  const [query, setQuery] = useState('')
  const [offline, setOffline] = useState<string[]>([])
  const [credits, setCredits] = useState<string[]>([])
  const [viewAU, setViewAU] = useState(14)
  const [expanded, setExpanded] = useState<Set<BodyKind>>(new Set())

  // Latest values for the engine callbacks, which are created once.
  const startRef = useRef(startMs)
  const focusRef = useRef(focus)
  const flownRef = useRef(false)

  useEffect(() => {
    const el = mount.current
    if (!el) return
    let eng: SolarSystemEngine
    try {
      eng = new SolarSystemEngine(el, { onSelect: setSelected, onTime: setMs, onView: (v) => setViewAU(v.distanceAU) })
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'WebGL is not available')
      return
    }
    engine.current = eng
    eng.setDate(startRef.current)

    let live = true
    // Datasets arrive one by one; the body a link points at may not exist until its data does.
    const refresh = (): void => {
      setItems(eng.list())
      if (focusRef.current && !flownRef.current && eng.list().some((i) => i.id === focusRef.current)) {
        flownRef.current = true
        eng.focusOn(focusRef.current)
      }
    }
    refresh()
    loadUniverse(eng, {
      live: () => live,
      onCredit: (c) => setCredits((cs) => (c && !cs.includes(c) ? [...cs, c] : cs)),
      onMissing: (what) => setOffline((o) => (o.includes(what) ? o : [...o, what])),
      onLoaded: refresh
    })

    return () => {
      live = false
      eng.dispose()
      engine.current = null
    }
  }, [])

  useEffect(() => engine.current?.setLayers(layers), [layers])
  useEffect(() => {
    engine.current?.setSpeed((reverse ? -1 : 1) * SPEEDS[speedIdx].days)
  }, [speedIdx, reverse])
  useEffect(() => engine.current?.setPlaying(playing), [playing])
  useEffect(() => setInfo(engine.current?.describe(selected) ?? null), [selected, ms, items])

  const setTime = (t: number, rebaseSlider = true): void => {
    engine.current?.setDate(t)
    setMs(t)
    if (rebaseSlider) setSliderBase(t)
  }

  const fly = (id: string, au?: number): void => {
    engine.current?.focusOn(id, au)
    setSelected(id)
  }

  const goStop = (s: ScaleStop): void => {
    const id = s.focus ?? engine.current?.getFocus() ?? 'sun'
    engine.current?.focusOn(id, { distance: s.au, direction: s.direction })
    setSelected(id)
  }

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const shown = items.filter((i) => !q || i.name.toLowerCase().includes(q))
    // Solar-system bodies keep their natural order (Mercury to Neptune); the many stars and galaxies go alphabetically.
    const order = (a: ListItem, b: ListItem): number => (a.tier === 'solar' && b.tier === 'solar' ? 0 : a.tier === 'solar' ? -1 : b.tier === 'solar' ? 1 : a.name.localeCompare(b.name))
    shown.sort(order)
    return GROUP_ORDER.map((g) => ({ ...g, rows: shown.filter((i) => i.kind === g.kind) })).filter((g) => g.rows.length)
  }, [items, query])
  const searching = query.trim() !== ''

  const sliderDays = Math.max(-SLIDER_DAYS, Math.min(SLIDER_DAYS, (ms - sliderBase) / DAY_MS))

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-52 shrink-0 flex-col border-r border-border bg-surface">
        <div className="border-b border-border p-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a body, star, galaxy…"
            className="w-full rounded-md border border-border bg-bg px-2 py-1 text-xs text-text placeholder:text-text-muted"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {groups.map((g) => (
            <div key={g.kind} className="mb-2">
              <div className="px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">{g.label}</div>
              {(searching || expanded.has(g.kind) ? g.rows : g.rows.slice(0, GROUP_PREVIEW)).map((i) => (
                <button
                  key={i.id}
                  onClick={() => fly(i.id)}
                  className={`block w-full truncate rounded px-2 py-1 text-left text-xs ${selected === i.id ? 'bg-accent/25 text-text' : 'text-text hover:bg-accent/10'}`}
                >
                  {i.name}
                  {i.parent && <span className="ml-1 text-text-muted">· {items.find((p) => p.id === i.parent)?.name}</span>}
                </button>
              ))}
              {!searching && !expanded.has(g.kind) && g.rows.length > GROUP_PREVIEW && (
                <button onClick={() => setExpanded((x) => new Set(x).add(g.kind))} className="block w-full rounded px-2 py-1 text-left text-[11px] text-accent hover:underline">
                  Show all {g.rows.length}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="relative min-w-0 flex-1 bg-black">
        <div ref={mount} className="absolute inset-0 select-none" style={theme === 'red' ? { filter: RED_NIGHT_FILTER } : undefined} />

        {failed && (
          <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-danger">
            The 3D view could not start ({failed}). Check that hardware acceleration is enabled.
          </div>
        )}

        <div className="absolute left-2 top-2 z-10 flex flex-wrap items-center gap-1.5">
          <div className="flex flex-wrap gap-x-3 gap-y-1 rounded-md border border-border bg-surface/85 px-2.5 py-1 text-xs text-text-muted">
            {LAYER_LABELS.map((l) => (
              <label key={l.key} className="flex cursor-pointer items-center gap-1 hover:text-text">
                <input type="checkbox" checked={layers[l.key]} onChange={(e) => setLayers((s) => ({ ...s, [l.key]: e.target.checked }))} className="accent-accent" />
                {l.label}
              </label>
            ))}
          </div>
        </div>

        {Math.abs(yearsFromJ2000(ms)) > PLANET_YEARS_OK && (
          <div className="absolute right-2 top-16 z-10 max-w-xs rounded-md border border-warning/40 bg-surface/90 px-3 py-1.5 text-xs text-text">
            Planet and moon positions are only computed for roughly the years 0 to 4000 CE, so they fade out here. The stars keep moving on their measured motions (sideways only: Hipparcos has no radial velocities).
          </div>
        )}

        {offline.length > 0 && (
          <div className="absolute left-2 top-16 z-10 max-w-md rounded-md border border-warning/40 bg-surface/90 px-3 py-1.5 text-xs text-text">
            Not available yet: {offline.join(', ')}. They need a connection the first time (or the offline pack in Settings); everything else is shown.
          </div>
        )}

        <div className="absolute inset-x-2 bottom-2 z-10 flex flex-col gap-2">
          <ScaleRuler distanceAU={viewAU} stops={STOPS} onStop={goStop} onDistance={(au) => engine.current?.focusOn(engine.current.getFocus(), { distance: au })} />
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs">
          <button onClick={() => setPlaying((p) => !p)} className={`${btn} w-[5.5rem] whitespace-nowrap`} title={playing ? 'Pause' : 'Play'}>
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <button onClick={() => setReverse((r) => !r)} className={`${btn} ${reverse ? '!border-accent !text-text' : ''}`} title="Run time backwards">
            ⏪ Reverse
          </button>
          <select value={speedIdx} onChange={(e) => setSpeedIdx(Number(e.target.value))} className="rounded-md border border-border bg-bg px-1.5 py-1 text-text">
            {SPEEDS.map((s, i) => (
              <option key={s.label} value={i}>
                {s.label}
              </option>
            ))}
          </select>
          <input
            type="range"
            min={-SLIDER_DAYS}
            max={SLIDER_DAYS}
            step={0.25}
            value={sliderDays}
            onChange={(e) => setTime(sliderBase + Number(e.target.value) * DAY_MS, false)}
            className="min-w-[8rem] flex-1 accent-accent"
            title="Scrub ±1 year around the last date you set"
          />
          <input
            type="datetime-local"
            step={1}
            value={utcInput(ms)}
            onChange={(e) => {
              const t = Date.parse(`${e.target.value}Z`)
              if (Number.isFinite(t)) setTime(t)
            }}
            className="rounded-md border border-border bg-bg px-1.5 py-1 text-text"
          />
          <span className="text-text-muted">{utcInput(ms) === '' ? fmtYear(ms) : 'UTC'}</span>
          {fromPhoto && (
            <button onClick={() => setTime(startMs)} className={btn} title="Back to the moment the photo was taken">
              Photo time
            </button>
          )}
          <button onClick={() => setTime(Date.now())} className={btn}>
            Now
          </button>
        </div>
        </div>
      </div>

      <div className="w-72 shrink-0 overflow-y-auto border-l border-border bg-surface p-4">
        {info ? (
          <>
            <h2 className="text-lg font-semibold text-text">{info.name}</h2>
            <div className="text-xs text-text-muted">{KIND_LABEL[info.kind]}</div>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              {info.facts.map((f) => (
                <div key={f.label} className="contents">
                  <dt className="text-text-muted">{f.label}</dt>
                  <dd className="text-right text-text">{f.value}</dd>
                </div>
              ))}
            </dl>
            {info.note && <p className="mt-3 text-[11px] leading-snug text-text-muted">{info.note}</p>}
            {info.detail && (
              <button
                onClick={() => navigate(`/deep-space?kind=${info.detail!.kind}&key=${encodeURIComponent(info.detail!.key)}`)}
                className="mt-4 w-full rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg"
              >
                Photos &amp; description
              </button>
            )}
          </>
        ) : (
          <div className="text-sm text-text-muted">Click a body, or pick one from the list.</div>
        )}
        <div className="mt-6 space-y-1 border-t border-border pt-3 text-[10px] leading-snug text-text-muted">
          <p>Drag to orbit · wheel to zoom · click a body to fly to it.</p>
          <p>Planet, Moon and Galilean-moon positions: astronomy-engine. Sky backdrop: Hipparcos (d3-celestial). The Milky Way's spiral arms are a schematic model.</p>
          {credits.map((c) => (
            <p key={c}>{c}</p>
          ))}
        </div>
      </div>
    </div>
  )
}
