import { useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { deepspaceSrc } from '@renderer/lib/api'
import { useObjectInfo } from '@renderer/lib/deepspace'
import type { SkyObjectRef } from '@renderer/lib/skyPick'
import { DeepImage } from './DeepImage'

interface Props {
  objects: SkyObjectRef[]
  onClose: () => void
  style?: React.CSSProperties
  /** the photo's observation time (ISO, UTC), so the solar-system view opens at that moment */
  utc?: string
}

const SHORT_FACTS = 3
const DESCRIPTION_CHARS = 200

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, s.lastIndexOf(' ', n) > 0 ? s.lastIndexOf(' ', n) : n)}…`)

/** Pops up over the Sky Overlay when you click an object: a thumbnail, a few facts and a
 * button into the full Deep Space view. */
export function ObjectInfoCard({ objects, onClose, style, utc }: Props): ReactElement {
  const [sel, setSel] = useState(0)
  const navigate = useNavigate()
  const obj = objects[Math.min(sel, objects.length - 1)]
  const { info, loading, error } = useObjectInfo(obj.kind, obj.key)
  const hero = info?.images[0]

  return (
    <div className="absolute z-20 w-72 overflow-hidden rounded-md border border-border bg-surface text-xs shadow-xl" style={style} onPointerDown={(e) => e.stopPropagation()}>
      {objects.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b border-border p-1.5">
          {objects.map((o, i) => (
            <button
              key={`${o.kind}-${o.key}`}
              onClick={() => setSel(i)}
              className={`max-w-full truncate rounded px-1.5 py-0.5 ${i === sel ? 'bg-accent/25 text-text' : 'text-text-muted hover:text-text'}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      <DeepImage src={hero ? deepspaceSrc(hero.src) : null} alt={obj.label} className="h-36 w-full" />
      {hero && (
        <div className="truncate px-2 pt-1 text-[10px] text-text-muted" title={`${hero.credit} · ${hero.license}`}>
          {hero.credit} · {hero.license}
        </div>
      )}
      <div className="p-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-text">{info?.title ?? obj.label}</div>
            <div className="truncate text-text-muted">{info?.subtitle ?? obj.sub}</div>
          </div>
          <button onClick={onClose} title="Close" className="shrink-0 px-1 text-base leading-none text-text-muted hover:text-text">
            ×
          </button>
        </div>
        {loading && <div className="mt-2 text-text-muted">Loading details…</div>}
        {error && <div className="mt-2 text-danger">Could not load details.</div>}
        {info && (
          <>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              {info.facts.slice(0, SHORT_FACTS).map((f) => (
                <div key={f.label} className="contents">
                  <dt className="text-text-muted">{f.label}</dt>
                  <dd className="text-text">{f.value}</dd>
                </div>
              ))}
            </dl>
            {info.description && <p className="mt-2 leading-snug text-text-muted">{clip(info.description, DESCRIPTION_CHARS)}</p>}
            {info.offline && <p className="mt-2 text-warning">Offline: showing what is cached. Connect to load photos and the description.</p>}
          </>
        )}
        <button
          onClick={() => navigate(`/deep-space?kind=${obj.kind}&key=${encodeURIComponent(obj.key)}`)}
          className="mt-3 w-full rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg"
        >
          Explore
        </button>
        {(obj.kind === 'dso' || (obj.kind === 'star' && info && info.title !== 'Star')) && (
          <button
            onClick={() => navigate(`/deep-space?view=solar&focus=${encodeURIComponent(`${obj.kind === 'dso' ? 'dso' : 'star'}:${obj.key}`)}${utc ? `&t=${encodeURIComponent(utc)}` : ''}`)}
            className="mt-1.5 w-full rounded-md border border-border px-3 py-1.5 text-sm text-text hover:border-accent"
          >
            Fly to it in 3D
          </button>
        )}
        {obj.kind === 'body' && (
          <button
            onClick={() => navigate(`/deep-space?view=solar&focus=${obj.key}${utc ? `&t=${encodeURIComponent(utc)}` : ''}`)}
            className="mt-1.5 w-full rounded-md border border-border px-3 py-1.5 text-sm text-text hover:border-accent"
          >
            Show in solar system
          </button>
        )}
      </div>
    </div>
  )
}
