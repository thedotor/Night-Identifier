import { useEffect, useRef, useState, type ReactElement } from 'react'
import { api, deepspaceSrc } from '@renderer/lib/api'
import { globalState, type SatRecord } from '@renderer/lib/satellites'
import { subsolarPoint, type Place } from '@renderer/lib/skyTonight'

const W = 720
const H = 360
const DEG = Math.PI / 180

const xOf = (lon: number): number => ((lon + 180) / 360) * W
const yOf = (lat: number): number => ((90 - lat) / 180) * H

/** The world with the day/night line, where a satellite is now, and its path (past dashed, next 90 minutes solid). */
export function GroundTrack({ rec, nowMs, place, color = '#ff5c5c' }: { rec: SatRecord | null; nowMs: number; place: Place | null; color?: string }): ReactElement {
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
      .catch(() => undefined) // no map picture: the graticule stands in
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const c = canvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const now = new Date(nowMs)
    ctx.clearRect(0, 0, W, H)
    if (world) ctx.drawImage(world, 0, 0, W, H)
    else {
      ctx.fillStyle = '#0d1420'
      ctx.fillRect(0, 0, W, H)
    }

    // night side: for each column, the latitude where the Sun is on the horizon
    const sun = subsolarPoint(now)
    ctx.fillStyle = 'rgba(2, 6, 18, 0.58)'
    const dec = sun.latDeg * DEG
    for (let x = 0; x < W; x++) {
      const lon = (x / W) * 360 - 180
      const ha = (lon - sun.lonDeg) * DEG
      if (Math.abs(dec) < 1e-4) {
        if (Math.cos(ha) < 0) ctx.fillRect(x, 0, 1, H)
        continue
      }
      const edge = yOf(Math.atan(-Math.cos(ha) / Math.tan(dec)) / DEG)
      if (dec > 0) ctx.fillRect(x, edge, 1, H - edge)
      else ctx.fillRect(x, 0, 1, edge)
    }

    // graticule
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let lon = -150; lon <= 150; lon += 30) {
      ctx.moveTo(xOf(lon), 0)
      ctx.lineTo(xOf(lon), H)
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      ctx.moveTo(0, yOf(lat))
      ctx.lineTo(W, yOf(lat))
    }
    ctx.stroke()

    // subsolar point
    ctx.fillStyle = '#ffd966'
    ctx.beginPath()
    ctx.arc(xOf(sun.lonDeg), yOf(sun.latDeg), 4, 0, Math.PI * 2)
    ctx.fill()

    if (rec) {
      const path = (fromMin: number, toMin: number): void => {
        ctx.beginPath()
        let prev: number | null = null
        for (let m = fromMin; m <= toMin; m += 1) {
          const g = globalState(rec, new Date(nowMs + m * 60_000))
          if (!g) {
            prev = null
            continue
          }
          const x = xOf(g.lonDeg)
          const y = yOf(g.latDeg)
          if (prev === null || Math.abs(x - prev) > W / 2) ctx.moveTo(x, y) // do not draw across the antimeridian
          else ctx.lineTo(x, y)
          prev = x
        }
        ctx.stroke()
      }
      ctx.lineWidth = 2
      ctx.strokeStyle = color
      ctx.globalAlpha = 0.45
      ctx.setLineDash([4, 4])
      path(-45, 0)
      ctx.globalAlpha = 1
      ctx.setLineDash([])
      path(0, 92)

      const g = globalState(rec, now)
      if (g) {
        const x = xOf(g.lonDeg)
        const y = yOf(g.latDeg)
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(x, y, 9, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(x, y, 4, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    if (place) {
      ctx.fillStyle = '#4ade80'
      ctx.strokeStyle = '#052e16'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(xOf(place.lonDeg), yOf(place.latDeg), 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }, [rec, nowMs, place, world, color])

  return <canvas ref={canvas} width={W} height={H} className="h-auto w-full rounded-md border border-border bg-bg" aria-label="World map with the ISS position and path" />
}
