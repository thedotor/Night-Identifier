import { nsKey } from '@renderer/lib/storeNs'
import { useEffect, useState } from 'react'

export type PanelId = 'fieldwind' | 'sun' | 'aurora' | 'lightning' | 'traffic' | 'overhead' | 'asteroids' | 'launches'

/** The info boxes down the right of the Solar System, in the order they are stacked. */
export const PANELS: { id: PanelId; label: string }[] = [
  { id: 'fieldwind', label: 'Magnetic field and solar wind' },
  { id: 'sun', label: 'The Sun now' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'lightning', label: 'Lightning' },
  { id: 'traffic', label: 'Web traffic' },
  { id: 'overhead', label: 'Sun overhead' },
  { id: 'asteroids', label: 'Near-Earth asteroids' },
  { id: 'launches', label: 'Next launches' }
]

/** `shown`: the box is on screen at all. `open`: it is unfolded (false: just its title line). */
export interface PanelState {
  shown: boolean
  open: boolean
}
export type PanelsState = Record<PanelId, PanelState>

const KEY = 'night-identifier:solar-panels'
const DEFAULT: PanelsState = Object.fromEntries(PANELS.map((p) => [p.id, { shown: true, open: true }])) as PanelsState

function read(): PanelsState {
  try {
    const raw = JSON.parse(localStorage.getItem(nsKey(KEY)) ?? 'null') as Partial<Record<PanelId, Partial<PanelState>>> | null
    if (!raw) return DEFAULT
    return Object.fromEntries(PANELS.map((p) => [p.id, { shown: raw[p.id]?.shown !== false, open: raw[p.id]?.open !== false }])) as PanelsState
  } catch {
    return DEFAULT
  }
}

/** Which right-hand boxes are shown and which are folded, remembered between launches. */
export function usePanels(): { panels: PanelsState; update: (id: PanelId, patch: Partial<PanelState>) => void; setAllShown: (shown: boolean) => void } {
  const [panels, setPanels] = useState<PanelsState>(read)
  useEffect(() => {
    try {
      localStorage.setItem(nsKey(KEY), JSON.stringify(panels))
    } catch {
      /* not remembered */
    }
  }, [panels])
  return {
    panels,
    update: (id, patch) => setPanels((p) => ({ ...p, [id]: { ...p[id], ...patch } })),
    setAllShown: (shown) => setPanels((p) => Object.fromEntries(PANELS.map((x) => [x.id, { ...p[x.id], shown }])) as PanelsState)
  }
}
