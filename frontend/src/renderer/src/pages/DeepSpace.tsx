import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { usePageState } from '@renderer/lib/pageState'
import { useSearchParams } from 'react-router-dom'
import type { DeepSpaceKind } from '@renderer/lib/api'
import { loadCatalogue, type Catalogue } from '@renderer/lib/skyCatalogue'
import { ObjectDetailView } from '@renderer/components/deepspace/ObjectDetailView'
import { SolarSystemView } from '@renderer/components/deepspace/SolarSystemView'

interface Item {
  kind: DeepSpaceKind
  key: string
  label: string
  sub: string
  group: Group
}

type Group = 'solar' | 'messier' | 'stars' | 'other'

const GROUPS: { id: Group | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'solar', label: 'Solar system' },
  { id: 'messier', label: 'Messier' },
  { id: 'other', label: 'NGC / IC' },
  { id: 'stars', label: 'Stars' }
]

const BODIES = ['Sun', 'Moon', 'Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']
const MAX_ROWS = 300

function buildItems(cat: Catalogue | null): Item[] {
  const items: Item[] = BODIES.map((n) => ({
    kind: 'body',
    key: n.toLowerCase(),
    label: n,
    sub: n === 'Sun' ? 'Star' : n === 'Moon' ? 'Moon' : 'Planet',
    group: 'solar'
  }))
  if (!cat) return items
  for (const d of cat.dsos)
    items.push({
      kind: 'dso',
      key: d.id,
      label: d.name ? `${d.id} · ${d.name}` : d.id,
      sub: d.type,
      group: /^M\s*\d+$/.test(d.id.trim()) ? 'messier' : 'other'
    })
  cat.names.forEach((name, i) => items.push({ kind: 'star', key: String(i), label: name, sub: `Star · mag ${cat.mag[i].toFixed(1)}`, group: 'stars' }))
  return items
}

/** Browse every object the app knows and open its detail view. Objects clicked in the Sky
 * Overlay arrive here through ?kind=&key=. */
function ObjectBrowser(): ReactElement {
  const [params, setParams] = useSearchParams()
  const [cat, setCat] = useState<Catalogue | null>(null)
  const [query, setQuery] = usePageState('deep-sky', 'query', '', (v) => (typeof v === 'string' ? v : undefined))
  const [group, setGroup] = usePageState<Group | 'all'>('deep-sky', 'group', 'all', (v) => (v === 'all' || GROUPS.some((g) => g.id === v) ? (v as Group | 'all') : undefined))
  // the object that was open when the page was left (a link with its own object wins)
  const [lastPick, setLastPick] = usePageState<{ kind: string; key: string } | null>('deep-sky', 'pick', null, (v) => {
    const o = v as { kind?: unknown; key?: unknown }
    return typeof o?.kind === 'string' && typeof o?.key === 'string' ? { kind: o.kind, key: o.key } : undefined
  })

  useEffect(() => {
    void loadCatalogue().then(setCat).catch(() => undefined)
  }, [])

  const items = useMemo(() => buildItems(cat), [cat])
  const kind = params.get('kind') as DeepSpaceKind | null
  const key = params.get('key')
  useEffect(() => {
    if (kind && key !== null) setLastPick({ kind, key })
    else if (lastPick) setParams({ kind: lastPick.kind, key: lastPick.key }, { replace: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (kind && key !== null) setLastPick({ kind, key })
  }, [kind, key, setLastPick])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((i) => (group === 'all' || i.group === group) && (!q || i.label.toLowerCase().includes(q) || i.sub.toLowerCase().includes(q)))
  }, [items, query, group])

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
        <div className="border-b border-border p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">Deep Space</div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search objects…"
            className="mt-2 w-full rounded-md border border-border bg-bg px-2 py-1 text-xs text-text placeholder:text-text-muted"
          />
          <div className="mt-2 flex flex-wrap gap-1">
            {GROUPS.map((g) => (
              <button
                key={g.id}
                onClick={() => setGroup(g.id)}
                className={`rounded px-2 py-0.5 text-[11px] ${group === g.id ? 'bg-accent/25 text-text' : 'text-text-muted hover:text-text'}`}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.slice(0, MAX_ROWS).map((i) => (
            <button
              key={`${i.kind}-${i.key}`}
              onClick={() => setParams({ kind: i.kind, key: i.key })}
              className={`block w-full rounded px-2 py-1.5 text-left text-xs ${i.kind === kind && i.key === key ? 'bg-accent/25 text-text' : 'text-text hover:bg-accent/10'}`}
            >
              <div className="truncate">{i.label}</div>
              <div className="truncate text-[11px] text-text-muted">{i.sub}</div>
            </button>
          ))}
          {rows.length === 0 && <div className="p-3 text-center text-xs text-text-muted">{cat ? 'Nothing matches.' : 'Loading catalogue…'}</div>}
          {rows.length > MAX_ROWS && <div className="p-2 text-center text-[11px] text-text-muted">Showing the first {MAX_ROWS}. Search to narrow down.</div>}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        {kind && key !== null ? (
          <ObjectDetailView kind={kind} objectKey={key} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <div className="text-4xl text-accent">✧</div>
            <div className="text-sm font-semibold text-text">Pick an object to explore</div>
            <p className="max-w-sm text-xs text-text-muted">
              Choose a planet, Messier object, nebula or bright star from the list, or click one in the Sky Overlay and press Explore. Images are downloaded once and kept for offline use.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

/** Deep Space: object photos and facts, and the 3D solar system. The Sky Overlay links in with
 * ?view=solar&t=<photo time>&focus=<body>, or ?kind=&key= for one object. */
export function DeepSpace(): ReactElement {
  const [params] = useSearchParams()
  const view = params.get('view') === 'solar' ? 'solar' : 'objects'
  const t = params.get('t')
  const photoMs = t ? Date.parse(t) : NaN
  const fromPhoto = Number.isFinite(photoMs)
  // The solar system keeps its start time for as long as the page is open, not per re-render.
  const [startMs] = useState(() => (fromPhoto ? photoMs : Date.now()))
  const latParam = Number(params.get('lat'))
  const lonParam = Number(params.get('lon'))
  const showParam = params.get('show')
  const viewAt =
    params.get('lat') !== null && params.get('lon') !== null && Number.isFinite(latParam) && Number.isFinite(lonParam)
      ? { latDeg: latParam, lonDeg: lonParam, ...(showParam === 'quakes' ? { show: 'quakes' as const } : showParam === 'volcanoes' ? { show: 'volcanoes' as const } : {}) }
      : null
  const satParam = Number(params.get('sat'))
  const followSat = Number.isInteger(satParam) && satParam > 0 ? satParam : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {view === 'solar' ? <SolarSystemView startMs={startMs} fromPhoto={fromPhoto} focus={followSat === null && !viewAt ? params.get('focus') : null} followSat={followSat} viewAt={viewAt} /> : <ObjectBrowser />}
      </div>
    </div>
  )
}
