import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, deepspaceSrc } from '@renderer/lib/api'
import { ageColour, compassOf, cssColour, formatKm } from '@renderer/lib/lightning'
import { subsolarPoint, type Place } from '@renderer/lib/skyTonight'
import { useLightningFeed } from '@renderer/components/lightning/useLightningFeed'

const W = 720
const H = 360
const WINDOW_MIN = 15
const xOf = (lon: number): number => ((lon + 180) / 360) * W
const yOf = (lat: number): number => ((90 - lat) / 180) * H

/** The world with the day/night line and every strike of the last 15 minutes, coloured by age (new = white-yellow, old = dark red). */
function StrikeMap({ getStrikes, tick, place }: { getStrikes: () => { tMs: number; lat: number; lon: number }[]; tick: unknown; place: Place | null }): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [world, setWorld] = useState<HTMLImageElement | null>(null)

  useEffect(() => {
    let live = true
    api
      .get<{ urls: Record<string, string> }>('/deepspace/textures')
      .then((t) => {
        if (!t.urls.earth) return
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => live && setWorld(img)
        img.src = deepspaceSrc(t.urls.earth)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx) return
    const now = Date.now()
    ctx.clearRect(0, 0, W, H)
    if (world) ctx.drawImage(world, 0, 0, W, H)
    else {
      ctx.fillStyle = '#0d1420'
      ctx.fillRect(0, 0, W, H)
    }
    // night side
    const sun = subsolarPoint(new Date(now))
    const dec = (sun.latDeg * Math.PI) / 180
    ctx.fillStyle = 'rgba(2, 6, 18, 0.55)'
    for (let x = 0; x < W; x++) {
      const ha = (((x / W) * 360 - 180 - sun.lonDeg) * Math.PI) / 180
      if (Math.abs(dec) < 1e-4) {
        if (Math.cos(ha) < 0) ctx.fillRect(x, 0, 1, H)
        continue
      }
      const edge = yOf((Math.atan(-Math.cos(ha) / Math.tan(dec)) * 180) / Math.PI)
      if (dec > 0) ctx.fillRect(x, edge, 1, H - edge)
      else ctx.fillRect(x, 0, 1, edge)
    }
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fillRect(0, 0, W, H)
    // strikes, oldest first so the new ones sit on top
    const window = WINDOW_MIN * 60_000
    for (const s of getStrikes()) {
      const age = now - s.tMs
      if (age > window || age < 0) continue
      ctx.fillStyle = cssColour(ageColour(age / window))
      ctx.globalAlpha = 1 - 0.5 * (age / window)
      ctx.beginPath()
      ctx.arc(xOf(s.lon), yOf(s.lat), age < 8000 ? 3.2 : 1.9, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
    if (place) {
      ctx.strokeStyle = '#4ade80'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(xOf(place.lonDeg), yOf(place.latDeg), 6, 0, Math.PI * 2)
      ctx.stroke()
      // the 250 km ring around it, to a scale of the map
      const r = (250 / 111.2 / 360) * W
      ctx.strokeStyle = 'rgba(74,222,128,0.5)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(xOf(place.lonDeg), yOf(place.latDeg), Math.max(9, r), 0, Math.PI * 2)
      ctx.stroke()
    }
  }, [getStrikes, tick, place, world])

  return <canvas ref={canvas} width={W} height={H} className="h-auto w-full rounded-md border border-border bg-bg" aria-label="World map with lightning strikes of the last 15 minutes" />
}

/** Live lightning: the worldwide rate, the storm nearest you, and a map of the last 15 minutes. */
export function LightningCard({ place }: { place: Place | null }): ReactElement {
  const navigate = useNavigate()
  const feed = useLightningFeed({ enabled: true, windowMin: WINDOW_MIN, place })
  const st = feed.state.status
  const storm = feed.state.storm
  const disabled = st !== null && !st.enabled

  return (
    <div className="h-full rounded-lg border border-border bg-surface p-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-text-muted">⚡ Lightning</div>
          <div className="text-[11px] text-text-muted">Live, worldwide</div>
        </div>
        <button className="rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:border-accent hover:text-text" onClick={() => navigate('/deep-space?view=solar&focus=earth')}>
          On the globe
        </button>
      </div>

      {disabled ? (
        <div className="text-xs text-warning">Lightning collection is switched off (Settings → Lightning).</div>
      ) : feed.state.error && !st ? (
        <div className="text-xs text-danger">Could not reach the lightning service.</div>
      ) : !st ? (
        <div className="text-xs text-text-muted">Loading…</div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums text-text">{st.per_minute}</span>
            <span className="text-xs text-text-muted">strikes in the last minute · {st.per_minute_5m}/min over 5 min</span>
            <span className={`ml-auto h-2 w-2 rounded-full ${st.connected ? 'bg-success' : 'bg-warning animate-pulse'}`} title={st.connected ? `Connected (${st.server})` : 'Connecting…'} />
          </div>
          {place ? (
            <div className="text-xs">
              {storm?.nearest ? (
                <>
                  <span className="text-text-muted">Nearest to you: </span>
                  <span className={`font-medium tabular-nums ${storm.nearest.km < 50 ? 'text-danger' : storm.nearest.km < 150 ? 'text-warning' : 'text-text'}`}>
                    {formatKm(storm.nearest.km)} {compassOf(storm.nearest.bearing)}
                  </span>
                  <span className="text-text-muted">
                    , {Math.max(0, Math.round((Date.now() - storm.nearest.strike.tMs) / 60_000))} min ago
                    {storm.within100 > 0 ? ` · ${storm.within100} within 100 km in ${WINDOW_MIN} min` : ''}
                  </span>
                </>
              ) : (
                <span className="text-text-muted">No lightning detected in the last {WINDOW_MIN} minutes.</span>
              )}
            </div>
          ) : (
            <div className="text-xs text-warning">Set your location above to see the storm nearest you.</div>
          )}
          <StrikeMap getStrikes={feed.getStrikes} tick={feed.state} place={place} />
          <div className="flex items-center justify-between text-[10px] text-text-muted">
            <span>
              Last {WINDOW_MIN} min: <span style={{ color: cssColour(ageColour(0)) }}>● new</span> → <span style={{ color: cssColour(ageColour(1)) }}>● old</span>. Green ring: 250 km around you.
            </span>
          </div>
          <div className="text-[10px] text-text-muted">{st.credit}. Coverage is thinner over oceans and parts of Africa.</div>
        </div>
      )}
    </div>
  )
}
