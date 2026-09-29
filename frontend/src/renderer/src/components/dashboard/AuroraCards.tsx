import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, deepspaceSrc } from '@renderer/lib/api'
import { chanceAt, chanceVerdict, gScale, kpMeaning, kpRows, ovalReach, windMeaning, type AuroraGrid, type SpaceWeather, type Tone } from '@renderer/lib/aurora'
import { subsolarPoint, sunAltitudeDeg, type Place } from '@renderer/lib/skyTonight'
import { useAuroraGrid, useSpaceWeather } from '@renderer/components/aurora/useAurora'

const card = 'h-full rounded-lg border border-border bg-surface p-4'
const TONE_TEXT: Record<Tone, string> = { quiet: 'text-text-muted', good: 'text-success', great: 'text-warning', warn: 'text-danger' }
const DEG = Math.PI / 180

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// ---------- the world, as pixels (for the maps' background) ----------

let worldPixels: { data: Uint8ClampedArray; w: number; h: number } | null = null
let worldLoading: Promise<void> | null = null

/** The Earth picture (already cached by the backend for Deep Space), as a small block of pixels the polar maps can sample. */
function useWorldPixels(): typeof worldPixels {
  const [ready, setReady] = useState(worldPixels)
  useEffect(() => {
    if (worldPixels) return
    let live = true
    worldLoading ??= api
      .get<{ urls: Record<string, string> }>('/deepspace/textures')
      .then(
        (t) =>
          new Promise<void>((resolve) => {
            if (!t.urls.earth) return resolve()
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload = () => {
              const c = document.createElement('canvas')
              c.width = 720
              c.height = 360
              const ctx = c.getContext('2d')!
              ctx.drawImage(img, 0, 0, 720, 360)
              worldPixels = { data: ctx.getImageData(0, 0, 720, 360).data, w: 720, h: 360 }
              resolve()
            }
            img.onerror = () => resolve()
            img.src = deepspaceSrc(t.urls.earth)
          })
      )
      .catch(() => undefined)
    void worldLoading.then(() => live && setReady(worldPixels))
    return () => {
      live = false
    }
  }, [])
  return ready
}

// ---------- a map of one pole ----------

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Looking straight down on a pole out to 40 degrees of latitude, Greenwich at the bottom: the aurora over the land,
 * the night side darkened (aurora is faint in daylight), and you marked when you are in this hemisphere.
 */
