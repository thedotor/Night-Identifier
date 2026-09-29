import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  api,
  DeviceList,
  TrainingEvent,
  TrainingReadiness,
  TrainingRun,
  TrainingStatusOut,
  wsUrl
} from '@renderer/lib/api'

import { usePageState } from '@renderer/lib/pageState'
function formatMetricKey(key: string): string {
  return key.replace(/^metrics\//, '').replace(/^val\//, 'val ').replace(/\(B\)$/, '')
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '-'
}

function formatDuration(ms: number | null): string {
  if (ms == null || !isFinite(ms) || ms < 0) return '-'
  const totalSeconds = Math.round(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatRunDuration(run: TrainingRun): string {
  if (!run.started_at) return '-'
  const start = new Date(run.started_at).getTime()
  const end = run.finished_at ? new Date(run.finished_at).getTime() : Date.now()
  return formatDuration(end - start)
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'text-text-muted',
  running: 'text-accent',
  completed: 'text-success',
  failed: 'text-danger',
  stopped: 'text-warning'
}

export function Train(): ReactElement {
  const [readiness, setReadiness] = useState<TrainingReadiness | null>(null)
  const [devices, setDevices] = useState<DeviceList | null>(null)
  const [status, setStatus] = useState<TrainingStatusOut | null>(null)
  const [runs, setRuns] = useState<TrainingRun[]>([])
  const [liveEpoch, setLiveEpoch] = useState<{ epoch: number; total: number; metrics: Record<string, number> } | null>(
    null
  )
  const [epochs, setEpochs] = usePageState('train', 'epochs', 50, (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined))
  const [batchSize, setBatchSize] = usePageState('train', 'batch', 16, (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined))
  const [workers, setWorkers] = usePageState('train', 'workers', 4, (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined))
  const [device, setDevice] = usePageState('train', 'device', 'auto', (v) => (typeof v === 'string' ? v : undefined))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [epochDurations, setEpochDurations] = useState<number[]>([])
  const lastEpochTimeRef = useRef<number | null>(null)

  const loadAll = (): void => {
    api.get<TrainingReadiness>('/training/readiness').then(setReadiness).catch(() => {})
    api.get<DeviceList>('/training/devices').then(setDevices).catch(() => {})
    api.get<TrainingStatusOut>('/training/status').then(setStatus).catch(() => {})
    api.get<TrainingRun[]>('/training/runs').then(setRuns).catch(() => {})
  }

  useEffect(loadAll, [])

  useEffect(() => {
    const ws = new WebSocket(wsUrl('/training/ws'))
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as TrainingEvent
      if (event.type === 'epoch') {
        const now = Date.now()
        const prev = lastEpochTimeRef.current
        // Skip the very first epoch's duration: it's inflated by one-off
        // startup cost (model load, AMP check, dataloader warmup) that
        // doesn't recur, so including it would badly overestimate ETA.
        if (prev != null) {
          setEpochDurations((durations) => [...durations.slice(-4), now - prev])
        }
        lastEpochTimeRef.current = now
        setLiveEpoch({ epoch: event.epoch, total: event.total_epochs, metrics: event.metrics })
      } else if (event.type === 'status') {
        if (event.status === 'running') {
          setLiveEpoch(null)
          lastEpochTimeRef.current = null
          setEpochDurations([])
        }
        if (['completed', 'failed', 'stopped'].includes(event.status)) {
          setLiveEpoch(null)
          lastEpochTimeRef.current = null
          setEpochDurations([])
          loadAll()
        } else {
          loadAll()
        }
      }
    }
    return () => ws.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleStart = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.post('/training/start', { epochs, batch_size: batchSize, workers, device })
      loadAll()
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
      await api.post('/training/stop')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop training.')
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteModel = async (): Promise<void> => {
    if (!window.confirm('Delete the trained model? You can retrain from scratch afterward.')) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.delete('/training/model')
      loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete the model.')
    } finally {
      setBusy(false)
    }
  }

  const isRunning = status?.is_running ?? false
  // "latest run" can be an in-progress or failed attempt; the model panel
  // should describe whichever completed run actually produced the file on disk.
  const activeModelRun = useMemo(
    () => runs.find((r) => r.status === 'completed' && r.model_path) ?? null,
    [runs]
  )

  const progressPct = useMemo(() => {
    if (!liveEpoch || liveEpoch.total === 0) return 0
    return Math.min(100, Math.round((Math.min(liveEpoch.epoch, liveEpoch.total) / liveEpoch.total) * 100))
  }, [liveEpoch])

  const etaMs = useMemo(() => {
    if (!liveEpoch || epochDurations.length === 0) return null
    const avgPerEpoch = epochDurations.reduce((sum, d) => sum + d, 0) / epochDurations.length
    const remaining = Math.max(0, liveEpoch.total - liveEpoch.epoch)
    return avgPerEpoch * remaining
  }, [liveEpoch, epochDurations])

  return (
    <div className="flex h-full flex-col overflow-y-auto p-8">
      <h1 className="text-xl font-semibold text-text">Train</h1>
      <p className="mt-2 max-w-2xl text-sm text-text-muted">
        Train a custom object detector on the things you label in Annotate. GPU accelerated with
        automatic CPU fallback.
      </p>

      {readiness && !readiness.ready && (
        <div className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
          {readiness.message} ({readiness.object_type_count} object type
          {readiness.object_type_count === 1 ? '' : 's'}, {readiness.annotated_image_count} labeled
          image{readiness.annotated_image_count === 1 ? '' : 's'})
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Hyperparameters + controls */}
        <div className="rounded-lg border border-border bg-surface p-5">
          <div className="mb-3 text-sm font-medium text-text">Training settings</div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs text-text-muted">
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
            <label className="flex flex-col gap-1 text-xs text-text-muted">
              Batch size
              <input
                type="number"
                min={1}
                value={batchSize}
                onChange={(e) => setBatchSize(Number(e.target.value))}
                disabled={isRunning}
                className="rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent disabled:opacity-50"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-text-muted">
              Worker count
              <input
                type="number"
                min={0}
                value={workers}
                onChange={(e) => setWorkers(Number(e.target.value))}
                disabled={isRunning}
                className="rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent disabled:opacity-50"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-text-muted">
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
          </div>

          <div className="mt-4 flex gap-2">
            {!isRunning ? (
              <button
                onClick={handleStart}
                disabled={busy || !readiness?.ready}
                className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-bg disabled:opacity-50"
              >
                Start training
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
          </div>

          {isRunning && (
            <div className="mt-4">
              <div className="mb-1 flex justify-between text-xs text-text-muted">
                <span>
                  Epoch {liveEpoch ? Math.min(liveEpoch.epoch, liveEpoch.total) : 0} /{' '}
                  {liveEpoch?.total ?? epochs}
                </span>
                <span>{progressPct}%</span>
              </div>
              <div className="mb-1 text-right text-xs text-text-muted">
                {etaMs != null
                  ? `Estimated time remaining: ${formatDuration(etaMs)}`
                  : 'Estimating time remaining...'}
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-bg">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              {liveEpoch && Object.keys(liveEpoch.metrics).length > 0 && (
                <div className="mt-3 grid grid-cols-2 gap-1 text-xs text-text-muted">
                  {Object.entries(liveEpoch.metrics).map(([k, v]) => (
                    <div key={k} className="flex justify-between rounded bg-bg px-2 py-1">
                      <span>{formatMetricKey(k)}</span>
                      <span className="text-text">{v.toFixed(4)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Model status */}
        <div className="rounded-lg border border-border bg-surface p-5">
          <div className="mb-3 text-sm font-medium text-text">Current model</div>
          {status?.has_model && activeModelRun ? (
            <div>
              <div className="text-sm text-text">Trained (run #{activeModelRun.id})</div>
              <div className="mt-1 text-xs text-text-muted">
                Completed {formatDate(activeModelRun.finished_at)} &middot; {activeModelRun.class_count}{' '}
                classes &middot; {activeModelRun.image_count} images
              </div>
              {Object.keys(activeModelRun.metrics).length > 0 && (
                <div className="mt-3 grid grid-cols-2 gap-1 text-xs text-text-muted">
                  {Object.entries(activeModelRun.metrics).map(([k, v]) => (
                    <div key={k} className="flex justify-between rounded bg-bg px-2 py-1">
                      <span>{formatMetricKey(k)}</span>
                      <span className="text-text">{v.toFixed(4)}</span>
                    </div>
                  ))}
                </div>
              )}
              <button
                onClick={handleDeleteModel}
                disabled={busy || isRunning}
                className="mt-4 rounded-md border border-danger/50 px-3 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
              >
                Delete model &amp; retrain from scratch
              </button>
            </div>
          ) : (
            <div className="text-sm text-text-muted">No model trained yet.</div>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="mt-8">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Run history
        </div>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-left text-xs">
            <thead className="bg-surface text-text-muted">
              <tr>
                <th className="px-3 py-2">Run</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Device</th>
                <th className="px-3 py-2">Epochs</th>
                <th className="px-3 py-2">Images</th>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Finished</th>
                <th className="px-3 py-2">Duration</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-border bg-bg">
                  <td className="px-3 py-2 text-text">#{r.id}</td>
                  <td className={`px-3 py-2 font-medium ${STATUS_COLOR[r.status] ?? ''}`}>{r.status}</td>
                  <td className="px-3 py-2 text-text-muted">{r.device}</td>
                  <td className="px-3 py-2 text-text-muted">
                    {r.current_epoch}/{r.epochs}
                  </td>
                  <td className="px-3 py-2 text-text-muted">{r.image_count}</td>
                  <td className="px-3 py-2 text-text-muted">{formatDate(r.started_at)}</td>
                  <td className="px-3 py-2 text-text-muted">{formatDate(r.finished_at)}</td>
                  <td className="px-3 py-2 text-text-muted">{formatRunDuration(r)}</td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-4 text-center text-text-muted">
                    No training runs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
