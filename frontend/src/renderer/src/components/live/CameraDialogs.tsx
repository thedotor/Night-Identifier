import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { errorText, live, type Candidate, type LiveCamera, type OnvifStream, type Tested } from '@renderer/lib/liveApi'
import { formFor, KIND_FORMS, type FormField } from './kindForms'
import { btn, btnPrimary, input } from './ui'

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }): ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onMouseDown={onClose}>
      <div
        className={`max-h-full w-full overflow-y-auto rounded-lg border border-border bg-surface p-5 shadow-xl ${wide ? 'max-w-2xl' : 'max-w-lg'}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-text">{title}</h3>
          <button onClick={onClose} className="rounded px-2 text-text-muted hover:text-text" title="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function TestedBadge({ tested }: { tested?: Tested }): ReactElement | null {
  if (!tested || tested === 'hardware') return null
  return (
    <span
      className={`ml-2 rounded border px-1.5 py-px text-[10px] ${tested === 'untested' ? 'border-warning text-warning' : 'border-border text-text-muted'}`}
      title={
        tested === 'untested'
          ? 'Written against the maker documentation but not yet tried on a real camera. If it misbehaves, the Log page will say why.'
          : 'Tried against a stand-in that speaks the same protocol, not against a real camera yet.'
      }
    >
      {tested === 'untested' ? 'not tried on real hardware' : 'tested with a simulator'}
    </span>
  )
}

function Field({ f, value, onChange, keep }: { f: FormField; value: string; onChange: (v: string) => void; keep?: boolean }): ReactElement {
  return (
    <label className="block text-xs text-text-muted">
      {f.label}
      {f.optional ? ' (optional)' : ''}
      <input
        className={`${input} mt-1`}
        type={f.secret ? 'password' : 'text'}
        inputMode={f.number ? 'decimal' : undefined}
        placeholder={keep && f.secret ? 'Leave blank to keep the saved password' : f.placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  )
}

function toParams(fields: FormField[], values: Record<string, string>): Candidate['params'] {
  const out: Candidate['params'] = {}
  for (const f of fields) {
    const v = (values[f.key] ?? '').trim()
    if (!v) continue
    out[f.key] = f.number ? Number(v) : v
  }
  return out
}

export function AddCameraDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (c: LiveCamera) => void }): ReactElement {
  const [found, setFound] = useState<Candidate[] | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [kind, setKind] = useState(KIND_FORMS[0].kind)
  const [name, setName] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [probed, setProbed] = useState<Candidate[] | null>(null)
  const [probing, setProbing] = useState(false)
  const [streams, setStreams] = useState<OnvifStream[] | null>(null)

  useEffect(() => {
    let alive = true
    live
      .discover()
      .then((c) => alive && setFound(c))
      .catch((e) => alive && setScanError(errorText(e)))
    return () => {
      alive = false
    }
  }, [])

  const form = formFor(kind)!

  const add = async (body: { name: string; kind: string; params: Candidate['params'] }): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const cam = await live.add({ ...body, background: false })
      onAdded(cam)
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const missing = form.fields.find((f) => !f.optional && !(values[f.key] ?? '').trim())

  const findCameras = async (): Promise<void> => {
    setProbing(true)
    setError(null)
    setProbed(null)
    setStreams(null)
    try {
      const port = (values.port ?? '').trim()
      if (form.onvif) {
        setStreams(await live.onvif((values.host ?? '').trim(), port ? Number(port) : undefined, values.username ?? '', values.password ?? ''))
      } else {
        setProbed(await live.probe(kind, (values.host ?? '').trim(), port ? Number(port) : undefined))
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setProbing(false)
    }
  }

  return (
    <Modal title="Add a camera" onClose={onClose} wide>
      <section className="mb-5">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Found on this computer</h4>
        {found === null && !scanError && <p className="text-xs text-text-muted">Looking for cameras…</p>}
        {scanError && <p className="text-xs text-danger">Could not scan: {scanError}</p>}
        {found && found.length === 0 && <p className="text-xs text-text-muted">No new webcams found. Check the cable and that no other app is using the camera. Note that DSLR and mirrorless cameras (Canon, Nikon, Sony...) are stills cameras, not webcams, and will not appear here unless the maker's webcam software is installed.</p>}
        <div className="space-y-1">
          {found?.map((c, i) => (
            <div key={i} className={`flex items-center justify-between rounded-md border px-3 py-2 ${c.kind === 'info' ? 'border-warning' : 'border-border'}`}>
              <div className="min-w-0">
                <div className={c.kind === 'info' ? 'text-sm text-text' : 'truncate text-sm text-text'}>
                  {c.name}
                  {c.kind !== 'info' && <TestedBadge tested={c.tested} />}
                </div>
                <div className={`text-[11px] ${c.kind === 'info' ? 'leading-snug text-text-muted' : 'text-text-muted'}`}>{c.note ?? (c.kind === 'synthetic' ? 'A simulated camera for trying Live View without hardware' : c.kind === 'uvc' ? 'USB / video device' : c.kind)}</div>
              </div>
              {c.kind === 'info' ? null : c.kind === 'onvif' ? (
                <button
                  className={btnPrimary}
                  onClick={() => {
                    setKind('onvif')
                    setValues({ host: String(c.params.host ?? ''), port: String(c.params.port ?? '') })
                    setProbed(null)
                    setStreams(null)
                    setError(null)
                  }}
                >
                  Set up…
                </button>
              ) : (
                <button className={btnPrimary} disabled={busy} onClick={() => void add({ name: c.name, kind: c.kind, params: c.params })}>
                  Add
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Add by address</h4>
        <div className="space-y-3">
          <label className="block text-xs text-text-muted">
            Camera type
            <select
              className={`${input} mt-1`}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value)
                setValues({})
                setProbed(null)
                setStreams(null)
                setError(null)
              }}
            >
              {KIND_FORMS.map((f) => (
                <option key={f.kind} value={f.kind}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[11px] leading-relaxed text-text-muted">{form.help}</p>
          {!form.probe && !form.onvif && (
            <label className="block text-xs text-text-muted">
              Name
              <input className={`${input} mt-1`} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Roof all-sky" />
            </label>
          )}
          {form.fields.map((f) => (
            <Field key={f.key} f={f} value={values[f.key] ?? ''} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
          ))}
          {error && <p className="text-xs text-danger">{error}</p>}
          {form.onvif &&
            streams?.map((st, i) => (
              <div key={i} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm text-text">
                    {st.name}
                    <span className="ml-2 text-[11px] text-text-muted">
                      {st.width && st.height ? `${st.width}×${st.height} ` : ''}
                      {st.encoding}
                    </span>
                  </div>
                  <div className="truncate text-[11px] text-text-muted">{st.uri}</div>
                </div>
                <button
                  className={btnPrimary}
                  disabled={busy}
                  onClick={() =>
                    void add({
                      name: `IP camera ${(values.host ?? '').trim()} (${st.name})`,
                      kind: 'rtsp',
                      params: { url: st.uri, ...(values.username ? { username: values.username } : {}), ...(values.password ? { password: values.password } : {}) }
                    })
                  }
                >
                  Add
                </button>
              </div>
            ))}
          {form.probe && probed && probed.length === 0 && (
            <p className="text-xs text-text-muted">No cameras answered at that address. Check that the server is running, the port is right, and the camera is plugged into it.</p>
          )}
          {form.probe &&
            probed?.map((c, i) => (
              <div key={i} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm text-text">
                    {c.name}
                    <TestedBadge tested={c.tested} />
                  </div>
                  <div className="text-[11px] text-text-muted">{c.note}</div>
                </div>
                <button className={btnPrimary} disabled={busy} onClick={() => void add({ name: c.name, kind: c.kind, params: c.params })}>
                  Add
                </button>
              </div>
            ))}
          <div className="flex justify-end gap-2">
            <button className={btn} onClick={onClose}>
              Cancel
            </button>
            {form.probe || form.onvif ? (
              <button className={btnPrimary} disabled={probing || !!missing} onClick={() => void findCameras()}>
                {probing ? 'Looking…' : form.onvif ? 'Find streams' : 'Find cameras'}
              </button>
            ) : (
              <button
                className={btnPrimary}
                disabled={busy || !!missing}
                onClick={() => void add({ name: name.trim() || form.label, kind, params: toParams(form.fields, values) })}
              >
                Add camera
              </button>
            )}
          </div>
        </div>
      </section>
    </Modal>
  )
}

export function EditCameraDialog({
  camera,
  onClose,
  onChanged
}: {
  camera: LiveCamera
  onClose: () => void
  onChanged: () => void
}): ReactElement {
  const form = formFor(camera.kind)
  const [name, setName] = useState(camera.name)
  const [background, setBackground] = useState(camera.background)
  const [reconnect, setReconnect] = useState(camera.auto_reconnect)
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((form?.fields ?? []).map((f) => [f.key, f.secret ? '' : String(camera.params[f.key] ?? '')]))
  )
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Saved values are replaced (even with blank); a blank password or an untouched masked URL is left as stored. */
  const editParams = (): Candidate['params'] | undefined => {
    if (!form) return undefined
    const out: Candidate['params'] = {}
    for (const f of form.fields) {
      const v = (values[f.key] ?? '').trim()
      if (f.secret) {
        if (v) out[f.key] = v
      } else if (f.key === 'url' && v === String(camera.params.url ?? '') && v.includes('••••')) {
        continue
      } else if (f.number) {
        if (v) out[f.key] = Number(v)
      } else {
        out[f.key] = v
      }
    }
    return out
  }

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onChanged()
      onClose()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={`Settings: ${camera.name}`} onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-xs text-text-muted">
          Name
          <input className={`${input} mt-1`} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {form?.fields.map((f) => (
          <Field key={f.key} f={f} keep value={values[f.key] ?? ''} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
        ))}
        <label className="flex items-start gap-2 text-xs text-text">
          <input type="checkbox" className="mt-0.5" checked={background} onChange={(e) => setBackground(e.target.checked)} />
          <span>
            Keep running in the background
            <span className="block text-text-muted">The camera stays connected (and recording or watching for motion) when you leave this page. Otherwise it is released a little after you stop looking at it.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-xs text-text">
          <input type="checkbox" className="mt-0.5" checked={reconnect} onChange={(e) => setReconnect(e.target.checked)} />
          <span>
            Reconnect automatically
            <span className="block text-text-muted">If the cable, network or power drops, keep retrying until it comes back.</span>
          </span>
        </label>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex items-center justify-between pt-1">
          {confirmRemove ? (
            <span className="flex items-center gap-2 text-xs text-danger">
              Remove this camera?
              <button className={btn} onClick={() => void run(() => live.remove(camera.id))} disabled={busy}>
                Yes, remove
              </button>
              <button className={btn} onClick={() => setConfirmRemove(false)}>
                No
              </button>
            </span>
          ) : (
            <button className={btn} onClick={() => setConfirmRemove(true)}>
              Remove…
            </button>
          )}
          <span className="flex gap-2">
            <button className={btn} onClick={onClose}>
              Cancel
            </button>
            <button
              className={btnPrimary}
              disabled={busy || !name.trim()}
              onClick={() =>
                void run(() =>
                  live.patch(camera.id, {
                    name: name.trim(),
                    background,
                    auto_reconnect: reconnect,
                    params: editParams()
                  })
                )
              }
            >
              Save
            </button>
          </span>
        </div>
      </div>
    </Modal>
  )
}
