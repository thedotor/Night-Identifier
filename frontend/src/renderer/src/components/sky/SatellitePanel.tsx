import type { ReactElement } from 'react'
import { fmtAge } from '@renderer/lib/satelliteText'
import { CROWDED_SKY, SAT_GROUPS, MAX_ELEMENT_AGE_DAYS, type SatGroupId, type SatOptions } from '@renderer/lib/satellites'
import type { SatClock, SatView } from './useSatellites'

interface Props {
  enabled: boolean
  onEnabled: (on: boolean) => void
  options: SatOptions
  onOptions: (patch: Partial<SatOptions>) => void
  view: Pick<SatView, 'stats' | 'cat' | 'loading' | 'error' | 'ageDays'>
  /** why nothing can be drawn yet ("location", "time"), or null */
  missing: string[]
  /** time controls for a still photo; a live camera has none */
  clock?: SatClock
  /** live camera: seconds the picture lags the computer's clock */
  lag?: { value: number; onChange: (s: number) => void }
}

const btn =
  'whitespace-nowrap rounded-md border border-border px-2 py-1 text-xs font-medium text-text-muted hover:border-accent hover:text-text disabled:opacity-50'
const btnOn = 'whitespace-nowrap rounded-md border border-accent bg-accent/25 px-2 py-1 text-xs font-medium text-text'

const pad = (n: number): string => String(n).padStart(2, '0')
const fmtUtc = (d: Date): string => d.toISOString().replace('T', ' ').slice(0, 19)
const fmtOffset = (s: number): string => {
  const a = Math.abs(Math.round(s))
  const h = Math.floor(a / 3600)
  const m = Math.floor((a % 3600) / 60)
  return `${s < 0 ? '−' : '+'}${h}:${pad(m)}:${pad(a % 60)}`
}

const TRAIL_CHOICES = [
  { s: 60, label: '1 min' },
  { s: 120, label: '2 min' },
  { s: 300, label: '5 min' },
  { s: 600, label: '10 min' }
]

