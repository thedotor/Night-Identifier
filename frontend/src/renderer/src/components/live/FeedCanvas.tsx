import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactElement } from 'react'
import { liveSocket, type SubOptions } from '@renderer/lib/liveSocket'
import type { FrameHeader } from '@renderer/lib/liveApi'

export interface Overlays {
  crosshair: boolean
  thirds: boolean
  circle: boolean
  grid: boolean
  frame: boolean
  framePct: number
}

export const NO_OVERLAYS: Overlays = { crosshair: false, thirds: false, circle: false, grid: false, frame: false, framePct: 60 }

interface Pt {
  x: number
  y: number
}

/** The star overlay, painted over the picture (see useLiveSky). */
export interface SkyLayer {
  /** changes whenever what is drawn changed for a reason other than time (alignment edit, layers, ...) */
  key: string
  /** paint the overlay; ctx is in source-image pixels, `k` is CSS pixels per source pixel */
  paint: (ctx: CanvasRenderingContext2D, m: { k: number; width: number; height: number }) => void
  /** keep repainting a few times a second, so the overlay follows the turning sky */
  animate: boolean
}

/** Mouse editing of the overlay's alignment; every position is in source-image pixels. */
export interface SkyEdit {
  /** move: drag slides the sky, wheel scales it, shift-drag rotates. pick: a click picks a star. */
  mode: 'move' | 'pick'
  pan: (from: Pt, to: Pt) => void
  /** rotate about the picture centre, in degrees (positive = counter-clockwise on screen) */
  roll: (deltaDeg: number) => void
  scale: (factor: number, at: Pt) => void
  /** `screen` is relative to the picture area's top-left corner, in CSS pixels */
  pick: (at: Pt, screen: Pt) => void
}

export interface FeedHandle {
  getBitmap: () => ImageBitmap | null
  resetView: () => void
}

interface Props {
  camId: string
  sub: SubOptions
  /** show the picture in red only, to keep night vision */
  red?: boolean
  overlays?: Overlays
  /** allow wheel-zoom and drag-pan (single view) */
  interactive?: boolean
  onHeader?: (h: FrameHeader) => void
  /** when a marker is set, called with the clicked position in source-image fractions */
  onPick?: (fx: number, fy: number) => void
  marker?: { fx: number; fy: number } | null
  sky?: SkyLayer | null
  skyEdit?: SkyEdit | null
  /** text shown until the first frame arrives (null: the parent shows its own status) */
  waitingText?: string | null
  className?: string
}

interface View {
  scale: number
  cx: number // centre of the view, in image fractions
  cy: number
}

function themeAccent(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
  return v ? `rgb(${v.split(/\s+/).join(',')})` : '#63b3ed'
}

