import { useEffect, useState, type ReactElement } from 'react'
import { api, DashboardStats, HealthStatus, ImageStats, TrainingStatusOut } from '@renderer/lib/api'

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }): ReactElement {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="text-xs uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-text">{value}</div>
      {hint && <div className="mt-1 text-xs text-text-muted">{hint}</div>}
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

function Section({ title, children }: { title: string; children: React.ReactNode }): ReactElement {
  return (
    <>
      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-text-muted">{title}</h2>
      <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">{children}</div>
    </>
  )
}

export function Dashboard(): ReactElement {
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [imageStats, setImageStats] = useState<ImageStats | null>(null)
  const [training, setTraining] = useState<TrainingStatusOut | null>(null)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .health()
      .then((h) => {
        if (!cancelled) setHealth(h)
      })
      .catch(() => {
        if (!cancelled) setError('Backend unreachable')
      })
    api.get<ImageStats>('/images/stats').then((s) => !cancelled && setImageStats(s)).catch(() => {})
    api
      .get<TrainingStatusOut>('/training/status')
      .then((s) => !cancelled && setTraining(s))
      .catch(() => {})
    api.get<DashboardStats>('/dashboard/stats').then((s) => !cancelled && setStats(s)).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Check is_running first: has_model can stay true from an older completed
  // run while a newer run is in progress, so it alone can't tell us which
  // run's id is actually behind the active model file.
  const num = (v: number | undefined): string => (v === undefined ? '-' : v.toLocaleString())
  const mapKey = Object.keys(training?.latest_run?.metrics ?? {}).find((k) => k.includes('mAP50(B)'))
  const map50 = mapKey ? training?.latest_run?.metrics[mapKey] : undefined

  const modelValue = training?.is_running
    ? 'Training...'
    : training?.has_model
      ? 'Trained'
      : 'No model trained'

  return (
    <div className="flex h-full flex-col overflow-y-auto p-8">
      <h1 className="text-xl font-semibold text-text">Dashboard</h1>
      <p className="mt-2 text-sm text-text-muted">Quick status across scanning, training, and the model.</p>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Backend" value={error ? 'Offline' : health ? 'Online' : 'Checking...'} />
        <StatCard
          label="GPU"
          value={health?.gpu_available ? 'Available' : health ? 'CPU only' : '-'}
          hint={health?.gpu_name ?? undefined}
        />
        <StatCard label="Model version" value={modelValue} />
        <StatCard
          label="Pending images"
          value={imageStats ? String(imageStats.pending) : '-'}
          hint={imageStats ? `${imageStats.total} total in library` : undefined}
        />
      </div>

      <Section title="Library">
        <StatCard label="Library images" value={num(stats?.library_images)} />
        <StatCard
          label="Processed"
          value={num(stats?.processed_images)}
          hint={stats ? `${stats.detections.toLocaleString()} detections` : undefined}
        />
        <StatCard label="Geotagged" value={num(stats?.geotagged_images)} hint="Shown on the Map" />
        <StatCard label="Storage used" value={stats ? formatBytes(stats.storage_bytes) : '-'} />
      </Section>

      <Section title="Training data & model">
        <StatCard label="Training images" value={num(stats?.training_images)} />
        <StatCard label="Object types" value={num(stats?.object_types)} />
        <StatCard label="Manual annotations" value={num(stats?.manual_annotations)} />
        <StatCard
          label="Training runs"
          value={num(stats?.training_runs)}
          hint={stats ? `${stats.completed_training_runs} completed` : undefined}
        />
        <StatCard
          label="Latest mAP50"
          value={map50 !== undefined ? map50.toFixed(3) : '-'}
          hint={training?.latest_run ? `Run #${training.latest_run.id}` : undefined}
        />
      </Section>

      {error && (
        <div className="mt-6 rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Could not reach the local backend at http://127.0.0.1:8765. Make sure it's running.
        </div>
      )}
    </div>
  )
}
