import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { errorText, live, type CameraStatus, type FrameFormat, type StretchSpec } from '@renderer/lib/liveApi'
import { liveSocket } from '@renderer/lib/liveSocket'
import { btn, btnPrimary, input } from './ui'

interface Props {
  camId: string
  status: CameraStatus | null
  stretch: StretchSpec
}

type Note = { text: string; ok: boolean; imageId?: number; path?: string } | null

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }): ReactElement {
  return (
    <section className="space-y-2 border-b border-border pb-4 last:border-b-0">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{title}</h4>
      {hint && <p className="text-[11px] leading-snug text-text-muted">{hint}</p>}
      {children}
    </section>
  )
}

function useElapsed(active: boolean): number {
  const [s, setS] = useState(0)
  useEffect(() => {
    if (!active) {
      setS(0)
      return
    }
    const t0 = Date.now()
    const id = window.setInterval(() => setS(Math.floor((Date.now() - t0) / 1000)), 500)
    return () => window.clearInterval(id)
  }, [active])
  return s
}

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

export function CapturePanel({ camId, status, stretch }: Props): ReactElement {
  const navigate = useNavigate()
  const running = status?.state === 'running'
  const astro = !!status?.astro
  const stretchArg = astro ? stretch : null

  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<Record<string, Note>>({})
  const setNoteFor = (k: string, n: Note): void => setNote((s) => ({ ...s, [k]: n }))

  const [frameFmt, setFrameFmt] = useState<FrameFormat>(astro ? 'fits' : 'png')
  const [frameLib, setFrameLib] = useState(true)
  const [recFmt, setRecFmt] = useState<'mp4' | 'ser'>('mp4')
  const [count, setCount] = useState('20')
  const [interval, setIntervalS] = useState('5')
  const [seqFmt, setSeqFmt] = useState<FrameFormat>(astro ? 'fits' : 'jpg')
  const [seqLib, setSeqLib] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const recording = !!status?.recording
  const sequencing = !!status?.sequence
  const elapsed = useElapsed(recording)
  const formatTouched = useRef(false)

  useEffect(() => {
    if (formatTouched.current) return
    setFrameFmt(astro ? 'fits' : 'png')
    setSeqFmt(astro ? 'fits' : 'jpg')
  }, [astro])

  useEffect(() => {
    return liveSocket.onEvent((e) => {
      if (e.type === 'progress' && e.camera === camId && e.kind === 'sequence') setProgress({ done: e.done, total: e.total })
      if (e.type === 'sequence_done' && e.camera === camId) {
        setProgress(null)
        setNoteFor('sequence', {
          ok: true,
          text: `Sequence ${e.stopped_early ? 'stopped' : 'finished'}: ${e.frames} frame${e.frames === 1 ? '' : 's'} saved${e.imported ? `, ${e.imported} added to the library` : ''}.`,
          path: e.folder
        })
      }
    })
  }, [camId])

  const stills = !!status?.info?.stills
  useEffect(() => {
    return liveSocket.onEvent((e) => {
      if (e.type === 'photo' && e.camera === camId)
        setNoteFor('photo', {
          ok: true,
          text: e.image_id !== null ? 'Photo saved and added to your library.' : 'Photo saved to the Live folder (it could not be added to the library; see the Log page).',
          imageId: e.image_id ?? undefined,
          path: e.file
        })
    })
  }, [camId])

  const run = async (key: string, fn: () => Promise<Note>): Promise<void> => {
    setBusy(key)
    setNoteFor(key, null)
    try {
      setNoteFor(key, await fn())
    } catch (e) {
      setNoteFor(key, { ok: false, text: errorText(e) })
    } finally {
      setBusy(null)
    }
  }

  const noteView = (k: string): ReactElement | null => {
    const n = note[k]
    if (!n) return null
    return (
      <p className={`break-words text-xs ${n.ok ? 'text-success' : 'text-danger'}`}>
        {n.text}{' '}
        {n.ok && n.imageId !== undefined && (
          <button className={`${btn} ml-1`} onClick={() => navigate('/upload')}>
            Open library
          </button>
        )}
        {n.ok && n.path && (
          <button className={`${btn} ml-1`} onClick={() => void window.api.showItemInFolder(n.path!)}>
            Show in folder
          </button>
        )}
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {stills && (
        <Section
          title="Photo (full quality)"
          hint="Takes a real photo with the camera (RAW or JPEG, as set on the camera) and adds it to your library. The live picture is a lower-quality preview."
        >
          <button
            className={btnPrimary}
            disabled={!running || busy !== null}
            onClick={() =>
              void run('photo', async () => {
                await live.setControl(camId, 'take_photo', true)
                return { ok: true, text: 'Taking the photo…' }
              })
            }
          >
            {busy === 'photo' ? 'Working…' : '📷 Take photo'}
          </button>
          {noteView('photo')}
        </Section>
      )}

      <Section title="Snapshot" hint="Saves the current picture (as you see it) into your image library, with the capture time stored in it.">
        <button
          className={btnPrimary}
          disabled={!running || busy !== null}
          onClick={() =>
            void run('snapshot', async () => {
              const r = await live.snapshot(camId, stretchArg)
              return { ok: true, text: `Saved to your library as ${r.filename}`, imageId: r.image_id }
            })
          }
        >
          {busy === 'snapshot' ? 'Saving…' : 'Save snapshot to library'}
        </button>
        {noteView('snapshot')}
      </Section>

      <Section
        title="Single frame"
        hint={astro ? 'FITS keeps the full sensor data (for stacking and calibration). PNG / JPEG save the stretched picture.' : 'Save one frame in the format you choose.'}
      >
        <div className="flex items-center gap-2">
          <select
            className={input}
            value={frameFmt}
            onChange={(e) => {
              formatTouched.current = true
              setFrameFmt(e.target.value as FrameFormat)
            }}
          >
            <option value="fits">FITS (full data)</option>
            <option value="png">PNG</option>
            <option value="jpg">JPEG</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-xs text-text">
          <input type="checkbox" checked={frameLib} onChange={(e) => setFrameLib(e.target.checked)} />
          Also add to the library
        </label>
        <button
          className={btn}
          disabled={!running || busy !== null}
          onClick={() =>
            void run('frame', async () => {
              const r = await live.capture(camId, { format: frameFmt, to_library: frameLib, stretch: stretchArg })
              return { ok: true, text: `Saved ${r.filename}${frameLib ? ' and added to the library' : ''}.`, imageId: r.image_id, path: r.saved_to }
            })
          }
        >
          {busy === 'frame' ? 'Saving…' : 'Capture frame'}
        </button>
        {noteView('frame')}
      </Section>

      <Section title="Record video" hint={astro ? 'MP4 plays anywhere. SER keeps full quality for planetary stacking (AutoStakkert!, Siril).' : 'Records what you see to an MP4 file in the Live folder.'}>
        {!recording && (
          <div className="flex items-center gap-2">
            <select className={input} value={recFmt} onChange={(e) => setRecFmt(e.target.value as 'mp4' | 'ser')}>
              <option value="mp4">MP4 video</option>
              <option value="ser">SER (full quality)</option>
            </select>
            <button
              className={btnPrimary}
              disabled={!running || busy !== null}
              onClick={() =>
                void run('record', async () => {
                  const r = await live.record(camId, { format: recFmt, stretch: stretchArg })
                  return { ok: true, text: `Recording to ${r.file}` }
                })
              }
            >
              ● Record
            </button>
          </div>
        )}
        {recording && (
          <div className="flex items-center gap-3">
            <span className="animate-pulse text-danger">● REC {clock(elapsed)}</span>
            <button
              className={btn}
              disabled={busy !== null}
              onClick={() =>
                void run('record', async () => {
                  const r = await live.stopRecord(camId)
                  return r.error
                    ? { ok: false, text: r.error }
                    : { ok: true, text: `Saved ${r.frames} frames (${r.seconds}s)${r.dropped ? `, ${r.dropped} dropped because the disk was too slow` : ''}.`, path: r.file }
                })
              }
            >
              ■ Stop
            </button>
          </div>
        )}
        {noteView('record')}
      </Section>

      <Section title="Timelapse / sequence" hint="Takes a frame every N seconds and saves them into one folder.">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-text-muted">
            Frames
            <input className={`${input} mt-1`} value={count} inputMode="numeric" onChange={(e) => setCount(e.target.value)} disabled={sequencing} />
          </label>
          <label className="text-xs text-text-muted">
            Every (seconds)
            <input className={`${input} mt-1`} value={interval} inputMode="decimal" onChange={(e) => setIntervalS(e.target.value)} disabled={sequencing} />
          </label>
        </div>
        <select
          className={input}
          value={seqFmt}
          disabled={sequencing}
          onChange={(e) => {
            formatTouched.current = true
            setSeqFmt(e.target.value as FrameFormat)
          }}
        >
          <option value="fits">FITS (full data)</option>
          <option value="png">PNG</option>
          <option value="jpg">JPEG</option>
        </select>
        <label className="flex items-center gap-2 text-xs text-text">
          <input type="checkbox" checked={seqLib} onChange={(e) => setSeqLib(e.target.checked)} disabled={sequencing} />
          Add the frames to the library when finished
        </label>
        {!sequencing ? (
          <button
            className={btnPrimary}
            disabled={!running || busy !== null}
            onClick={() =>
              void run('sequence', async () => {
                const n = Math.max(1, Math.round(Number(count) || 0))
                const every = Math.max(0, Number(interval) || 0)
                const r = await live.sequence(camId, { count: n, interval_s: every, format: seqFmt, to_library: seqLib, stretch: stretchArg })
                setProgress({ done: 0, total: r.count })
                return { ok: true, text: `Started: ${r.count} frames into ${r.folder}` }
              })
            }
          >
            Start sequence
          </button>
        ) : (
          <div className="space-y-1">
            <div className="h-1.5 overflow-hidden rounded bg-border">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${progress ? (progress.done / progress.total) * 100 : 0}%` }} />
            </div>
            <div className="flex items-center justify-between text-xs text-text-muted">
              <span>{progress ? `${progress.done} of ${progress.total}` : 'Running…'}</span>
              <button className={btn} onClick={() => void run('sequence', async () => { await live.stopSequence(camId); return null })}>
                ■ Stop
              </button>
            </div>
          </div>
        )}
        {noteView('sequence')}
      </Section>
    </div>
  )
}
