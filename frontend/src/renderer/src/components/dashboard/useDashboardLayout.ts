import { useCallback, useState } from 'react'
import { DEFAULT_LAYOUT, WIDGET_BY_ID, type Span } from './widgets'

export interface LayoutItem {
  id: string
  span: Span
  /** a height in pixels set by dragging the corner; without one the widget is as tall as its content */
  h?: number
}

export interface DefaultItem {
  id: string
  span: Span
  h?: number
}

export const MIN_H = 80
export const MAX_H = 2400

const KEY = 'night-identifier:dashboard-layout'

const isSpan = (v: unknown): v is Span => v === 1 || v === 2 || v === 3 || v === 4

/** The layouts earlier versions started with. Someone whose saved layout is exactly one of these never rearranged anything, so they get the tidier one. */
const OLD_DEFAULTS: string[] = [
  'h-status:4 backend:1 gpu:1 model:1 map50:1 h-sky:4 tonight:1 planets:1 weather:2 h-events:4 events-tonight:2 events-upcoming:2 events-week:4 h-space:4 iss:2 lightning:2 traffic:2 h-aurora:4 aurora:2 space-weather:2 field-wind:2 wind-forecast:2 h-sun:4 sun:2 sun-activity:2 h-library:4 cameras:2 pending:1 library-images:1 processed:1 geotagged:1 storage:2 h-training:4 training-images:1 object-types:1 annotations:1 training-runs:1',
  'h-status:4 backend:1 gpu:1 model:1 map50:1 h-sky:4 tonight:1 planets:1 weather:2 h-space:4 iss:2 lightning:2 h-aurora:4 aurora:2 space-weather:2 field-wind:2 wind-forecast:2 h-sun:4 sun:2 sun-activity:2 h-library:4 cameras:2 pending:1 library-images:1 processed:1 geotagged:1 storage:2 h-training:4 training-images:1 object-types:1 annotations:1 training-runs:1',
  'h-status:4 backend:1 gpu:1 model:1 map50:1 h-sky:4 tonight:1 planets:1 weather:2 h-space:4 iss:2 lightning:2 h-aurora:4 aurora:2 space-weather:2 h-sun:4 sun:2 sun-activity:2 h-library:4 cameras:2 pending:1 library-images:1 processed:1 geotagged:1 storage:2 h-training:4 training-images:1 object-types:1 annotations:1 training-runs:1',
  'h-status:4 backend:1 gpu:1 model:1 map50:1 h-sky:4 tonight:1 planets:1 weather:2 h-space:4 iss:2 lightning:2 h-aurora:4 aurora:2 space-weather:2 h-library:4 cameras:2 pending:1 library-images:1 processed:1 geotagged:1 storage:2 h-training:4 training-images:1 object-types:1 annotations:1 training-runs:1',
  'h-status:4 backend:1 gpu:1 model:1 map50:1 h-sky:4 tonight:1 planets:1 weather:2 h-space:4 iss:2 lightning:2 h-library:4 cameras:2 pending:1 library-images:1 processed:1 geotagged:1 storage:2 h-training:4 training-images:1 object-types:1 annotations:1 training-runs:1',
  'backend:1 gpu:1 model:1 pending:1 iss:4 tonight:1 planets:1 weather:1 cameras:1 library-images:1 processed:1 geotagged:1 storage:1 training-images:1 object-types:1 annotations:1 training-runs:1 map50:1',
  'backend:1 gpu:1 model:1 pending:1 iss:4 tonight:1 planets:1 weather:1 lightning:2 cameras:1 library-images:1 processed:1 geotagged:1 storage:1 training-images:1 object-types:1 annotations:1 training-runs:1 map50:1'
]

function read(key: string, defaults: DefaultItem[]): LayoutItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as { v?: number; items?: { id?: unknown; span?: unknown; h?: unknown }[] } | null
    if (raw?.v !== 1 || !Array.isArray(raw.items)) return defaults
    const seen = new Set<string>()
    const items: LayoutItem[] = []
    for (const it of raw.items) {
      // widgets that no longer exist, and repeats, are dropped
      if (typeof it.id !== 'string' || !WIDGET_BY_ID.has(it.id) || seen.has(it.id)) continue
      seen.add(it.id)
      const h = typeof it.h === 'number' && it.h >= MIN_H && it.h <= MAX_H ? Math.round(it.h) : undefined
      items.push({ id: it.id, span: isSpan(it.span) ? it.span : WIDGET_BY_ID.get(it.id)!.defaultSpan, ...(h ? { h } : {}) })
    }
    if (key === KEY && OLD_DEFAULTS.includes(items.map((i) => `${i.id}:${i.span}`).join(' '))) {
      try {
        localStorage.setItem(key, JSON.stringify({ v: 1, items: defaults }))
      } catch {
        /* the new layout is used for this session */
      }
      return defaults
    }
    return items
  } catch {
    return defaults
  }
}

