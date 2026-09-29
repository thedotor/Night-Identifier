import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { MIN_H, type useDashboardLayout } from './useDashboardLayout'
import { WIDGET_BY_ID, WIDGETS, type DashData, type Span } from './widgets'

type Layout = ReturnType<typeof useDashboardLayout>

// Written out in full so Tailwind sees every class. Below the lg breakpoint there are two columns.
const SPAN_CLASS: Record<Span, string> = {
  1: 'col-span-1',
  2: 'col-span-2',
  3: 'col-span-2 lg:col-span-3',
  4: 'col-span-2 lg:col-span-4'
}

const GAP_PX = 16
/** Masonry packing: a fine-grained row track that every widget's real height is rounded up to, so a short widget's
 * grid cell ends exactly where its content does and a later, narrower widget can tuck in underneath it (`dense`
 * auto-flow) instead of being stuck below whatever the tallest widget in its row happens to be.
 * The vertical gap is baked into the span (not a margin) because grid auto-placement only knows about occupied
 * cells, not margins - a margin-bottom would bleed into whatever the dense algorithm packs into the next free
 * row, overlapping it. Reserving the gap as extra rows keeps every cell's true footprint collision-free. */
const ROW_PX = 4
const rowsFor = (px: number): number => Math.max(1, Math.ceil((px + GAP_PX) / ROW_PX))

const chip = 'rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] font-medium text-text-muted hover:border-accent hover:text-text disabled:opacity-30'

