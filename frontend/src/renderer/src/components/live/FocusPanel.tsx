import { useEffect, useRef, type ReactElement } from 'react'
import type { FocusData } from '@renderer/lib/liveApi'
import { btn } from './ui'

export interface FocusSample {
  t: number
  fwhm: number | null
  sharp: number
}

const W = 260
const H = 70

function ZoomBox({ getBitmap, point, tick, guide }: { getBitmap: () => ImageBitmap | null; point: { fx: number; fy: number } | null; tick: number; guide: boolean }): ReactElement {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const bmp = getBitmap()
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    if (!bmp) return
    const p = point ?? { fx: 0.5, fy: 0.5 }
    const half = 32 // source pixels either side of the point: an 8x magnifier on a 512px canvas
    const cx = Math.round(p.fx * bmp.width)
    const cy = Math.round(p.fy * bmp.height)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(bmp, cx - half, cy - half, half * 2, half * 2, 0, 0, canvas.width, canvas.height)
    if (guide) {
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(canvas.width / 2, 0)
      ctx.lineTo(canvas.width / 2, canvas.height)
      ctx.moveTo(0, canvas.height / 2)
      ctx.lineTo(canvas.width, canvas.height / 2)
      ctx.stroke()
    }
  }, [getBitmap, point, tick, guide])
  return <canvas ref={ref} width={256} height={256} className="w-full rounded-md border border-border bg-black" />
}

interface Props {
  latest: FocusData | null | undefined
  history: FocusSample[]
  onClear: () => void
  getBitmap: () => ImageBitmap | null
  point: { fx: number; fy: number } | null
  tick: number
  bahtinov: boolean
  onBahtinov: (on: boolean) => void
}

export function FocusPanel({ latest, history, onClear, getBitmap, point, tick, bahtinov, onBahtinov }: Props): ReactElement {
  const values = history.map((s) => s.fwhm).filter((v): v is number => v !== null)
  const best = values.length ? Math.min(...values) : null
  const worst = values.length ? Math.max(...values) : null
  const span = best !== null && worst !== null && worst > best ? worst - best : 1
  const pts = history
    .map((s, i) => {
      if (s.fwhm === null) return null
      const x = (i / Math.max(history.length - 1, 1)) * W
      const y = H - 6 - ((s.fwhm - (best ?? 0)) / span) * (H - 14)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .filter(Boolean)
    .join(' ')

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border p-3 text-center">
        <div className="text-[11px] uppercase tracking-wide text-text-muted">Star size (FWHM)</div>
        <div className="text-3xl font-semibold tabular-nums text-text">{latest?.fwhm != null ? `${latest.fwhm.toFixed(2)} px` : '—'}</div>
        <div className="mt-1 text-[11px] text-text-muted">
          {latest ? `${latest.stars} star${latest.stars === 1 ? '' : 's'} measured · sharpness ${latest.sharp.toFixed(2)}` : 'Measuring…'}
        </div>
        {latest && latest.fwhm === null && (
          <div className="mt-1 text-[11px] text-warning">No stars found. On a daytime or indoor scene, use the sharpness number instead (higher is sharper).</div>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-[11px] text-text-muted">
          <span>Last {history.length} readings (lower = sharper)</span>
          <button className={btn} onClick={onClear}>
            Reset
          </button>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md border border-border bg-bg">
          {pts && <polyline points={pts} fill="none" stroke="rgb(var(--color-accent))" strokeWidth={1.5} />}
        </svg>
        <div className="mt-1 flex justify-between text-[11px] text-text-muted">
          <span>Best: {best !== null ? best.toFixed(2) : '—'}</span>
          <span>Now: {latest?.fwhm != null ? latest.fwhm.toFixed(2) : '—'}</span>
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-[11px] text-text-muted">
          <span>Magnifier: click a star in the picture</span>
        </div>
        <ZoomBox getBitmap={getBitmap} point={point} tick={tick} guide={bahtinov} />
        <label className="mt-2 flex items-center gap-2 text-xs text-text-muted">
          <input type="checkbox" checked={bahtinov} onChange={(e) => onBahtinov(e.target.checked)} />
          Centre guide lines (for a Bahtinov mask: make the crossing spike sit in the middle)
        </label>
      </div>
    </div>
  )
}