function PolarMap({ grid, hemisphere, place, nowMs, size = 250 }: { grid: AuroraGrid; hemisphere: 'north' | 'south'; place: Place | null; nowMs: number; size?: number }): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null)
  const world = useWorldPixels()
  const sign = hemisphere === 'north' ? 1 : -1
  const minute = Math.floor(nowMs / 60_000)

  useEffect(() => {
    const cv = canvas.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return
    const S = size
    const R = S / 2 - 12
    const c = S / 2
    const sun = subsolarPoint(new Date(minute * 60_000))
    const sinDec = Math.sin(sun.latDeg * DEG)
    const cosDec = Math.cos(sun.latDeg * DEG)
    const img = ctx.createImageData(S, S)
    const d = img.data
    for (let py = 0; py < S; py++) {
      for (let px = 0; px < S; px++) {
        const dx = (px + 0.5 - c) / R
        const dy = (py + 0.5 - c) / R
        const rr = Math.hypot(dx, dy)
        const j = (py * S + px) * 4
        if (rr > 1) continue
        const lat = sign * (90 - rr * 50)
        const lon = (Math.atan2(sign * dx, dy) / DEG + 360) % 360 // 0 at the bottom, growing counterclockwise seen from above the north pole
        // land and sea
        let r = 12
        let g = 22
        let b = 38
        if (world) {
          const wx = Math.min(world.w - 1, Math.floor((((lon + 180) % 360) / 360) * world.w))
          const wy = Math.min(world.h - 1, Math.floor(((90 - lat) / 180) * world.h))
          const k = (wy * world.w + wx) * 4
          r = world.data[k]
          g = world.data[k + 1]
          b = world.data[k + 2]
        }
        // day and night
        const sinElev = Math.sin(lat * DEG) * sinDec + Math.cos(lat * DEG) * cosDec * Math.cos(((lon > 180 ? lon - 360 : lon) - sun.lonDeg) * DEG)
        const day = smooth(-0.12, 0.2, sinElev)
        const shade = 0.16 + 0.62 * day
        r *= shade
        g *= shade
        b *= shade
        // aurora
        const chance = chanceAt(grid, lat, lon)
        const t = Math.min(1, chance / 45)
        const a = smooth(0.03, 0.55, t) * (1 - 0.82 * day)
        const pink = smooth(0.7, 1, t) * 0.6
        const ar = 30 + 215 * pink
        const ag = 255 - 95 * pink
        const ab = 110 + 100 * pink
        d[j] = r * (1 - a) + ar * a
        d[j + 1] = g * (1 - a) + ag * a
        d[j + 2] = b * (1 - a) + ab * a
        d[j + 3] = 255
      }
    }
    ctx.clearRect(0, 0, S, S)
    ctx.putImageData(img, 0, 0)
    // latitude rings and their labels
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.lineWidth = 1
    ctx.font = '9px system-ui, sans-serif'
    for (const lat of [50, 60, 70, 80]) {
      const r = ((90 - lat) / 50) * R
      ctx.beginPath()
      ctx.arc(c, c, r, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillText(`${lat}°`, c + 3, c + r - 2)
    }
    ctx.beginPath()
    ctx.arc(c, c, R, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.stroke()
    // where the Sun is over this pole (a small yellow dot at the edge, on the day side)
    // you
    if (place && (place.latDeg >= 0) === (sign === 1) && Math.abs(place.latDeg) >= 40) {
      const r = ((90 - Math.abs(place.latDeg)) / 50) * R
      const lon = ((place.lonDeg % 360) + 360) % 360
      const th = lon * DEG
      const x = c + sign * r * Math.sin(th)
      const y = c + r * Math.cos(th)
      ctx.strokeStyle = '#4ade80'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(x, y, 6, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillStyle = '#4ade80'
      ctx.beginPath()
      ctx.arc(x, y, 2, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.font = 'bold 10px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('0°', c, S - 1) // Greenwich, at the bottom
    ctx.fillText(sign === 1 ? '90°E' : '90°W', sign === 1 ? S - 12 : 12, c + 3)
    ctx.fillText('180°', c, 10)
  }, [grid, sign, place, size, world, minute])

  return <canvas ref={canvas} width={size} height={size} className="h-auto w-full max-w-[280px] rounded-md border border-border bg-bg" aria-label={`Aurora over the ${hemisphere} pole`} />
}

// ---------- the aurora card ----------

export function AuroraCard({ place }: { place: Place | null }): ReactElement {
  const navigate = useNavigate()
  const { grid, error } = useAuroraGrid(true)
  const wx = useSpaceWeather(true)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])

  const here = useMemo(() => {
    if (!grid || !place) return null
    const chance = chanceAt(grid, place.latDeg, place.lonDeg)
    return { chance, verdict: chanceVerdict(chance, sunAltitudeDeg(place, new Date(now)), place.latDeg) }
  }, [grid, place, now])
  const north = grid ? ovalReach(grid, 'north') : null
  const south = grid ? ovalReach(grid, 'south') : null
  const kp = wx.data?.kp_now
  const power = wx.data?.hemispheric_power

  return (
    <div className={card}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-text-muted">🌌 Aurora</div>
          <div className="text-[11px] text-text-muted">Live forecast, both poles</div>
        </div>
        <button className="rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:border-accent hover:text-text" onClick={() => navigate('/deep-space?view=solar&focus=earth')}>
          On the globe
        </button>
      </div>

      {error && !grid ? (
        <div className="text-xs text-danger">Could not get the aurora forecast: {error}</div>
      ) : !grid ? (
        <div className="text-xs text-text-muted">Loading…</div>
      ) : (
        <div className="space-y-3">
          {place ? (
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-semibold tabular-nums text-text">{Math.round(here?.chance ?? 0)}%</span>
              <span className={`text-xs ${TONE_TEXT[here?.verdict.tone ?? 'quiet']}`}>{here?.verdict.text}</span>
            </div>
          ) : (
            <div className="text-xs text-warning">Set your location above to see your own chance.</div>
          )}

          <div className="flex flex-wrap justify-center gap-4">
            <div className="text-center">
              <PolarMap grid={grid} hemisphere="north" place={place} nowMs={now} />
              <div className="mt-1 text-[11px] text-text-muted">Aurora borealis (north){north !== null ? ` · reaches ${north}°N` : ' · quiet'}</div>
            </div>
            <div className="text-center">
              <PolarMap grid={grid} hemisphere="south" place={place} nowMs={now} />
              <div className="mt-1 text-[11px] text-text-muted">Aurora australis (south){south !== null ? ` · reaches ${south}°S` : ' · quiet'}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
            {kp != null && (
              <span>
                Kp <span className="tabular-nums text-text">{kp.toFixed(1)}</span>
                {gScale(kp) ? ` (${gScale(kp)})` : ''}
              </span>
            )}
            {power && (
              <span>
                Power: <span className="tabular-nums text-text">{power.north_gw.toFixed(0)}</span> GW north, <span className="tabular-nums text-text">{power.south_gw.toFixed(0)}</span> GW south
              </span>
            )}
            <span>Peak chance {grid.max}%</span>
            {grid.validMs && <span>Valid {clock(grid.validMs)}</span>}
          </div>
          <div className="text-[10px] leading-snug text-text-muted">
            Green ring: you. Dark = night, where aurora can be seen; daylight is shaded. This is NOAA&apos;s model of where aurora is likely, not a camera view: cloud, moonlight and light pollution decide what you would see. {grid.credit}.
            {grid.stale ? ' (Offline: showing the last forecast.)' : ''}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- space weather ----------

const kpColour = (kp: number): string => (kp >= 7 ? '#ef4444' : kp >= 5 ? '#f97316' : kp >= 4 ? '#eab308' : kp >= 3 ? '#a3e635' : '#4ade80')

function KpChart({ w }: { w: SpaceWeather }): ReactElement {
  const rows = kpRows(w)
  const now = Date.now()
  const shown = rows.filter((r) => {
    const t = Date.parse(`${r.time}Z`)
    return t >= now - 30 * 3_600_000 && t <= now + 75 * 3_600_000
  })
  const W = 320
  const H = 74
  const bw = shown.length ? W / shown.length : W
  const nowIdx = shown.findIndex((r) => Date.parse(`${r.time}Z`) > now) // the first block that has not started
  return (
    <svg viewBox={`0 0 ${W} ${H + 14}`} className="w-full" role="img" aria-label="Kp index over the last day and the next three days">
      {[3, 5, 7].map((k) => (
        <g key={k}>
          <line x1={0} x2={W} y1={H - (k / 9) * H} y2={H - (k / 9) * H} stroke="currentColor" strokeOpacity={0.12} strokeDasharray="3 3" />
          <text x={2} y={H - (k / 9) * H - 2} fontSize={7} fill="currentColor" fillOpacity={0.5}>
            Kp {k}
          </text>
        </g>
      ))}
      {shown.map((r, i) => {
        const h = Math.max(1.5, (r.kp / 9) * H)
        const predicted = r.kind === 'predicted'
        return <rect key={r.time} x={i * bw + 1} y={H - h} width={bw - 2} height={h} fill={kpColour(r.kp)} fillOpacity={predicted ? 0.4 : 0.9} stroke={predicted ? kpColour(r.kp) : 'none'} strokeDasharray={predicted ? '2 2' : undefined} />
      })}
      {nowIdx > 0 && <line x1={nowIdx * bw} x2={nowIdx * bw} y1={0} y2={H} stroke="currentColor" strokeOpacity={0.7} />}
      <text x={2} y={H + 11} fontSize={8} fill="currentColor" fillOpacity={0.6}>
        last day
      </text>
      <text x={nowIdx > 0 ? nowIdx * bw + 3 : 60} y={H + 11} fontSize={8} fill="currentColor" fillOpacity={0.6}>
        now → forecast (dashed)
      </text>
    </svg>
  )
}

function WindChart({ w }: { w: SpaceWeather }): ReactElement | null {
  const pts = w.solar_wind ?? []
  if (pts.length < 3) return null
  const W = 320
  const H = 84
  const t0 = Date.parse(`${pts[0].t}Z`)
  const t1 = Date.parse(`${pts[pts.length - 1].t}Z`)
  const x = (t: string): number => ((Date.parse(`${t}Z`) - t0) / Math.max(1, t1 - t0)) * W
  const speedY = (v: number): number => H - ((Math.min(900, Math.max(250, v)) - 250) / 650) * H
  const bzY = (v: number): number => H / 2 - (Math.min(20, Math.max(-20, v)) / 20) * (H / 2)
  const line = (get: (p: (typeof pts)[number]) => number | null | undefined, y: (v: number) => number): string =>
    pts.flatMap((p) => (get(p) == null ? [] : [`${x(p.t).toFixed(1)},${y(get(p) as number).toFixed(1)}`])).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H + 14}`} className="w-full" role="img" aria-label="Solar wind speed and Bz over the last 3 hours">
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="3 3" />
      <rect x={0} y={H / 2} width={W} height={H / 2} fill="#f97316" fillOpacity={0.05} />
      <polyline points={line((p) => p.speed, speedY)} fill="none" stroke="#38bdf8" strokeWidth={1.5} />
      <polyline points={line((p) => p.bz, bzY)} fill="none" stroke="#fb923c" strokeWidth={1.5} />
      <text x={2} y={9} fontSize={8} fill="#38bdf8">
        speed (250-900 km/s)
      </text>
      <text x={W - 2} y={H - 3} fontSize={8} fill="#fb923c" textAnchor="end">
        Bz (below the dashed line = southward)
      </text>
      <text x={2} y={H + 11} fontSize={8} fill="currentColor" fillOpacity={0.6}>
        3 hours ago
      </text>
      <text x={W - 2} y={H + 11} fontSize={8} fill="currentColor" fillOpacity={0.6} textAnchor="end">
        now
      </text>
    </svg>
  )
}

const Stat = ({ label, value, unit, tone }: { label: string; value: string; unit: string; tone?: Tone }): ReactElement => (
  <div className="rounded-md border border-border px-2.5 py-1.5">
    <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
    <div className={`text-lg font-semibold tabular-nums ${tone ? TONE_TEXT[tone] : 'text-text'}`}>
      {value} <span className="text-[11px] font-normal text-text-muted">{unit}</span>
    </div>
  </div>
)

export function SpaceWeatherCard(): ReactElement {
  const { data, error } = useSpaceWeather(true)
  const kp = data?.kp_now ?? null
  const wind = data?.solar_wind_now
  const kpInfo = kp !== null ? kpMeaning(kp) : null
  const windInfo = windMeaning(wind?.bz, wind?.speed)

  return (
    <div className={card}>
      <div className="mb-2">
        <div className="text-xs uppercase tracking-wide text-text-muted">☀ Space weather</div>
        <div className="text-[11px] text-text-muted">What drives the aurora</div>
      </div>
      {error && !data ? (
        <div className="text-xs text-danger">Could not get space weather: {error}</div>
      ) : !data ? (
        <div className="text-xs text-text-muted">Loading…</div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-semibold tabular-nums text-text">{kp !== null ? kp.toFixed(1) : '-'}</span>
            <div className="min-w-0">
              <div className="text-xs text-text-muted">
                Kp index now{kp !== null && gScale(kp) ? <span className="ml-1 rounded border border-warning/60 px-1 text-warning">{gScale(kp)} storm</span> : ''}
              </div>
              {kpInfo && <div className={`text-xs ${TONE_TEXT[kpInfo.tone]}`}>{kpInfo.text}</div>}
            </div>
          </div>
          <KpChart w={data} />

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Wind speed" value={wind?.speed !== undefined ? Math.round(wind.speed).toString() : '-'} unit="km/s" tone={wind?.speed !== undefined && wind.speed >= 600 ? 'great' : undefined} />
            <Stat label="Density" value={wind?.density !== undefined ? wind.density.toFixed(1) : '-'} unit="p/cm³" />
            <Stat label="Field strength" value={wind?.bt !== undefined ? wind.bt.toFixed(1) : '-'} unit="nT" />
            <Stat label="Bz (north-south)" value={wind?.bz !== undefined ? wind.bz.toFixed(1) : '-'} unit="nT" tone={wind?.bz !== undefined && wind.bz <= -5 ? 'great' : undefined} />
          </div>
          <div className={`text-xs ${TONE_TEXT[windInfo.tone]}`}>{windInfo.text}</div>
          <WindChart w={data} />
          <div className="text-[10px] leading-snug text-text-muted">
            Measured about 1.5 million km sunward of Earth, so a change arrives here roughly 30 to 60 minutes later. {data.credit}.
            {data.stale ? ' (Offline: showing the last reading.)' : ''}
            {data.errors.length > 0 ? ` ${data.errors.join('; ')}.` : ''}
          </div>
        </div>
      )}
    </div>
  )
}