/** The widgets, in a four-column grid. In edit mode each one can be dragged to a new place, made wider or narrower, or removed. */
export function DashboardGrid({ layout, data, editing, onFullscreen }: { layout: Layout; data: DashData; editing: boolean; onFullscreen?: (on: boolean) => void }): ReactElement {
  const { items } = layout
  /** the widget that fills the whole window, if any */
  const [full, setFull] = useState<string | null>(null)
  const [width, setWidth] = useState(() => window.innerWidth)
  const setFullscreen = (id: string | null): void => {
    setFull(id)
    onFullscreen?.(id !== null)
  }
  useEffect(() => {
    if (full === null) return
    const key = (e: KeyboardEvent): void => {
      // Escape leaves fullscreen (unless something inside, like fly mode, is using it)
      if (e.key === 'Escape' && !document.pointerLockElement) setFullscreen(null)
    }
    const size = (): void => setWidth(window.innerWidth)
    window.addEventListener('keydown', key)
    window.addEventListener('resize', size)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('resize', size)
    }
  }, [full]) // eslint-disable-line react-hooks/exhaustive-deps
  const [dragId, setDragId] = useState<string | null>(null)
  const [sizing, setSizing] = useState<{ id: string; span: Span; h: number | null } | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  /** set the moment the corner is grabbed (state would be too late to stop the browser starting a drag) */
  const resizing = useRef(false)

  // ---------- masonry: each widget's real height, in row tracks ----------
  const [rowSpans, setRowSpans] = useState<Record<string, number>>({})
  const roRef = useRef<ResizeObserver | null>(null)
  if (!roRef.current) {
    roRef.current = new ResizeObserver((entries) => {
      setRowSpans((prev) => {
        let next: Record<string, number> | null = null
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.rsId
          if (!id) continue
          const span = rowsFor(entry.contentRect.height)
          if (prev[id] !== span) next = { ...(next ?? prev), [id]: span }
        }
        return next ?? prev
      })
    })
  }
  useEffect(() => () => roRef.current?.disconnect(), [])
  const itemEls = useRef(new Map<string, HTMLDivElement>())
  const setItemRef = (id: string) => (el: HTMLDivElement | null) => {
    const prev = itemEls.current.get(id)
    if (prev && prev !== el) {
      roRef.current?.unobserve(prev)
      itemEls.current.delete(id)
    }
    if (el && !itemEls.current.has(id)) {
      itemEls.current.set(id, el)
      el.dataset.rsId = id
      roRef.current?.observe(el)
    }
  }

  /** Drag the corner: the width snaps to whole columns, the height follows the pointer in steps of 8 px. */
  const startResize = (e: ReactPointerEvent<HTMLDivElement>, id: string, box: HTMLElement | null): void => {
    const grid = gridRef.current
    if (!grid || !box) return
    e.preventDefault()
    e.stopPropagation()
    resizing.current = true
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length
    const colW = (grid.getBoundingClientRect().width - GAP_PX * (cols - 1)) / cols
    const r = box.getBoundingClientRect()
    const start = { x: e.clientX, y: e.clientY, w: r.width, h: r.height }
    const current = layout.items.find((i) => i.id === id)
    let last = { span: current?.span ?? 1, h: current?.h ?? null }
    setSizing({ id, ...last })
    const move = (ev: PointerEvent): void => {
      const w = start.w + (ev.clientX - start.x)
      const span = Math.min(cols, Math.max(1, Math.round((w + GAP_PX) / (colW + GAP_PX)))) as Span
      const dy = ev.clientY - start.y
      // a vertical drag under a few pixels leaves the height alone, so a sideways drag does not fix the height by accident
      const h = Math.abs(dy) < 6 && last.h === (current?.h ?? null) ? last.h : Math.max(MIN_H, Math.round((start.h + dy) / 8) * 8)
      if (span !== last.span || h !== last.h) {
        last = { span, h }
        layout.setSize(id, span, h)
        setSizing({ id, span, h })
      }
    }
    const up = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      resizing.current = false
      setSizing(null)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  const onOver = (e: DragEvent<HTMLDivElement>, targetId: string): void => {
    if (!dragId || dragId === targetId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const r = e.currentTarget.getBoundingClientRect()
    const grid = e.currentTarget.parentElement?.getBoundingClientRect()
    // a widget that fills (nearly) the whole row is passed above / below; a narrow one, left / right
    const wide = grid ? r.width > grid.width * 0.6 : false
    const after = wide ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2
    layout.move(dragId, targetId, after)
  }

  return (
    <>
      <div ref={gridRef} className="grid grid-cols-2 items-start gap-x-4 lg:grid-cols-4" style={{ gridAutoRows: ROW_PX, gridAutoFlow: 'row dense' }}>
        {items.map((item, index) => {
          const def = WIDGET_BY_ID.get(item.id)
          if (!def) return null
          const isFull = full === item.id
          // the live 3D views fill the screen as they are; the other cards are enlarged so they read from across a room
          const zoom = isFull && !item.id.startsWith('earth-') ? Math.min(2.4, Math.max(1, width / 900)) : 1
          const rowSpan = rowSpans[item.id] ?? rowsFor(MIN_H)
          return (
            <div
              key={item.id}
              ref={setItemRef(item.id)}
              style={{
                ...(item.h && !isFull ? { height: item.h } : undefined),
                ...(isFull ? undefined : { gridRowEnd: `span ${rowSpan}` })
              }}
              className={`group min-w-0 ${isFull ? 'fixed inset-0 z-50 overflow-auto bg-bg px-3 pb-3 pt-10' : 'relative'} ${SPAN_CLASS[item.span]} ${editing ? 'cursor-grab select-none rounded-lg outline-dashed outline-1 outline-offset-2 outline-accent/60' : ''} ${dragId === item.id ? 'opacity-40' : ''}`}
              draggable={editing && !sizing}
              onDragStart={(e) => {
                if (resizing.current) {
                  e.preventDefault()
                  return
                }
                setDragId(item.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', item.id)
              }}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => onOver(e, item.id)}
              onDrop={(e) => e.preventDefault()}
            >
              {/* while editing the widget is only a picture of itself, so nothing inside reacts to clicks or steals the drag */}
              <div className={`h-full ${item.h || isFull ? 'overflow-auto [&>*]:min-h-full' : ''} ${editing ? 'pointer-events-none pt-8' : ''}`} style={zoom !== 1 ? ({ zoom } as CSSProperties) : undefined}>
                {def.render(data)}
              </div>
              {!editing && !def.heading && !isFull && (
                <div className="absolute -top-2.5 right-5 z-20 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] text-text-muted shadow hover:border-accent hover:text-text"
                    title={`Open ${def.title} in a window of its own, to move to another monitor`}
                    onClick={() => void window.api.card.open(item.id, def.title)}
                  >
                    ⧉ Pop out
                  </button>
                  <button
                    className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] text-text-muted shadow hover:border-accent hover:text-text"
                    title={`Make ${def.title} fill the whole window`}
                    onClick={() => setFullscreen(item.id)}
                  >
                    ⛶ Fullscreen
                  </button>
                </div>
              )}
              {isFull && (
                <button
                  className="fixed left-1/2 top-2 z-[60] -translate-x-1/2 rounded-full border border-accent bg-surface px-3 py-1 text-xs text-text shadow hover:bg-accent/20"
                  onClick={() => setFullscreen(null)}
                >
                  Exit fullscreen (Esc)
                </button>
              )}

              {editing && (
                <div
                  className="absolute bottom-0 right-0 z-10 flex h-5 w-5 cursor-nwse-resize touch-none items-end justify-end rounded-br-lg bg-accent/40 p-0.5 text-[10px] leading-none text-text hover:bg-accent"
                  title="Drag to resize: sideways changes the width (whole columns), up and down the height. Double-click for the height the content needs."
                  onPointerDown={(e) => startResize(e, item.id, e.currentTarget.parentElement)}
                  onMouseDown={(e) => e.preventDefault()}
                  onDragStart={(e) => e.preventDefault()}
                  onDoubleClick={() => layout.setSize(item.id, item.span, null)}
                  draggable={false}
                >
                  ◢
                </div>
              )}
              {editing && sizing?.id === item.id && (
                <div className="pointer-events-none absolute bottom-6 right-1 z-10 rounded bg-bg/90 px-1.5 py-0.5 text-[11px] tabular-nums text-text">
                  {sizing.span} column{sizing.span > 1 ? 's' : ''}, {sizing.h ? `${sizing.h} px tall` : 'auto height'}
                </div>
              )}

              {editing && (
                <div className={`absolute inset-x-0 top-0 flex items-center justify-between gap-1 rounded-t-lg px-1.5 py-1 backdrop-blur-sm ${def.heading ? 'bg-accent/15' : 'bg-bg/80'}`}>
                  <span className="truncate text-[11px] font-semibold text-text">⠿ {def.title}</span>
                  <div className="flex shrink-0 items-center gap-1">
                    <button className={chip} title="Move earlier" disabled={index === 0} onClick={() => layout.shift(item.id, -1)}>
                      ‹
                    </button>
                    <button className={chip} title="Move later" disabled={index === items.length - 1} onClick={() => layout.shift(item.id, 1)}>
                      ›
                    </button>
                    <span className={`mx-0.5 flex overflow-hidden rounded border border-border ${def.heading ? 'hidden' : ''}`} title="Width, in columns">
                      {([1, 2, 3, 4] as Span[]).map((s) => (
                        <button
                          key={s}
                          onClick={() => layout.resize(item.id, s)}
                          className={`px-1.5 py-0.5 text-[11px] font-medium ${item.span === s ? 'bg-accent/30 text-text' : 'bg-surface text-text-muted hover:text-text'}`}
                        >
                          {s}
                        </button>
                      ))}
                    </span>
                    <button className={`${chip} hover:!border-danger hover:!text-danger`} title="Remove from the dashboard" onClick={() => layout.remove(item.id)}>
                      ✕
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {editing && (
        // dropping here puts the dragged widget last - kept outside the masonry grid, or dense packing could
        // tuck it into an earlier gap instead of leaving it at the bottom where "last" actually belongs
        <div
          className={`mt-4 flex min-h-16 items-center justify-center rounded-lg border border-dashed text-xs ${dragId ? 'border-accent text-text' : 'border-border text-text-muted'}`}
          onDragOver={(e) => {
            if (!dragId) return
            e.preventDefault()
            layout.moveToEnd(dragId)
          }}
          onDrop={(e) => e.preventDefault()}
        >
          {items.length === 0 ? 'The dashboard is empty: use Add widget above.' : 'Drag a widget here to put it last'}
        </div>
      )}
    </>
  )
}

/** The "Add widget" tray: everything that is not on the dashboard right now, by group. */
export function AddWidgetTray({ hidden, onAdd }: { hidden: string[]; onAdd: (id: string) => void }): ReactElement {
  const groups = [...new Set(WIDGETS.filter((w) => hidden.includes(w.id)).map((w) => w.group))].sort((a, b) => (a === 'Layout' ? 1 : b === 'Layout' ? -1 : 0))
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Add a widget</div>
      {hidden.length === 0 ? (
        <div className="text-xs text-text-muted">Every widget is already on the dashboard.</div>
      ) : (
        <div className="space-y-2">
          {groups.map((g) => (
            <div key={g} className="flex flex-wrap items-center gap-2">
              <span className="w-32 shrink-0 text-[11px] uppercase tracking-wide text-text-muted">{g}</span>
              {WIDGETS.filter((w) => w.group === g && hidden.includes(w.id)).map((w) => (
                <button key={w.id} title={w.hint} onClick={() => onAdd(w.id)} className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-accent hover:text-text">
                  + {w.title}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
