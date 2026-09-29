import { useState, type ReactElement, type ReactNode } from 'react'
import * as S from '@renderer/lib/skyMath'
import { parseNumber } from '@renderer/lib/liveSky'
import type { Layers } from '@renderer/lib/skyRender'
import { SatellitePanel } from '@renderer/components/sky/SatellitePanel'
import { AircraftKindRows } from '@renderer/components/aircraft/AircraftKinds'
import type { LiveSky } from './useLiveSky'
import { btn, btnActive, btnPrimary, input } from './ui'

const DEG = Math.PI / 180

const LAYER_ROWS: [keyof Layers, string][] = [
  ['stars', 'Stars'],
  ['constellations', 'Constellation lines'],
  ['asterisms', 'Asterisms'],
  ['planets', 'Sun, Moon & planets'],
  ['nebulae', 'Nebulae'],
  ['galaxies', 'Galaxies'],
  ['clusters', 'Star clusters'],
  ['labels', 'Labels'],
  ['horizon', 'Horizon']
]

function Block({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className="border-t border-border pt-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{title}</div>
      <div className="space-y-2 text-xs text-text">{children}</div>
    </div>
  )
}

/** Number box that commits on Enter or blur, and follows the value when it changes underneath it. */
function NumField(props: { label: string; value: number; digits?: number; suffix?: string; onCommit: (v: number) => void; disabled?: boolean }): ReactElement {
  const shown = props.value.toFixed(props.digits ?? 1)
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-text-muted">{props.label}</span>
      <span className="flex items-center gap-1">
        <input
          key={shown}
          defaultValue={shown}
          disabled={props.disabled}
          onBlur={(e) => {
            const v = parseNumber(e.target.value)
            if (v !== null && v.toFixed(props.digits ?? 1) !== shown) props.onCommit(v)
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          className="w-20 rounded border border-border bg-bg px-1 py-0.5 text-right text-text disabled:opacity-50"
        />
        {props.suffix && <span className="w-3 text-text-muted">{props.suffix}</span>}
      </span>
    </label>
  )
}

function checkText(c: LiveSky['check']): string {
  if (c.busy) return 'Checking against the stars…'
  const r = c.result
  if (!r) return 'Not checked this visit.'
  if (r.verdict === 'ok') return `✓ Still lines up with the stars (${r.matched} of ${r.tested} matched).`
  if (r.verdict === 'off') return `✗ Does not line up any more (${r.matched} of ${r.tested} matched): the camera may have moved.`
  return 'Could not tell: too few stars visible right now.'
}

export function SkyPanel({ sky, running }: { sky: LiveSky; running: boolean }): ReactElement {
  const { settings, camera } = sky
  const { on, locked, tracking, alignment } = settings
  const [aim, setAim] = useState({ alt: '35', az: '180', tilt: '0' })
  const [fitFov, setFitFov] = useState(true)
  const [fitK1, setFitK1] = useState(false)
  const hasSite = sky.observer !== null

  const status = !on
    ? null
    : !alignment || !sky.aligned
      ? { tone: 'text-warning', text: 'Not aligned yet' }
      : locked
        ? { tone: 'text-success', text: tracking ? 'Locked · holding still (tracking mount)' : 'Locked · following the sky in real time' }
        : { tone: 'text-text', text: `Aligned ${alignment.how === 'auto' ? 'automatically' : 'by hand'} · following the sky in real time` }

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2 text-xs text-text">
        <input type="checkbox" className="mt-0.5" checked={on} onChange={(e) => sky.update({ on: e.target.checked })} />
        <span>
          <span className="font-medium">Star overlay</span>
          <span className="block text-[11px] text-text-muted">
            Draws stars, constellations, planets and deep-sky objects over the picture and moves them with the sky as it turns.
          </span>
        </span>
      </label>

      {on && (
        <>
          {!running && <div className="rounded border border-warning/50 p-2 text-[11px] text-warning">The camera is not running, so there is no picture to align to yet.</div>}
          {status && (
            <div className="flex items-center gap-2">
              <span className={`min-w-0 flex-1 text-xs font-medium ${status.tone}`}>{status.text}</span>
              <button
                className={locked ? btnActive : btnPrimary}
                disabled={!sky.aligned}
                onClick={() => sky.update({ locked: !locked })}
                title={locked ? 'Unlock to change the alignment' : 'Freeze the alignment. The overlay keeps following the sky, but the mouse no longer moves it.'}
              >
                {locked ? '🔒 Locked' : '🔓 Lock in place'}
              </button>
            </div>
          )}
          {alignment && sky.aligned && alignment.rmsPx !== undefined && (
            <div className="text-[11px] text-text-muted">
              {alignment.matched} stars fitted, RMS {alignment.rmsPx.toFixed(1)} px
            </div>
          )}
          {alignment && sky.aligned && (
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className={sky.check.result?.verdict === 'ok' ? 'text-success' : sky.check.result?.verdict === 'off' ? 'text-warning' : 'text-text-muted'}>{checkText(sky.check)}</span>
              <button className={btn} disabled={!running || sky.check.busy} onClick={() => void sky.runCheck()} title="Compare the stars in the picture with where the alignment says they should be">
                Check now
              </button>
            </div>
          )}
          {sky.message && <div className={`text-[11px] leading-snug ${sky.message.kind === 'error' ? 'text-danger' : 'text-text-muted'}`}>{sky.message.text}</div>}
          {!sky.ready && <div className="text-[11px] text-text-muted">Loading the sky catalogue…</div>}

          <fieldset disabled={locked} className={`space-y-3 ${locked ? 'opacity-60' : ''}`}>
            <Block title="Align automatically">
              <div className="text-[11px] leading-snug text-text-muted">
                Finds the stars in the current picture and matches them to the catalogue. Needs a night sky with a handful of visible stars.
              </div>
              <label className="flex items-center justify-between gap-2">
                <span className="text-text-muted">Lens</span>
                <select value={settings.lens} onChange={(e) => sky.setLens(e.target.value as S.Projection)} className="w-40 rounded border border-border bg-bg px-1 py-0.5 text-text">
                  {S.PROJECTIONS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <NumField
                label="Field of view (width)"
                value={camera ? camera.fovH / DEG : (parseNumber(settings.fovDeg) ?? 60)}
                suffix="°"
                onCommit={(v) => {
                  sky.update({ fovDeg: String(v) })
                  if (camera) sky.setFov(v)
                }}
              />
              <label className="flex items-center gap-2 text-text-muted" title="Tick this if the field of view above is close to right. Auto-align then only searches near it, which is quicker.">
                <input type="checkbox" checked={settings.fovKnown} onChange={(e) => sky.update({ fovKnown: e.target.checked })} />
                I know the field of view fairly well
              </label>
              <button className={`${btnPrimary} w-full`} disabled={!sky.ready || !running || sky.busy !== null} onClick={() => void sky.autoAlign()}>
                {sky.busy === 'auto' ? 'Solving…' : 'Auto-align'}
              </button>
            </Block>

            <Block title="Align by hand">
              <div className="flex overflow-hidden rounded-md border border-border">
                {(['move', 'pick'] as const).map((m) => (
                  <button key={m} onClick={() => sky.setMode(m)} className={`flex-1 px-2 py-1 font-medium ${sky.mode === m ? 'bg-accent/25 text-text' : 'text-text-muted hover:text-text'}`}>
                    {m === 'move' ? 'Move overlay' : 'Pick stars'}
                  </button>
                ))}
              </div>
              <div className="text-[11px] leading-snug text-text-muted">
                {sky.mode === 'move'
                  ? 'Drag on the picture to slide the sky onto the stars, scroll to scale it, Shift+drag to rotate. Space+drag pans the picture, Ctrl+scroll zooms it.'
                  : 'Click a star in the picture, then say which catalogue star it is. Two picks fix position and rotation; three or more also fit the field of view. Move the overlay near the right place first.'}
              </div>
              {sky.mode === 'pick' && (
                <>
                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {sky.pairs.map((p, i) => (
                      <div key={i} className="flex items-center gap-1 rounded border border-border px-1.5 py-1">
                        <span className="w-4 font-semibold text-warning">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate" title={p.label}>
                          {p.label}
                        </span>
                        <button onClick={() => sky.removePair(i)} className="text-text-muted hover:text-danger" title="Remove">
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  <label className="flex items-center gap-2" title="With three or more picks, also solve for the field of view">
                    <input type="checkbox" checked={fitFov} onChange={(e) => setFitFov(e.target.checked)} /> Fit field of view
                  </label>
                  <label className="flex items-center gap-2" title="Needs five or more picks spread across the frame">
                    <input type="checkbox" checked={fitK1} onChange={(e) => setFitK1(e.target.checked)} /> Fit lens distortion
                  </label>
                  <div className="flex gap-2">
                    <button className={`${btnPrimary} flex-1`} disabled={sky.pairs.length < 2 || sky.busy !== null} onClick={() => sky.fitPairs({ fitFov, fitK1 })}>
                      Fit camera ({sky.pairs.length})
                    </button>
                    <button className={btn} disabled={!sky.pairs.length} onClick={sky.clearPairs}>
                      Clear
                    </button>
                  </div>
                </>
              )}
              <div className="border-t border-border pt-2">
                <div className="mb-1 text-text-muted">Point by altitude / azimuth (compass bearing)</div>
                <div className="flex items-center gap-1">
                  {(['alt', 'az', 'tilt'] as const).map((k) => (
                    <label key={k} className="flex flex-1 flex-col gap-0.5 text-text-muted">
                      {k === 'alt' ? 'Altitude' : k === 'az' ? 'Azimuth' : 'Tilt'}
                      <input value={aim[k]} onChange={(e) => setAim({ ...aim, [k]: e.target.value })} className={input} />
                    </label>
                  ))}
                </div>
                <button
                  className={`${btn} mt-1 w-full`}
                  disabled={!hasSite || !camera}
                  title={hasSite ? '' : 'Enter your location below first'}
                  onClick={() => {
                    const alt = parseNumber(aim.alt)
                    const az = parseNumber(aim.az)
                    if (alt !== null && az !== null) sky.aim(alt, az, parseNumber(aim.tilt) ?? 0)
                  }}
                >
                  Aim camera
                </button>
              </div>
              {camera && (
                <label className="flex items-center justify-between gap-2" title="Radial lens distortion. Leave at 0 unless stars near the edges drift off.">
                  <span className="text-text-muted">Distortion k1</span>
                  <input type="range" min={-0.3} max={0.3} step={0.005} value={camera.k1} onChange={(e) => sky.setK1(Number(e.target.value))} className="w-24" />
                  <span className="w-10 text-right text-text-muted">{camera.k1.toFixed(3)}</span>
                </label>
              )}
              {sky.centreAltAz && (
                <div className="text-text-muted">
                  The middle of the picture is at altitude {sky.centreAltAz.alt.toFixed(1)}°, azimuth {sky.centreAltAz.az.toFixed(1)}°
                </div>
              )}
              <button className={`${btn} w-full`} disabled={!camera} onClick={sky.reset}>
                Reset alignment
              </button>
            </Block>
          </fieldset>

          <Block title="Where and how">
            <label className="flex items-center justify-between gap-2">
              <span className="text-text-muted">Latitude</span>
              <input value={settings.lat} onChange={(e) => sky.setPlace(e.target.value, settings.lon)} placeholder="e.g. 45.4" className="w-28 rounded border border-border bg-bg px-1 py-0.5 text-right text-text" />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-text-muted">Longitude</span>
              <input value={settings.lon} onChange={(e) => sky.setPlace(settings.lat, e.target.value)} placeholder="e.g. -75.7" className="w-28 rounded border border-border bg-bg px-1 py-0.5 text-right text-text" />
            </label>
            <div className="flex items-center justify-between gap-2 text-[11px] text-text-muted">
              <span>{settings.ownPlace ? 'Typed for this camera.' : hasSite ? 'From your saved location (the same as the Dashboard).' : 'No saved location yet: set one on the Dashboard, or type it here.'}</span>
              {settings.ownPlace && (
                <button className={btn} onClick={sky.followAppPlace} title="Go back to the location saved for the whole app">
                  Use my saved location
                </button>
              )}
            </div>
            <div className="text-[11px] leading-snug text-text-muted">
              {hasSite
                ? 'Used for the horizon, altitude/azimuth aiming, where the Moon appears and where satellites are. The stars follow the sky without it.'
                : 'Needed for satellites; also draws the horizon and lets you aim by altitude and azimuth. The stars follow the sky without it.'}
            </div>
            <label className="flex items-start gap-2" title="A camera on a star tracker or equatorial mount keeps the stars still in its picture, so the overlay must not turn.">
              <input type="checkbox" className="mt-0.5" checked={tracking} onChange={(e) => sky.setTracking(e.target.checked)} />
              <span>
                Camera is on a star tracker
                <span className="block text-[11px] text-text-muted">The stars hold still in the picture, so the overlay does too.</span>
              </span>
            </label>
          </Block>

          <Block title="Satellites">
            <SatellitePanel
              enabled={sky.sat.enabled}
              onEnabled={sky.sat.setEnabled}
              options={sky.sat.options}
              onOptions={sky.sat.setOptions}
              view={sky.sat.view}
              missing={sky.sat.missing}
              lag={{ value: sky.sat.lag, onChange: sky.sat.setLag }}
            />
          </Block>

          <Block title="Aircraft">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={sky.planes.enabled} onChange={(e) => sky.planes.setEnabled(e.target.checked)} />
              Show aircraft (live)
            </label>
            {!sky.planes.enabled && <div className="text-text-muted">Aircraft around the camera from live ADS-B reports: an icon for what each is (airliner, business jet, small plane, helicopter…) pointing the way it is heading, with its flight number, flight level and type. Needs an internet connection.</div>}
            {sky.planes.enabled && (
              <div className="space-y-0.5 text-text-muted">
                {sky.planes.missing.length > 0 && <div className="text-warning">Needs this camera&apos;s location (set it under Location above).</div>}
                {sky.planes.loading && !sky.planes.fetchedAt && <div>Loading aircraft…</div>}
                {sky.planes.error && <div className="text-warning">{sky.planes.error}</div>}
                {sky.planes.fetchedAt && (
                  <div>
                    {sky.planes.count} shown, above the horizon within about 280 km, updated every 5 s
                  </div>
                )}
                {sky.planes.fetchedAt && (
                  <div className="text-text">
                    <AircraftKindRows filter={sky.planes.kinds} counts={sky.planes.counts} compact />
                  </div>
                )}
                {sky.planes.credit && <div className="text-[10px]">{sky.planes.credit}</div>}
              </div>
            )}
          </Block>

          <Block title="Meteor showers">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={sky.meteors.enabled} onChange={(e) => sky.meteors.setEnabled(e.target.checked)} />
              Show shooting stars
            </label>
            {!sky.meteors.enabled && <div className="text-text-muted">Brief streaks from whichever real meteor shower is active, from the correct radiant, at roughly its real rate.</div>}
            {sky.meteors.enabled && (
              <div className="space-y-0.5 text-text-muted">
                {sky.meteors.missing.length > 0 && <div className="text-warning">Needs this camera&apos;s location (set it under Location above).</div>}
                {sky.meteors.missing.length === 0 && sky.meteors.active.length === 0 && <div>No shower is active right now.</div>}
                {sky.meteors.active.map((a) => (
                  <div key={a.name}>
                    {a.name}: {a.rateNow > 0 ? `~${a.rateNow}/hr from here now` : 'active, but not currently visible from here'}
                  </div>
                ))}
              </div>
            )}
          </Block>

          <Block title="Layers">
            {LAYER_ROWS.map(([k, label]) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" checked={sky.layers[k] as boolean} onChange={(e) => sky.setLayer(k, e.target.checked as never)} />
                {label}
              </label>
            ))}
            <label className="flex items-center justify-between gap-2">
              <span className="text-text-muted">Opacity</span>
              <input type="range" min={0.2} max={1} step={0.05} value={sky.layers.opacity} onChange={(e) => sky.setLayer('opacity', Number(e.target.value))} className="w-32" />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-text-muted">Star density</span>
              <input type="range" min={-2} max={2} step={0.25} value={sky.layers.magOffset} onChange={(e) => sky.setLayer('magOffset', Number(e.target.value))} className="w-32" />
            </label>
          </Block>
        </>
      )}
    </div>
  )
}
