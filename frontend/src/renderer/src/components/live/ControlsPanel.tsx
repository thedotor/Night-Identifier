import { useEffect, useRef, useState, type ReactElement } from 'react'
import { errorText, live, type LiveControl } from '@renderer/lib/liveApi'
import { btn, input } from './ui'

const GROUP_TITLES: Record<string, string> = {
  camera: 'Camera',
  exposure: 'Exposure',
  focus: 'Focus',
  image: 'Image',
  status: 'Camera status',
  cooling: 'Cooling',
  simulation: 'Simulator',
  photo: 'Photo'
}

function fmt(v: number, step: number | null): string {
  const decimals = step && step < 1 ? Math.min(3, Math.ceil(-Math.log10(step))) : 0
  return v.toFixed(decimals)
}

function RangeRow({ ctl, onCommit }: { ctl: LiveControl; onCommit: (v: number) => void }): ReactElement {
  const [local, setLocal] = useState<number | null>(null)
  const timer = useRef<number | null>(null)
  const min = ctl.min ?? 0
  const max = ctl.max ?? 100
  const value = local ?? Number(ctl.value ?? min)
  const log = ctl.log && min > 0
  const toPos = (v: number): number => (log ? (Math.log(v / min) / Math.log(max / min)) * 1000 : ((v - min) / (max - min)) * 1000)
  const fromPos = (p: number): number => {
    const v = log ? min * Math.pow(max / min, p / 1000) : min + (p / 1000) * (max - min)
    const step = ctl.step ?? 1
    return Math.min(max, Math.max(min, Math.round(v / step) * step))
  }

  const commit = (v: number): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    onCommit(v)
  }

  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-text-muted">{ctl.label}</span>
        <span className="tabular-nums text-text">
          {fmt(value, ctl.step)} {ctl.unit}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={1000}
        value={Math.round(toPos(value))}
        className="w-full accent-[rgb(var(--color-accent))]"
        onChange={(e) => {
          const v = fromPos(Number(e.target.value))
          setLocal(v)
          if (timer.current !== null) window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => commit(v), 150)
        }}
        onPointerUp={() => {
          if (local !== null) commit(local)
          setLocal(null)
        }}
        onKeyUp={() => {
          if (local !== null) commit(local)
          setLocal(null)
        }}
      />
    </div>
  )
}

/** A spring-loaded slider: while it is held away from the middle the steps repeat (further = bigger and faster steps); letting go returns it to the middle and stops. */
function JogRow({ ctl, onStep }: { ctl: LiveControl; onStep: (v: number) => Promise<boolean> }): ReactElement {
  const [pos, setPos] = useState(0)
  const posRef = useRef(0)
  const timer = useRef<number | null>(null)
  const max = ctl.max ?? 3

  const stop = (): void => {
    if (timer.current !== null) window.clearInterval(timer.current)
    timer.current = null
    posRef.current = 0
    setPos(0)
  }
  useEffect(() => stop, [])

  const move = (v: number): void => {
    posRef.current = v
    setPos(v)
    if (v === 0) return stop()
    if (timer.current === null) {
      const tick = (): void => {
        if (posRef.current === 0) return stop()
        void onStep(posRef.current).then((ok) => ok || stop()) // an error (say, the lens is on MF) stops the repeat
      }
      tick()
      timer.current = window.setInterval(tick, 250)
    }
  }

  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-text-muted">{ctl.label}</span>
        <span className="tabular-nums text-text">{pos === 0 ? 'stopped' : `${pos < 0 ? 'nearer' : 'farther'} ${Math.abs(pos)}`}</span>
      </div>
      <input
        type="range"
        min={-max}
        max={max}
        step={1}
        value={pos}
        className="w-full accent-[rgb(var(--color-accent))]"
        onChange={(e) => move(Number(e.target.value))}
        onPointerUp={stop}
        onPointerCancel={stop}
        onBlur={stop}
        onKeyUp={stop}
      />
      <div className="flex justify-between text-[10px] text-text-muted">
        <span>◀ nearer</span>
        <span>farther ▶</span>
      </div>
    </div>
  )
}

export function ControlsPanel({ camId, controls }: { camId: string; controls: LiveControl[] }): ReactElement {
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => setMessage(null), [camId])

  const send = async (name: string, value: unknown): Promise<boolean> => {
    try {
      const r = await live.setControl(camId, name, value)
      setMessage(r.queued ? 'Queued: a long exposure is still running.' : null)
      return true
    } catch (e) {
      setMessage(errorText(e))
      return false
    }
  }

  if (!controls.length) {
    return <p className="text-xs leading-relaxed text-text-muted">This camera has no adjustable settings (or it is still connecting).</p>
  }

  const groups = [...new Set(controls.map((c) => c.group))]
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={g} className="space-y-3">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{GROUP_TITLES[g] ?? g}</h4>
          {controls
            .filter((c) => c.group === g)
            .map((c) => {
              if (c.kind === 'range') return <RangeRow key={c.name} ctl={c} onCommit={(v) => void send(c.name, v)} />
              if (c.kind === 'toggle')
                return (
                  <label key={c.name} className="flex items-center gap-2 text-xs text-text">
                    <input type="checkbox" checked={!!c.value} onChange={(e) => void send(c.name, e.target.checked)} />
                    {c.label}
                  </label>
                )
              if (c.kind === 'choice')
                return (
                  <label key={c.name} className="block text-xs text-text-muted">
                    {c.label}
                    <select className={`${input} mt-1`} value={String(c.value)} onChange={(e) => void send(c.name, e.target.value)}>
                      {(c.choices ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </label>
                )
              if (c.kind === 'jog') return <JogRow key={c.name} ctl={c} onStep={(v) => send(c.name, v)} />
              if (c.kind === 'info')
                return (
                  <div key={c.name} className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-text-muted">{c.label}</span>
                    <span className="truncate text-right text-text">{String(c.value ?? '')}</span>
                  </div>
                )
              if (c.kind === 'buttons')
                return (
                  <div key={c.name}>
                    <div className="mb-1 text-xs text-text-muted">{c.label}</div>
                    <div className="flex flex-wrap gap-1">
                      {(c.choices ?? []).map((o) => (
                        <button key={o} className={btn} onClick={() => void send(c.name, o)}>
                          {o}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              return (
                <button key={c.name} className={btn} onClick={() => void send(c.name, true)}>
                  {c.label}
                </button>
              )
            })}
        </section>
      ))}
      {message && <p className="text-xs text-warning">{message}</p>}
    </div>
  )
}
