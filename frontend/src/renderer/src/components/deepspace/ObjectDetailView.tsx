import { useEffect, useRef, useState, type ReactElement } from 'react'
import { deepspaceSrc, type DeepSpaceKind } from '@renderer/lib/api'
import { useObjectInfo } from '@renderer/lib/deepspace'
import { DeepImage } from './DeepImage'

interface Props {
  kind: DeepSpaceKind
  objectKey: string
}

interface Pan {
  s: number
  x: number
  y: number
}

const MAX_SCALE = 12

/** Full view of one object: a pan/zoom image viewer with a gallery, facts and description.
 * Every image carries its credit and licence. */
export function ObjectDetailView({ kind, objectKey }: Props): ReactElement {
  const { info, loading, error } = useObjectInfo(kind, objectKey)
  const [index, setIndex] = useState(0)
  const [pan, setPan] = useState<Pan>({ s: 1, x: 0, y: 0 })
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    setIndex(0)
    setPan({ s: 1, x: 0, y: 0 })
  }, [kind, objectKey])
  useEffect(() => setPan({ s: 1, x: 0, y: 0 }), [index])

  // Native listener: React's onWheel is passive, and we need preventDefault to stop the page scrolling.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const wheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      setPan((p) => {
        const s = Math.min(MAX_SCALE, Math.max(1, p.s * Math.exp(-e.deltaY * 0.0015)))
        const f = s / p.s
        return s === 1 ? { s, x: 0, y: 0 } : { s, x: px - (px - p.x) * f, y: py - (py - p.y) * f }
      })
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [info])

  const images = info?.images ?? []
  const current = images[Math.min(index, images.length - 1)]

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col bg-black">
        <div
          ref={box}
          className="relative min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, y: e.clientY }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d) return
            const dx = e.clientX - d.x
            const dy = e.clientY - d.y
            drag.current = { x: e.clientX, y: e.clientY }
            setPan((p) => (p.s === 1 ? p : { ...p, x: p.x + dx, y: p.y + dy }))
          }}
          onPointerUp={() => (drag.current = null)}
          onDoubleClick={() => setPan({ s: 1, x: 0, y: 0 })}
        >
          <div className="absolute inset-0 origin-top-left" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${pan.s})` }}>
            <DeepImage src={current ? deepspaceSrc(current.src) : null} alt={info?.title ?? ''} fit="contain" className="h-full w-full !bg-black" />
          </div>
          {loading && <div className="absolute left-3 top-3 rounded bg-black/60 px-2 py-1 text-xs text-white/80">Loading…</div>}
          {current && (
            <div className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-2 py-1 text-[10px] text-white/70">
              Wheel to zoom · drag to pan · double-click to reset
            </div>
          )}
        </div>

        {current && (
          <div className="shrink-0 border-t border-border bg-surface px-3 py-2 text-[11px] text-text-muted">
            {current.caption && <div className="mb-0.5 text-text">{current.caption}</div>}
            <span>{current.credit}</span> · <span>{current.license}</span>
            {current.source_url && (
              <>
                {' · '}
                <a href={current.source_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  Source
                </a>
              </>
            )}
          </div>
        )}

        {images.length > 1 && (
          <div className="flex shrink-0 gap-2 overflow-x-auto border-t border-border bg-surface p-2">
            {images.map((im, i) => (
              <button
                key={im.src}
                onClick={() => setIndex(i)}
                title={im.kind === 'survey' ? 'Sky survey image' : im.caption || im.credit}
                className={`h-16 w-24 shrink-0 overflow-hidden rounded border ${i === index ? 'border-accent' : 'border-border opacity-70 hover:opacity-100'}`}
              >
                <DeepImage src={deepspaceSrc(im.src)} alt="" className="h-full w-full" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="w-80 shrink-0 overflow-y-auto border-l border-border bg-surface p-4">
        {error && <div className="text-sm text-danger">Could not load this object.</div>}
        {!info && loading && <div className="text-sm text-text-muted">Loading details…</div>}
        {info && (
          <>
            <h2 className="text-lg font-semibold text-text">{info.title}</h2>
            <div className="text-xs text-text-muted">{info.subtitle}</div>
            {info.offline && (
              <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-text">
                No connection to the image archives, so this is only what was already saved. Use Settings → Deep Space to download an offline pack.
              </div>
            )}
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              {info.facts.map((f) => (
                <div key={f.label} className="contents">
                  <dt className="text-text-muted">{f.label}</dt>
                  <dd className="text-text">{f.value}</dd>
                </div>
              ))}
            </dl>
            {info.description && (
              <>
                <p className="mt-4 text-sm leading-relaxed text-text">{info.description}</p>
                {info.description_url && (
                  <a href={info.description_url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-accent hover:underline">
                    Read more on Wikipedia
                  </a>
                )}
              </>
            )}
            {!info.description && !info.offline && <p className="mt-4 text-xs text-text-muted">No description is available for this object.</p>}
          </>
        )}
      </div>
    </div>
  )
}
