import { useEffect, useState } from 'react'
import { api, type DashboardStats, type HealthStatus, type ImageStats, type TrainingStatusOut } from '@renderer/lib/api'
import type { DriveInfo } from '@renderer/notifications/alertLogic'
import type { Place } from '@renderer/lib/skyTonight'
import type { DashData } from './widgets'

/** What the dashboard's cards are given: the app's status, gathered once when the page opens. Shared by the Dashboard and the second-monitor window. */
export function useDashData(place: Place | null): DashData {
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [imageStats, setImageStats] = useState<ImageStats | null>(null)
  const [training, setTraining] = useState<TrainingStatusOut | null>(null)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drives, setDrives] = useState<DriveInfo[]>([])

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
    api.get<{ drives: DriveInfo[] }>('/dashboard/disk').then((d) => !cancelled && setDrives(d.drives)).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return { health, imageStats, training, stats, error, place, drives }
}
