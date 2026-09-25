// One WebSocket carries the frames of every visible camera tile (browsers allow only a handful of
// parallel connections per host, so one MJPEG <img> per tile would starve the rest of the app).
//
// Flow control: the server sends a frame only after the previous one is acknowledged, so a slow
// tile drops frames instead of building a backlog. A frame is acknowledged as soon as it has been
// decoded and handed to its consumer.

import { wsUrl } from '@renderer/lib/api'
import type { CameraStatus, FrameHeader, LiveEvent, StretchSpec } from '@renderer/lib/liveApi'

export interface SubOptions {
  /** width of the delivered image in pixels (null = full sensor size) */
  width: number | null
  fps: number
  stretch?: StretchSpec | null
  hist?: boolean
  focus?: boolean
}

export type FrameHandler = (bitmap: ImageBitmap, header: FrameHeader) => void
type EventHandler = (e: LiveEvent) => void

interface Sub {
  opts: SubOptions
  handlers: Set<FrameHandler>
}

class LiveSocket {
  private ws: WebSocket | null = null
  private subs = new Map<string, Sub>()
  private events = new Set<EventHandler>()
  private connectionHandlers = new Set<(open: boolean) => void>()
  private retry: number | null = null
  private wanted = 0
  statuses: Record<string, CameraStatus> = {}

  /** true only while the current socket is really connected */
  get open(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /** Call when a component starts needing the socket; returns the matching release function. */
  retain(): () => void {
    this.wanted++
    if (!this.ws) this.connect()
    return () => {
      this.wanted--
      if (this.wanted <= 0) this.shutdown()
    }
  }

  private connect(): void {
    if (this.ws) return
    const ws = new WebSocket(wsUrl('/live/ws'))
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    // React's development StrictMode mounts, unmounts and re-mounts, so an older socket can still be
    // closing while a newer one opens. Every handler therefore ignores sockets that are no longer current.
    ws.onopen = (): void => {
      if (this.ws !== ws) return
      this.connectionHandlers.forEach((h) => h(true))
      for (const [cam, sub] of this.subs) this.sendSub(cam, sub.opts)
    }
    ws.onmessage = (m): void => {
      if (this.ws !== ws) return
      if (typeof m.data === 'string') {
        try {
          const ev = JSON.parse(m.data) as LiveEvent
          if (ev.type === 'hello') this.statuses = ev.cameras
          else if (ev.type === 'status') this.statuses = { ...this.statuses, [ev.id]: ev }
          this.events.forEach((h) => h(ev))
        } catch {
          /* malformed event */
        }
        return
      }
      void this.onFrame(m.data as ArrayBuffer)
    }
    ws.onclose = (): void => {
      if (this.ws !== ws) return
      this.ws = null
      this.connectionHandlers.forEach((h) => h(false))
      if (this.wanted > 0) this.retry = window.setTimeout(() => this.connect(), 1500)
    }
    ws.onerror = (): void => ws.close()
  }

  private shutdown(): void {
    if (this.retry !== null) window.clearTimeout(this.retry)
    this.retry = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      ws.close()
    }
  }

  private async onFrame(buf: ArrayBuffer): Promise<void> {
    const view = new DataView(buf)
    const n = view.getUint32(0)
    let header: FrameHeader
    try {
      header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n))) as FrameHeader
    } catch {
      return
    }
    const sub = this.subs.get(header.cam)
    try {
      if (sub && sub.handlers.size) {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(buf, 4 + n)], { type: 'image/jpeg' }))
        // the consumers may have gone while the image was decoding
        const [first, ...rest] = [...sub.handlers]
        if (!first) {
          bitmap.close()
          return
        }
        // each extra consumer needs its own bitmap: the first one may close its copy
        for (const h of rest) h(await createImageBitmap(bitmap), header)
        first(bitmap, header)
      }
    } finally {
      this.send({ op: 'ack', cam: header.cam })
    }
  }

  private send(msg: unknown): void {
    // never throw from here: it is called during React effects, and an exception would unmount the page
    if (!this.open) return
    try {
      this.ws?.send(JSON.stringify(msg))
    } catch {
      /* the socket closed between the check and the send; it reconnects and re-subscribes */
    }
  }

  private sendSub(cam: string, o: SubOptions): void {
    this.send({ op: 'sub', cam, width: o.width, fps: o.fps, stretch: o.stretch ?? null, hist: !!o.hist, focus: !!o.focus })
  }

  subscribe(cam: string, opts: SubOptions, handler: FrameHandler): () => void {
    let sub = this.subs.get(cam)
    if (!sub) {
      sub = { opts, handlers: new Set() }
      this.subs.set(cam, sub)
      this.sendSub(cam, opts)
    } else {
      sub.opts = opts
      this.sendSub(cam, opts)
    }
    sub.handlers.add(handler)
    return () => {
      const s = this.subs.get(cam)
      if (!s) return
      s.handlers.delete(handler)
      if (!s.handlers.size) {
        this.subs.delete(cam)
        this.send({ op: 'unsub', cam })
      }
    }
  }

  /** Change size / rate / stretch of an existing subscription. */
  update(cam: string, opts: SubOptions): void {
    const s = this.subs.get(cam)
    if (!s) return
    s.opts = opts
    this.sendSub(cam, opts)
  }

  onEvent(h: EventHandler): () => void {
    this.events.add(h)
    return () => this.events.delete(h)
  }

  onConnection(h: (open: boolean) => void): () => void {
    this.connectionHandlers.add(h)
    return () => this.connectionHandlers.delete(h)
  }
}

export const liveSocket = new LiveSocket()