function ClockControls({ clock }: { clock: SatClock }): ReactElement {
  return (
    <div className="space-y-2 rounded border border-border p-2">
      <div className="flex overflow-hidden rounded-md border border-border">
        {(
          [
            ['photo', 'Photo time', 'Where they were when the photo was taken'],
            ['live', 'Live now', 'Where they are right now'],
            ['scrub', 'Scrub', 'Move time forward or back around the photo']
          ] as const
        ).map(([m, label, tip]) => (
          <button
            key={m}
            onClick={() => clock.setMode(m)}
            title={tip}
            className={`flex-1 whitespace-nowrap px-1.5 py-1 font-medium ${clock.mode === m ? 'bg-accent/25 text-text' : 'text-text-muted hover:text-text'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {clock.date && (
        <div className="tabular-nums text-text-muted">
          {fmtUtc(clock.date)} UTC{clock.mode === 'scrub' ? ` (${fmtOffset(clock.offsetS)})` : ''}
        </div>
      )}
      {clock.mode === 'scrub' && (
        <>
          <input
            type="range"
            min={-10800}
            max={10800}
            step={60}
            value={Math.max(-10800, Math.min(10800, clock.offsetS))}
            onChange={(e) => {
              clock.setPlaying(false)
              clock.setOffsetS(Number(e.target.value))
            }}
            className="w-full"
          />
          <div className="flex items-center gap-1">
            <button className={btn} onClick={() => clock.setOffsetS(clock.offsetS - 60)} title="One minute back">−1m</button>
            <button className={btn} onClick={() => clock.setOffsetS(clock.offsetS + 60)} title="One minute forward">+1m</button>
            <button className={clock.playing ? btnOn : btn} onClick={() => clock.setPlaying(!clock.playing)}>
              {clock.playing ? '❚❚ Pause' : '▶ Play'}
            </button>
            <select value={clock.speed} onChange={(e) => clock.setSpeed(Number(e.target.value))} className="ml-auto rounded border border-border bg-bg px-1 py-0.5 text-text" title="Playback speed">
              {[1, 10, 30, 60, 300].map((v) => (
                <option key={v} value={v}>×{v}</option>
              ))}
            </select>
          </div>
          <div className="text-text-muted">The photo itself does not change; satellites move over it. The sky in the photo stays as it was.</div>
        </>
      )}
    </div>
  )
}

/** Satellite layer controls, shared by the Sky Overlay page and Live View. */
export function SatellitePanel({ enabled, onEnabled, options, onOptions, view, missing, clock, lag }: Props): ReactElement {
  const toggleGroup = (id: SatGroupId, on: boolean): void =>
    onOptions({ groups: on ? [...options.groups, id] : options.groups.filter((g) => g !== id) })
  const cat = view.cat

  return (
    <>
      {lag && (
        // Live View only: the ISS is drawn whatever the other settings, even under the horizon or out of the picture
        <label
          className="flex items-start gap-2 rounded border border-border p-2"
          title="Under the horizon its marker is dashed and sits where the camera would have to look; out of the picture an arrow at the edge points to it."
        >
          <input type="checkbox" className="mt-0.5" checked={options.pinIss} onChange={(e) => onOptions({ pinIss: e.target.checked })} />
          <span>
            <span className="text-text">Always show the ISS</span>
            <span className="block text-text-muted">Even under the horizon or off the edge of the picture: dashed marker, track and an arrow pointing to it.</span>
          </span>
        </label>
      )}
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} />
        Show satellites
      </label>
      {!enabled && <div className="text-text-muted">The ISS, bright satellites and Starlink, where they are in this sky. Orbit data is downloaded from CelesTrak the first time.</div>}
      {enabled && (
        <>
          {missing.length > 0 && (
            <div className="rounded border border-warning/50 p-2 text-warning">
              Satellites need this {missing.join(' and ')}, which is missing. {missing.includes('location') ? 'Enter the latitude and longitude of where it was taken. ' : ''}
              {missing.includes('time') ? 'Enter the UTC time.' : ''}
            </div>
          )}
          <div className="space-y-1">
            {SAT_GROUPS.map((g) => (
              <label key={g.id} className="flex items-center gap-2" title={g.hint}>
                <input type="checkbox" checked={options.groups.includes(g.id)} onChange={(e) => toggleGroup(g.id, e.target.checked)} />
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: g.color }} />
                <span className="min-w-0 flex-1 truncate">{g.label}</span>
                {options.groups.includes(g.id) && view.stats.total > 0 && <span className="tabular-nums text-text-muted">{view.stats.perBit[g.bit] ?? 0}</span>}
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2" title="Hide satellites that are in Earth's shadow. A camera cannot see them; otherwise they are drawn hollow and faint.">
            <input type="checkbox" checked={options.sunlitOnly} onChange={(e) => onOptions({ sunlitOnly: e.target.checked })} /> Sunlit only
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={options.trails} onChange={(e) => onOptions({ trails: e.target.checked })} /> Trails
            {options.trails && (
              <select
                value={options.trailSeconds}
                onChange={(e) => onOptions({ trailSeconds: Number(e.target.value) })}
                title="How far each trail reaches before and after the satellite"
                className="ml-auto rounded border border-border bg-bg px-1 py-0.5 text-text"
              >
                {TRAIL_CHOICES.map((c) => (
                  <option key={c.s} value={c.s}>± {c.label}</option>
                ))}
              </select>
            )}
          </label>
          {options.trails && view.stats.total > CROWDED_SKY && (
            <div className="text-text-muted">Crowded sky: only the bright ones and the one you pick keep a trail.</div>
          )}
          <label className="flex items-center gap-2" title="Otherwise only the bright ones and the one you pick get a name">
            <input type="checkbox" checked={options.labelAll} onChange={(e) => onOptions({ labelAll: e.target.checked })} /> Name every satellite
          </label>

          {clock && <ClockControls clock={clock} />}
          {lag && (
            <div className="space-y-1 rounded border border-border p-2">
              <label className="flex items-center justify-between gap-2" title="Network cameras and USB buffering delay the picture. If satellites run ahead of the picture, raise this.">
                <span className="text-text-muted">Camera delay</span>
                <span className="flex items-center gap-1">
                  <button className={btn} onClick={() => lag.onChange(Math.max(-10, +(lag.value - 0.5).toFixed(1)))}>−</button>
                  <span className="w-14 text-center tabular-nums text-text">{lag.value.toFixed(1)} s</span>
                  <button className={btn} onClick={() => lag.onChange(Math.min(30, +(lag.value + 0.5).toFixed(1)))}>+</button>
                </span>
              </label>
              <div className="text-text-muted">Seconds the picture is behind real time. Satellites move fast, so a couple of seconds shows.</div>
            </div>
          )}

          <div className="space-y-0.5 text-text-muted">
            {view.loading && <div>Loading orbit data…</div>}
            {view.error && <div className="text-danger">Could not load orbit data: {view.error}</div>}
            {!view.loading && !view.error && cat && missing.length === 0 && (
              <div>
                {view.stats.total} above the horizon{options.sunlitOnly ? `, ${view.stats.shown} sunlit` : ''}
                {cat.fetchedAt ? ` · orbit data ${fmtAge(cat.fetchedAt)}` : ''}
              </div>
            )}
            {cat && cat.missing.length > 0 && (
              <div className="text-warning">
                No orbit data for {cat.missing.join(', ')}
                {Object.values(cat.errors)[0] ? `: ${Object.values(cat.errors)[0]}` : ' (offline?)'}
              </div>
            )}
            {cat && cat.missing.length === 0 && cat.stale && <div className="text-warning">Orbit data could not be refreshed, so the last download is in use.</div>}
            {view.ageDays > MAX_ELEMENT_AGE_DAYS && (
              <div className="text-warning">
                The orbit data is {Math.round(view.ageDays)} days from this time. Orbits change too fast for that, so no satellites are shown.
              </div>
            )}
            {view.ageDays > 5 && view.ageDays <= MAX_ELEMENT_AGE_DAYS && (
              <div className="text-warning">The orbit data is {Math.round(view.ageDays)} days from this time; positions are approximate.</div>
            )}
            {cat && <div className="text-[10px]">{cat.credit}</div>}
          </div>
        </>
      )}
    </>
  )
}
