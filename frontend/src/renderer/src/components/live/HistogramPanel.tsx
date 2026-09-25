import { useMemo, useState, type ReactElement } from 'react'
import type { HistogramData, StretchSpec } from '@renderer/lib/liveApi'
import { btn, btnActive } from './ui'

interface Props {
  hist: HistogramData | undefined
  bits: number | undefined
  stretch: StretchSpec
  onStretch: (s: StretchSpec) => void
}

const W = 260
const H = 90

export function HistogramPanel({ hist, bits, stretch, onStretch }: Props): ReactElement {
  const [log, setLog] = useState(true)

  const path = useMemo(() => {
    if (!hist) return ''
    const n = hist.bins.length
    const pts = hist.bins.map((v, i) => {
      const y = log ? Math.log1p(v * 500) / Math.log1p(500) : v
      return `${((i / (n - 1)) * W).toFixed(1)},${(H - y * (H - 2)).toFixed(1)}`
    })
    return `M0,${H} L${pts.join(' L')} L${W},${H} Z`
  }, [hist, log])

  const set = (patch: Partial<StretchSpec>): void => onStretch({ ...stretch, ...patch })
  const maxLevel = bits ? (1 << Math.min(bits, 30)) - 1 : 255

  return (
    <div className="space-y-3">
      <div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md border border-border bg-bg">
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={W * f} x2={W * f} y1={0} y2={H} stroke="rgb(var(--color-border))" strokeWidth={1} />
          ))}
          <path d={path} fill="rgb(var(--color-accent) / 0.45)" stroke="rgb(var(--color-accent))" strokeWidth={1} />
          {stretch.mode === 'manual' && (
            <>
              <line x1={stretch.black * W} x2={stretch.black * W} y1={0} y2={H} stroke="rgb(var(--color-warning))" strokeWidth={1.5} />
              <line x1={stretch.white * W} x2={stretch.white * W} y1={0} y2={H} stroke="rgb(var(--color-warning))" strokeWidth={1.5} />
            </>
          )}
        </svg>
        <div className="mt-1 flex justify-between text-[10px] text-text-muted">
          <span>0</span>
          <span>{bits ? `${bits}-bit · full scale ${maxLevel}` : ''}</span>
          <span>max</span>
        </div>
      </div>

      {hist && (
        <dl className="grid grid-cols-3 gap-2 text-center text-[11px]">
          <div className="rounded-md border border-border py-1">
            <dt className="text-text-muted">Median</dt>
            <dd className="text-text">{(hist.median * 100).toFixed(1)}%</dd>
          </div>
          <div className="rounded-md border border-border py-1">
            <dt className="text-text-muted">Brightest</dt>
            <dd className="text-text">{(hist.max * 100).toFixed(0)}%</dd>
          </div>
          <div className={`rounded-md border py-1 ${hist.clipped > 0.5 ? 'border-warning' : 'border-border'}`}>
            <dt className="text-text-muted">Clipped</dt>
            <dd className={hist.clipped > 0.5 ? 'text-warning' : 'text-text'}>{hist.clipped.toFixed(2)}%</dd>
          </div>
        </dl>
      )}

      <label className="flex items-center gap-2 text-xs text-text-muted">
        <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} />
        Log scale (shows faint detail)
      </label>

      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Display stretch</div>
        <div className="flex gap-1">
          {(['auto', 'off', 'manual'] as const).map((m) => (
            <button key={m} className={stretch.mode === m ? btnActive : btn} onClick={() => set({ mode: m })}>
              {m === 'auto' ? 'Auto' : m === 'off' ? 'Linear' : 'Manual'}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] leading-snug text-text-muted">
          {stretch.mode === 'auto' && 'Brightens faint stars automatically. The saved data is not changed by this.'}
          {stretch.mode === 'off' && 'The raw brightness exactly as the sensor reports it. Dim scenes look dark.'}
          {stretch.mode === 'manual' && 'Choose the black and white points and the midtone yourself.'}
        </p>
      </div>

      {stretch.mode === 'manual' && (
        <div className="space-y-2 text-xs">
          {(
            [
              ['black', 'Black point', 0, 0.99],
              ['white', 'White point', 0.01, 1],
              ['mid', 'Midtones', 0.02, 0.98]
            ] as const
          ).map(([key, label, lo, hi]) => (
            <label key={key} className="block text-text-muted">
              <span className="flex justify-between">
                {label}
                <span className="tabular-nums text-text">{stretch[key].toFixed(3)}</span>
              </span>
              <input
                type="range"
                min={lo}
                max={hi}
                step={0.001}
                value={stretch[key]}
                className="w-full accent-[rgb(var(--color-accent))]"
                onChange={(e) => set({ [key]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