export const FeedCanvas = forwardRef<FeedHandle, Props>(function FeedCanvas(props, ref): ReactElement {
  const { camId, sub, red, overlays, interactive, onHeader, onPick, marker, sky, skyEdit, className, waitingText = 'Waiting for the first frame…' } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const last = useRef<{ bitmap: ImageBitmap; header: FrameHeader } | null>(null)
  const view = useRef<View>({ scale: 1, cx: 0.5, cy: 0.5 })
  const propsRef = useRef({ red, overlays, marker, sky })
  propsRef.current = { red, overlays, marker, sky }
  const editRef = useRef(skyEdit)
  editRef.current = skyEdit
  const skyCache = useRef<{ canvas: HTMLCanvasElement; key: string; at: number } | null>(null)
  const headerCb = useRef(onHeader)
  headerCb.current = onHeader
  const [waiting, setWaiting] = useState(true)
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean; kind: 'view' | 'overlay' | 'roll'; last: Pt | null } | null>(null)
  const spaceDown = useRef(false)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const dpr = window.devicePixelRatio || 1
    const cw = Math.max(1, Math.round(wrap.clientWidth * dpr))
    const ch = Math.max(1, Math.round(wrap.clientHeight * dpr))
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw
      canvas.height = ch
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, cw, ch)
    const cur = last.current
    if (!cur) return
    const { bitmap } = cur
    const v = view.current
    const fit = Math.min(cw / bitmap.width, ch / bitmap.height)
    const s = fit * v.scale
    const dw = bitmap.width * s
    const dh = bitmap.height * s
    const dx = cw / 2 - v.cx * dw
    const dy = ch / 2 - v.cy * dh
    ctx.imageSmoothingEnabled = s < 3
    ctx.imageSmoothingQuality = 'high'
    const { red: isRed, overlays: ov, marker: mk } = propsRef.current
    if (isRed) ctx.filter = 'grayscale(1)'
    ctx.drawImage(bitmap, dx, dy, dw, dh)
    ctx.filter = 'none'
    if (isRed) {
      ctx.globalCompositeOperation = 'multiply'
      ctx.fillStyle = 'rgb(255,0,0)'
      ctx.fillRect(Math.max(0, dx), Math.max(0, dy), Math.min(dw, cw), Math.min(dh, ch))
      ctx.globalCompositeOperation = 'source-over'
    }

    if (ov) {
      // guides are drawn on the picture area as it is currently framed
      const x0 = Math.max(0, dx)
      const y0 = Math.max(0, dy)
      const x1 = Math.min(cw, dx + dw)
      const y1 = Math.min(ch, dy + dh)
      const w = x1 - x0
      const h = y1 - y0
      const midx = (x0 + x1) / 2
      const midy = (y0 + y1) / 2
      ctx.strokeStyle = themeAccent()
      ctx.lineWidth = Math.max(1, dpr)
      ctx.globalAlpha = 0.75
      ctx.beginPath()
      if (ov.crosshair) {
        ctx.moveTo(midx, y0)
        ctx.lineTo(midx, y1)
        ctx.moveTo(x0, midy)
        ctx.lineTo(x1, midy)
      }
      if (ov.thirds) {
        for (const f of [1 / 3, 2 / 3]) {
          ctx.moveTo(x0 + w * f, y0)
          ctx.lineTo(x0 + w * f, y1)
          ctx.moveTo(x0, y0 + h * f)
          ctx.lineTo(x1, y0 + h * f)
        }
      }
      if (ov.grid) {
        for (let i = 1; i < 10; i++) {
          ctx.moveTo(x0 + (w * i) / 10, y0)
          ctx.lineTo(x0 + (w * i) / 10, y1)
          ctx.moveTo(x0, y0 + (h * i) / 10)
          ctx.lineTo(x1, y0 + (h * i) / 10)
        }
        ctx.globalAlpha = 0.35
      }
      ctx.stroke()
      ctx.globalAlpha = 0.75
      if (ov.circle) {
        ctx.beginPath()
        ctx.arc(midx, midy, Math.min(w, h) * 0.45, 0, Math.PI * 2)
        ctx.stroke()
      }
      if (ov.frame) {
        const f = Math.max(0.05, Math.min(1, ov.framePct / 100))
        ctx.setLineDash([8 * dpr, 6 * dpr])
        ctx.strokeRect(midx - (w * f) / 2, midy - (h * f) / 2, w * f, h * f)
        ctx.setLineDash([])
      }
      ctx.globalAlpha = 1
    }
    const layer = propsRef.current.sky
    if (layer) {
      const sw = cur.header.sw || bitmap.width
      const sh = cur.header.sh || bitmap.height
      const k = dw / sw // device pixels per source pixel
      // Painting the sky is far heavier than blitting it, and frames arrive ~15 times a second, so the
      // overlay is kept on its own canvas and only repainted when something changed or 200 ms passed
      // (the sky turns 15 arcseconds a second, well under a pixel in that time).
      const key = `${layer.key}|${cw}|${ch}|${dx.toFixed(1)}|${dy.toFixed(1)}|${dw.toFixed(1)}|${sw}x${sh}`
      const now = performance.now()
      let cache = skyCache.current
      if (!cache) cache = skyCache.current = { canvas: document.createElement('canvas'), key: '', at: 0 }
      if (cache.key !== key || (layer.animate && now - cache.at >= 180)) {
        const c = cache.canvas
        if (c.width !== cw || c.height !== ch) {
          c.width = cw
          c.height = ch
        }
        const octx = c.getContext('2d')
        if (octx) {
          octx.setTransform(1, 0, 0, 1, 0, 0)
          octx.clearRect(0, 0, cw, ch)
          octx.save()
          octx.beginPath()
          octx.rect(Math.max(0, dx), Math.max(0, dy), Math.min(dw, cw), Math.min(dh, ch))
          octx.clip()
          octx.setTransform(k, 0, 0, k, dx, dy)
          layer.paint(octx, { k: k / dpr, width: sw, height: sh })
          octx.restore()
        }
        cache.key = key
        cache.at = now
      }
      ctx.drawImage(cache.canvas, 0, 0)
      if (isRed) {
        // keep the overlay red too, so it never breaks night vision
        ctx.globalCompositeOperation = 'multiply'
        ctx.fillStyle = 'rgb(255,0,0)'
        ctx.fillRect(Math.max(0, dx), Math.max(0, dy), Math.min(dw, cw), Math.min(dh, ch))
        ctx.globalCompositeOperation = 'source-over'
      }
    }
    if (mk) {
      const mx = dx + mk.fx * dw
      const my = dy + mk.fy * dh
      ctx.strokeStyle = themeAccent()
      ctx.lineWidth = Math.max(1, dpr)
      ctx.strokeRect(mx - 24 * dpr, my - 24 * dpr, 48 * dpr, 48 * dpr)
    }
  }, [])

  useImperativeHandle(ref, () => ({
    getBitmap: () => last.current?.bitmap ?? null,
    resetView: () => {
      view.current = { scale: 1, cx: 0.5, cy: 0.5 }
      draw()
    }
  }))

  useEffect(() => {
    const release = liveSocket.retain()
    const unsub = liveSocket.subscribe(camId, sub, (bitmap, header) => {
      const prev = last.current
      last.current = { bitmap, header }
      prev?.bitmap.close()
      setWaiting(false)
      draw()
      headerCb.current?.(header)
    })
    return () => {
      unsub()
      release()
      last.current?.bitmap.close()
      last.current = null
    }
    // the subscription is renewed only when the camera changes; option changes go through update()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camId])

  useEffect(() => {
    liveSocket.update(camId, sub)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub.width, sub.fps, sub.hist, sub.focus, JSON.stringify(sub.stretch)])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => draw())
    ro.observe(el)
    return () => ro.disconnect()
  }, [draw])

  useEffect(() => draw(), [draw, red, overlays, marker, sky?.key])

  // Follow the turning sky even when the camera is slow to deliver frames.
  const animate = !!sky?.animate
  useEffect(() => {
    if (!animate) return
    const t = setInterval(draw, 200)
    return () => clearInterval(t)
  }, [animate, draw])

  useEffect(() => {
    const isField = (t: EventTarget | null): boolean => t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement
    const down = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && !isField(e.target)) spaceDown.current = true
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') spaceDown.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  /** Where a screen point falls on the picture, in image fractions (not limited to the picture itself). */
  const fractionAt = (clientX: number, clientY: number): { fx: number; fy: number } | null => {
    const wrap = wrapRef.current
    const cur = last.current
    if (!wrap || !cur) return null
    const rect = wrap.getBoundingClientRect()
    const cw = rect.width
    const ch = rect.height
    const fit = Math.min(cw / cur.bitmap.width, ch / cur.bitmap.height)
    const v = view.current
    const dw = cur.bitmap.width * fit * v.scale
    const dh = cur.bitmap.height * fit * v.scale
    const dx = cw / 2 - v.cx * dw
    const dy = ch / 2 - v.cy * dh
    return { fx: (clientX - rect.left - dx) / dw, fy: (clientY - rect.top - dy) / dh }
  }

  const toFraction = (clientX: number, clientY: number): { fx: number; fy: number } | null => {
    const f = fractionAt(clientX, clientY)
    return !f || f.fx < 0 || f.fx > 1 || f.fy < 0 || f.fy > 1 ? null : f
  }

  /** Where a screen point falls on the picture, in the camera's own (source) pixels. */
  const toSource = (clientX: number, clientY: number): Pt | null => {
    const f = fractionAt(clientX, clientY)
    const h = last.current?.header
    return f && h ? { x: f.fx * (h.sw || h.w), y: f.fy * (h.sh || h.h) } : null
  }

  const sizeOfSource = (): Pt => {
    const h = last.current?.header
    return { x: h?.sw || h?.w || 1, y: h?.sh || h?.h || 1 }
  }

  return (
    <div
      ref={wrapRef}
      className={`relative overflow-hidden bg-black ${className ?? ''}`}
      style={skyEdit ? { cursor: skyEdit.mode === 'pick' ? 'crosshair' : 'grab' } : undefined}
      onWheel={
        interactive
          ? (e): void => {
              const edit = editRef.current
              if (edit?.mode === 'move' && !e.ctrlKey && !e.metaKey) {
                // Scale the sky about the cursor; Ctrl+wheel still zooms the picture.
                const at = toSource(e.clientX, e.clientY)
                if (at) edit.scale(Math.exp(e.deltaY * 0.0012), at)
                return
              }
              const before = toFraction(e.clientX, e.clientY)
              const v = view.current
              const next = Math.max(1, Math.min(40, v.scale * (e.deltaY < 0 ? 1.25 : 0.8)))
              if (next === v.scale) return
              v.scale = next
              if (next === 1) {
                v.cx = 0.5
                v.cy = 0.5
              } else if (before) {
                // keep the point under the cursor fixed
                const after = toFraction(e.clientX, e.clientY)
                if (after) {
                  v.cx += before.fx - after.fx
                  v.cy += before.fy - after.fy
                }
              }
              draw()
            }
          : undefined
      }
      onPointerDown={
        interactive
          ? (e): void => {
              ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
              const edit = editRef.current
              // Dragging edits the sky in Move mode (unless Space or the middle button asks for the picture).
              const grabPicture = e.button === 1 || spaceDown.current
              const kind = edit?.mode === 'move' && !grabPicture && e.button === 0 ? (e.shiftKey ? 'roll' : 'overlay') : 'view'
              drag.current = { x: e.clientX, y: e.clientY, cx: view.current.cx, cy: view.current.cy, moved: false, kind, last: toSource(e.clientX, e.clientY) }
            }
          : undefined
      }
      onPointerMove={
        interactive
          ? (e): void => {
              const d = drag.current
              const cur = last.current
              const wrap = wrapRef.current
              if (!d || !cur || !wrap) return
              if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true
              if (!d.moved) return
              const edit = editRef.current
              if (d.kind !== 'view' && edit) {
                const p = toSource(e.clientX, e.clientY)
                if (p && d.last) {
                  if (d.kind === 'overlay') edit.pan(d.last, p)
                  else {
                    // rotate about the middle of the frame, the overlay following the pointer
                    const c = { x: sizeOfSource().x / 2, y: sizeOfSource().y / 2 }
                    let da = Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(d.last.y - c.y, d.last.x - c.x)
                    da = Math.atan2(Math.sin(da), Math.cos(da))
                    edit.roll((-da * 180) / Math.PI)
                  }
                }
                d.last = p ?? d.last
                return
              }
              if (view.current.scale === 1) return
              const fit = Math.min(wrap.clientWidth / cur.bitmap.width, wrap.clientHeight / cur.bitmap.height)
              const dw = cur.bitmap.width * fit * view.current.scale
              const dh = cur.bitmap.height * fit * view.current.scale
              view.current.cx = d.cx - (e.clientX - d.x) / dw
              view.current.cy = d.cy - (e.clientY - d.y) / dh
              draw()
            }
          : undefined
      }
      onPointerUp={
        interactive
          ? (e): void => {
              const d = drag.current
              drag.current = null
              if (!d || d.moved) return
              const edit = editRef.current
              if (edit?.mode === 'pick' && e.button === 0 && !spaceDown.current) {
                const at = toSource(e.clientX, e.clientY)
                const rect = wrapRef.current?.getBoundingClientRect()
                if (at && rect) edit.pick(at, { x: e.clientX - rect.left, y: e.clientY - rect.top })
                return
              }
              if (onPick) {
                const f = toFraction(e.clientX, e.clientY)
                if (f) onPick(f.fx, f.fy)
              }
            }
          : undefined
      }
      onDoubleClick={interactive ? (): void => { view.current = { scale: 1, cx: 0.5, cy: 0.5 }; draw() } : undefined}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {waiting && waitingText && <div className="absolute inset-0 flex items-center justify-center text-xs text-text-muted">{waitingText}</div>}
    </div>
  )
})