/** The dashboard's widgets, their order and widths; remembered between sessions. */
export function useDashboardLayout(opts: { key?: string; defaults?: DefaultItem[] } = {}): {
  items: LayoutItem[]
  hidden: string[]
  move: (id: string, targetId: string, after: boolean) => void
  moveToEnd: (id: string) => void
  shift: (id: string, by: -1 | 1) => void
  resize: (id: string, span: Span) => void
  /** width and height together, from the corner handle (`h` null: back to the content's own height) */
  setSize: (id: string, span: Span, h: number | null) => void
  remove: (id: string) => void
  add: (id: string) => void
  reset: () => void
} {
  const key = opts.key ?? KEY
  const defaults = opts.defaults ?? DEFAULT_LAYOUT
  const [items, setItems] = useState<LayoutItem[]>(() => read(key, defaults))

  const commit = useCallback((next: LayoutItem[]) => {
    setItems(next)
    try {
      localStorage.setItem(key, JSON.stringify({ v: 1, items: next }))
    } catch {
      /* kept for this session only */
    }
  }, [])

  const move = useCallback(
    (id: string, targetId: string, after: boolean) => {
      setItems((cur) => {
        const from = cur.findIndex((i) => i.id === id)
        if (from < 0 || id === targetId) return cur
        const without = cur.filter((i) => i.id !== id)
        const at = without.findIndex((i) => i.id === targetId)
        if (at < 0) return cur
        const next = [...without.slice(0, at + (after ? 1 : 0)), cur[from], ...without.slice(at + (after ? 1 : 0))]
        if (next.every((x, i) => x.id === cur[i].id)) return cur // no change: do not re-render mid-drag
        try {
          localStorage.setItem(key, JSON.stringify({ v: 1, items: next }))
        } catch {
          /* not remembered */
        }
        return next
      })
    },
    []
  )

  const moveToEnd = useCallback((id: string) => {
    setItems((cur) => {
      const it = cur.find((i) => i.id === id)
      if (!it || cur[cur.length - 1].id === id) return cur
      const next = [...cur.filter((i) => i.id !== id), it]
      try {
        localStorage.setItem(key, JSON.stringify({ v: 1, items: next }))
      } catch {
        /* not remembered */
      }
      return next
    })
  }, [])

  const setSize = useCallback((id: string, span: Span, h: number | null) => {
    setItems((cur) => {
      const next = cur.map((i) => {
        if (i.id !== id) return i
        const { h: _old, ...rest } = i
        void _old
        return { ...rest, span, ...(h ? { h: Math.min(MAX_H, Math.max(MIN_H, Math.round(h))) } : {}) }
      })
      if (next.every((x, i) => x.span === cur[i].span && x.h === cur[i].h)) return cur
      try {
        localStorage.setItem(key, JSON.stringify({ v: 1, items: next }))
      } catch {
        /* not remembered */
      }
      return next
    })
  }, [])

  const shift = useCallback(
    (id: string, by: -1 | 1) => {
      const i = items.findIndex((x) => x.id === id)
      const j = i + by
      if (i < 0 || j < 0 || j >= items.length) return
      const next = [...items]
      ;[next[i], next[j]] = [next[j], next[i]]
      commit(next)
    },
    [items, commit]
  )

  return {
    items,
    hidden: [...WIDGET_BY_ID.keys()].filter((id) => !items.some((i) => i.id === id)),
    move,
    moveToEnd,
    shift,
    resize: (id, span) => commit(items.map((i) => (i.id === id ? { ...i, span } : i))),
    setSize,
    remove: (id) => commit(items.filter((i) => i.id !== id)),
    add: (id) => {
      const w = WIDGET_BY_ID.get(id)
      if (w && !items.some((i) => i.id === id)) commit([...items, { id, span: w.defaultSpan }])
    },
    reset: () => commit(defaults)
  }
}
