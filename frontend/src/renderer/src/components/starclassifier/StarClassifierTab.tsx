import { initialImageId, rememberImage } from '@renderer/lib/lastImage'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  api,
  DeviceList,
  ImageRecord,
  StarCandidate,
  StarClassifierEvent,
  StarClassifierRun,
  StarClassifierStatusOut,
  StarClassifierSummary,
  StarLabelRecord,
  StarLabelType,
  previewUrl,
  wsUrl
} from '@renderer/lib/api'
import { StarLabelCanvas } from './StarLabelCanvas'

function nextLabel(current: StarLabelType | null): StarLabelType | null {
  if (current === null) return 'star'
  if (current === 'star') return 'not_star'
  return null
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '-'
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'text-text-muted',
  running: 'text-accent',
  completed: 'text-success',
  failed: 'text-danger',
  stopped: 'text-warning'
}

export function StarClassifierTab(): ReactElement {
  const [images, setImages] = useState<ImageRecord[]>([])
  const [selectedImageId, setSelectedImageId] = useState<number | null>(null)
  const [candidates, setCandidates] = useState<StarCandidate[]>([])
  const [labels, setLabels] = useState<StarLabelRecord[]>([])
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const [summary, setSummary] = useState<StarClassifierSummary | null>(null)
  const [devices, setDevices] = useState<DeviceList | null>(null)
  const [status, setStatus] = useState<StarClassifierStatusOut | null>(null)
  const [liveEpoch, setLiveEpoch] = useState<{ epoch: number; total: number; metrics: Record<string, number> } | null>(
    null
  )
  const [epochs, setEpochs] = useState(30)
  const [device, setDevice] = useState('auto')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadStatusPanel = (): void => {
    api.get<StarClassifierSummary>('/star-classifier/summary').then(setSummary).catch(() => {})
    api.get<StarClassifierStatusOut>('/star-classifier/status').then(setStatus).catch(() => {})
  }

  useEffect(() => {
    api
      .get<ImageRecord[]>('/images')
      .then((imgs) => {
        setImages(imgs)
        setSelectedImageId(initialImageId(imgs))
      })
      .catch(() => setError('Could not load images from the backend.'))
    api.get<DeviceList>('/training/devices').then(setDevices).catch(() => {})
    loadStatusPanel()
  }, [])

  useEffect(() => {
    const ws = new WebSocket(wsUrl('/star-classifier/ws'))
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as StarClassifierEvent
      if (event.type === 'epoch') {
        setLiveEpoch({ epoch: event.epoch, total: event.total_epochs, metrics: event.metrics })
      } else if (event.type === 'status') {
        if (event.status === 'running') setLiveEpoch(null)
        if (['completed', 'failed', 'stopped'].includes(event.status)) setLiveEpoch(null)
        loadStatusPanel()
      }
    }
    return () => ws.close()
  }, [])

  useEffect(() => {
    setCandidates([])
    setLabels([])
    setError(null)
    if (selectedImageId == null) return
    setLoadingCandidates(true)
    Promise.all([
      api.get<StarCandidate[]>(`/star-classifier/candidates/${selectedImageId}`),
      api.get<StarLabelRecord[]>(`/star-classifier/labels/${selectedImageId}`)
    ])
      .then(([c, l]) => {
        setCandidates(c)
        setLabels(l)
      })
      .catch(() => setError('Could not load star candidates for this image.'))
      .finally(() => setLoadingCandidates(false))
  }, [selectedImageId])

  const selectedImage = images.find((i) => i.id === selectedImageId) ?? null

  const saveLabels = async (next: { x: number; y: number; label: StarLabelType }[]): Promise<void> => {
    if (selectedImageId == null) return
    try {
      const saved = await api.put<StarLabelRecord[]>(`/star-classifier/labels/${selectedImageId}`, {
        labels: next.map((l) => [l.x, l.y, l.label])
      })
      setLabels(saved)
      loadStatusPanel()
    } catch {
      setError('Failed to save label.')
    }
  }

  const handleCycleLabel = (candidate: StarCandidate): void => {
    const existing = labels.find((l) => Math.hypot(l.x - candidate.x, l.y - candidate.y) < 6)
    const current = existing?.label ?? null
    const next = nextLabel(current)
    const withoutThis = labels
      .filter((l) => l !== existing)
      .map((l) => ({ x: l.x, y: l.y, label: l.label }))
    const nextList = next == null ? withoutThis : [...withoutThis, { x: candidate.x, y: candidate.y, label: next }]
    setLabels(nextList.map((l, i) => ({ id: i, ...l })))
    void saveLabels(nextList)
  }

  const handleTrain = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.post('/star-classifier/train', { epochs, device })
      loadStatusPanel()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start training.')
    } finally {
      setBusy(false)
    }
  }

  const handleStop = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.post('/star-classifier/stop')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop training.')
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteModel = async (): Promise<void> => {
    if (!window.confirm('Delete the trained star classifier? Detection will fall back to the built-in heuristics.')) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.delete('/star-classifier/model')
      loadStatusPanel()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete the model.')
    } finally {
      setBusy(false)
    }
  }

  const isRunning = status?.is_running ?? false
  const progressPct = useMemo(() => {
    if (!liveEpoch || liveEpoch.total === 0) return 0
    return Math.min(100, Math.round((Math.min(liveEpoch.epoch, liveEpoch.total) / liveEpoch.total) * 100))
  }, [liveEpoch])

  const starCount = labels.filter((l) => l.label === 'star').length
  const notStarCount = labels.filter((l) => l.label === 'not_star').length

  return (
    <div className="flex h-full">
      {/* Image list */}
      <div className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
        <div className="border-b border-border p-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Images
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {images.map((img) => (
            <button
              key={img.id}
              onClick={() => {
                setSelectedImageId(img.id)
                rememberImage(img.id)
              }}
              className={`mb-2 block w-full overflow-hidden rounded-md border text-left ${
                img.id === selectedImageId ? 'border-accent' : 'border-border hover:border-accent/50'
              }`}
            >
              <img src={previewUrl(img.id)} alt={img.filename} className="h-24 w-full object-cover" />
              <div className="truncate px-2 py-1 text-xs text-text-muted">{img.filename}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Canvas */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2">
          <p className="text-xs text-text-muted">
            Click a candidate marker to cycle: unlabeled &rarr; <span className="text-green-400">star</span> &rarr;{' '}
            <span className="text-red-400">not a star</span> &rarr; unlabeled. Scroll to zoom, drag to pan.
          </p>
          <span className="shrink-0 text-xs text-text-muted">
            {loadingCandidates ? 'Loading candidates...' : `${candidates.length} candidates`} &middot; this image:{' '}
            <span className="text-green-400">{starCount}</span> star,{' '}
            <span className="text-red-400">{notStarCount}</span> not-star
          </span>
        </div>
        <div className="min-h-0 flex-1">
          {selectedImage ? (
            <StarLabelCanvas
              key={selectedImage.id}
              previewUrl={previewUrl(selectedImage.id)}
              imageWidth={selectedImage.width}
              imageHeight={selectedImage.height}
              candidates={candidates}
              labels={labels}
              onCycleLabel={handleCycleLabel}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-text-muted">
              Select an image to begin
            </div>
          )}
        </div>
        {error && (
          <div className="border-t border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger">{error}</div>
        )}
      </div>

      {/* Training panel */}
      <div className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-surface p-4">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Star classifier
        </div>
        <p className="mb-4 text-xs leading-snug text-text-muted">
          Label enough examples across a few images, then train a small GPU model that learns to tell
          real stars apart from bright non-star clutter (lights, foliage) better than the built-in
          heuristics.
        </p>

        {summary && (
          <div className="mb-4 rounded-md border border-border bg-bg p-3 text-xs">
            <div className="flex justify-between text-text-muted">
              <span>Total labeled (all images)</span>
            </div>
            <div className="mt-1 flex justify-between">
              <span className="text-green-400">{summary.star_count} star</span>
              <span className="text-red-400">{summary.not_star_count} not-star</span>
            </div>
            <div className="mt-2 text-text-muted">
              Need at least {summary.min_per_class} of each to train.{' '}
              {summary.ready_to_train ? (
                <span className="text-success">Ready.</span>
              ) : (
                <span>Keep labeling.</span>
              )}
            </div>
          </div>
        )}

        <label className="mb-2 flex flex-col gap-1 text-xs text-text-muted">
          Epochs
          <input
            type="number"
            min={1}
            value={epochs}
            onChange={(e) => setEpochs(Number(e.target.value))}
            disabled={isRunning}
            className="rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent disabled:opacity-50"
          />
        </label>
        <label className="mb-3 flex flex-col gap-1 text-xs text-text-muted">
          Device
          <select
            value={device}
            onChange={(e) => setDevice(e.target.value)}
            disabled={isRunning}
            className="rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent disabled:opacity-50"
          >
            <option value="auto">
              Auto {devices?.available ? `(${devices.devices[0]?.name})` : '(CPU - no GPU detected)'}
            </option>
            {devices?.devices.map((d) => (
              <option key={d.index} value={`cuda:${d.index}`}>
                {d.name}
              </option>
            ))}
            <option value="cpu">CPU</option>
          </select>
        </label>

        {!isRunning ? (
          <button
            onClick={handleTrain}
            disabled={busy || !summary?.ready_to_train}
            title={!summary?.ready_to_train ? 'Label more examples first' : undefined}
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-bg disabled:opacity-50"
          >
            Train classifier
          </button>
        ) : (
          <button
            onClick={handleStop}
            disabled={busy}
            className="rounded-md bg-danger px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Stop
          </button>
        )}

        {isRunning && (
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-xs text-text-muted">
              <span>
                Epoch {liveEpoch ? Math.min(liveEpoch.epoch, liveEpoch.total) : 0} / {liveEpoch?.total ?? epochs}
              </span>
              <span>{progressPct}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-bg">
              <div className="h-full bg-accent transition-all" style={{ width: `${progressPct}%` }} />
            </div>
            {liveEpoch && Object.keys(liveEpoch.metrics).length > 0 && (
              <div className="mt-3 grid grid-cols-1 gap-1 text-xs text-text-muted">
                {Object.entries(liveEpoch.metrics).map(([k, v]) => (
                  <div key={k} className="flex justify-between rounded bg-bg px-2 py-1">
                    <span>{k}</span>
                    <span className="text-text">{v.toFixed(4)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-6 border-t border-border pt-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Current model
          </div>
          {status?.has_model ? (
            <div>
              <div className="text-sm text-text">Trained and active</div>
              {status.latest_run && (
                <div className="mt-1 text-xs text-text-muted">
                  Run #{status.latest_run.id} &middot;{' '}
                  <span className={STATUS_COLOR[status.latest_run.status] ?? ''}>{status.latest_run.status}</span>
                  {status.latest_run.finished_at && <> &middot; {formatDate(status.latest_run.finished_at)}</>}
                </div>
              )}
              {status.latest_run && Object.keys(status.latest_run.metrics).length > 0 && (
                <div className="mt-2 grid grid-cols-1 gap-1 text-xs text-text-muted">
                  {Object.entries(status.latest_run.metrics).map(([k, v]) => (
                    <div key={k} className="flex justify-between rounded bg-bg px-2 py-1">
                      <span>{k}</span>
                      <span className="text-text">{v.toFixed(4)}</span>
                    </div>
                  ))}
                </div>
              )}
              <button
                onClick={handleDeleteModel}
                disabled={busy || isRunning}
                className="mt-3 rounded-md border border-danger/50 px-3 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
              >
                Delete model
              </button>
            </div>
          ) : (
            <div className="text-xs text-text-muted">
              No trained classifier yet &mdash; detection uses the built-in heuristics.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
