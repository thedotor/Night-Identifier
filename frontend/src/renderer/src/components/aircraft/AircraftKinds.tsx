import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { AIRCRAFT_KINDS, SHAPE_PATHS, asKind, type AircraftKind, type AircraftShape } from '@renderer/lib/aircraftIcons'
import { nsKey } from '@renderer/lib/storeNs'

const HIDDEN_KEY = 'night-identifier:aircraft-hidden-kinds'

function readHidden(): Set<AircraftKind> {
  try {
    const raw = JSON.parse(localStorage.getItem(nsKey(HIDDEN_KEY)) ?? '[]') as unknown
    return new Set(Array.isArray(raw) ? raw.map(asKind) : [])
  } catch {
    return new Set()
  }
}

export interface AircraftKindFilter {
  /** the kinds switched off (all are on the first time) */
  hidden: ReadonlySet<AircraftKind>
  setKind: (kind: AircraftKind, on: boolean) => void
  setAll: (on: boolean) => void
}

/** Which kinds of aircraft to show. Remembered, and the same for the sky overlay in Live View and the 3D Earth. */
export function useAircraftKinds(): AircraftKindFilter {
  const [hidden, setHidden] = useState<ReadonlySet<AircraftKind>>(readHidden)
  const commit = useCallback((next: Set<AircraftKind>) => {
    try {
      localStorage.setItem(nsKey(HIDDEN_KEY), JSON.stringify([...next]))
    } catch {
      /* not remembered */
    }
    setHidden(next)
  }, [])
  const setKind = useCallback(
    (kind: AircraftKind, on: boolean) => {
      const next = new Set(hidden)
      if (on) next.delete(kind)
      else next.add(kind)
      commit(next)
    },
    [hidden, commit]
  )
  const setAll = useCallback((on: boolean) => commit(on ? new Set() : new Set(AIRCRAFT_KINDS.map((k) => k.kind))), [commit])
  return useMemo(() => ({ hidden, setKind, setAll }), [hidden, setKind, setAll])
}

/** A little picture of one shape in one colour. */
export function AircraftIcon({ shape, colour, size = 16 }: { shape: AircraftShape; colour: string; size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="-32 -32 64 64" aria-hidden className="shrink-0">
      <g fill={colour} stroke="rgba(0,0,0,0.75)" strokeWidth={4} strokeLinejoin="round" paintOrder="stroke">
        {SHAPE_PATHS[shape].map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  )
}

/**
 * One tick box per kind, each with its icon, colour and how many there are. `counts` are the aircraft in view (or in the feed); kinds with
 * none are still listed, so the choice is there before the first one shows up.
 */
export function AircraftKindRows({
  filter,
  counts,
  compact = false
}: {
  filter: AircraftKindFilter
  counts: Partial<Record<AircraftKind, number>>
  compact?: boolean
}): ReactElement {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-3 text-[11px]">
        <span className="text-text-muted">Show</span>
        <button className="text-accent hover:underline" onClick={() => filter.setAll(true)}>
          all
        </button>
        <button className="text-accent hover:underline" onClick={() => filter.setAll(false)}>
          none
        </button>
      </div>
      {AIRCRAFT_KINDS.map((k) => (
        <label key={k.kind} className={`flex cursor-pointer items-center gap-2 rounded px-1 ${compact ? 'py-0' : 'py-0.5'} hover:bg-accent/10 hover:text-text`} title={k.hint}>
          <input type="checkbox" className="accent-accent" checked={!filter.hidden.has(k.kind)} onChange={(e) => filter.setKind(k.kind, e.target.checked)} />
          <AircraftIcon shape={k.shape} colour={k.colour} />
          <span className="min-w-0 flex-1 truncate">{k.label}</span>
          <span className="tabular-nums text-text-muted">{(counts[k.kind] ?? 0).toLocaleString()}</span>
        </label>
      ))}
    </div>
  )
}
