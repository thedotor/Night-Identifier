import type { ReactElement } from 'react'

export interface Series {
  points: [number, number][]
  color: string
  label?: string
}

/**
 * A small time-series chart: one or more lines, an optional "now" marker, horizontal reference lines and a shaded band.
 * `points` are [t_ms, value]; the y range is fitted to the data unless `yMin` / `yMax` are given.
 */
export function LineChart({
  series,
  nowMs,
  refs = [],
  yMin,
  yMax,
  height = 96,
  unit = '',
  formatX
}: {
  series: Series[]
  nowMs?: number
  refs?: { y: number; label: string; color?: string }[]
  yMin?: number
  yMax?: number
  height?: number
  unit?: string
  formatX?: (t: number) => string
}): ReactElement {
  const W = 320
  const H = height
  const all = series.flatMap((s) => s.points)
  if (all.length < 2) return <div className="text-xs text-text-muted">No data yet</div>
  const x0 = Math.min(...all.map((p) => p[0]))
  const x1 = Math.max(...all.map((p) => p[0]))
  const ys = all.map((p) => p[1])
  let lo = yMin ?? Math.min(...ys, ...refs.map((r) => r.y))
  let hi = yMax ?? Math.max(...ys, ...refs.map((r) => r.y))
  if (hi - lo < 1e-9) {
    lo -= 1
    hi += 1
  }
  const pad = (hi - lo) * 0.08
  if (yMin === undefined) lo -= pad
  if (yMax === undefined) hi += pad
  const px = (t: number): number => ((t - x0) / Math.max(1, x1 - x0)) * W
  const py = (v: number): number => H - ((v - lo) / (hi - lo)) * H
  const path = (pts: [number, number][]): string => pts.map(([t, v], i) => `${i ? 'L' : 'M'}${px(t).toFixed(1)},${py(v).toFixed(1)}`).join(' ')
  const fx = formatX ?? ((t: number) => new Date(t).toLocaleString([], x1 - x0 > 2 * 86_400_000 ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' }))
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} role="img">
        {refs.map((r) => (
          <g key={r.label}>
            <line x1={0} x2={W} y1={py(r.y)} y2={py(r.y)} stroke={r.color ?? 'currentColor'} strokeOpacity={0.3} strokeDasharray="3 3" />
            <text x={W - 2} y={py(r.y) - 2} textAnchor="end" fontSize={9} fill={r.color ?? 'currentColor'} fillOpacity={0.7}>
              {r.label}
            </text>
          </g>
        ))}
        {nowMs !== undefined && nowMs >= x0 && nowMs <= x1 && <line x1={px(nowMs)} x2={px(nowMs)} y1={0} y2={H} stroke="currentColor" strokeOpacity={0.5} />}
        {series.map((s, i) => (
          <path key={i} d={path(s.points)} fill="none" stroke={s.color} strokeWidth={1.5} />
        ))}
        <text x={2} y={10} fontSize={9} fill="currentColor" fillOpacity={0.6}>
          {Math.round(hi)}
          {unit}
        </text>
        <text x={2} y={H - 2} fontSize={9} fill="currentColor" fillOpacity={0.6}>
          {Math.round(lo)}
          {unit}
        </text>
      </svg>
      <div className="flex justify-between text-[10px] text-text-muted">
        <span>{fx(x0)}</span>
        {nowMs !== undefined && nowMs >= x0 && nowMs <= x1 && <span>now</span>}
        <span>{fx(x1)}</span>
      </div>
    </div>
  )
}
