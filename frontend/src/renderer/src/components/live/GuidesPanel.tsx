import type { ReactElement } from 'react'
import type { Overlays } from './FeedCanvas'

const ROWS: { key: keyof Omit<Overlays, 'framePct'>; label: string; hint: string }[] = [
  { key: 'crosshair', label: 'Crosshair', hint: 'Centre lines: put your target on the crossing.' },
  { key: 'circle', label: 'Centre circle', hint: 'Helps judge field rotation and edge distortion.' },
  { key: 'thirds', label: 'Rule of thirds', hint: 'For composition.' },
  { key: 'grid', label: 'Fine grid', hint: 'A 10 x 10 grid to check tilt and alignment.' },
  { key: 'frame', label: 'Framing box', hint: 'A dashed box showing where a smaller sensor or crop would land.' }
]

export function GuidesPanel({ overlays, onChange }: { overlays: Overlays; onChange: (o: Overlays) => void }): ReactElement {
  return (
    <div className="space-y-3">
      {ROWS.map((r) => (
        <label key={r.key} className="flex items-start gap-2 text-xs text-text">
          <input type="checkbox" className="mt-0.5" checked={overlays[r.key]} onChange={(e) => onChange({ ...overlays, [r.key]: e.target.checked })} />
          <span>
            {r.label}
            <span className="block text-[11px] text-text-muted">{r.hint}</span>
          </span>
        </label>
      ))}
      {overlays.frame && (
        <label className="block text-xs text-text-muted">
          <span className="flex justify-between">
            Framing box size <span className="tabular-nums text-text">{overlays.framePct}%</span>
          </span>
          <input
            type="range"
            min={10}
            max={100}
            value={overlays.framePct}
            className="w-full accent-[rgb(var(--color-accent))]"
            onChange={(e) => onChange({ ...overlays, framePct: Number(e.target.value) })}
          />
        </label>
      )}
      <p className="text-[11px] leading-snug text-text-muted">Guides are drawn over the picture only; they are never saved into captured images.</p>
    </div>
  )
}
