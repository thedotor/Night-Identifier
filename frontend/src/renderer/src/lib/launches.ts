export interface Launch {
  id: string
  name: string
  provider: string | null
  padName: string | null
  lat: number | null
  lon: number | null
  netMs: number | null
  status: string | null
  statusName: string | null
  mission: string | null
  rocketName: string | null
}

export interface LaunchesPayload {
  rows: {
    id: string
    name: string
    provider: string | null
    pad_name: string | null
    lat: number | null
    lon: number | null
    net_ms: number | null
    status: string | null
    status_name: string | null
    mission: string | null
    rocket_name: string | null
  }[]
  credit: string
}

export function parseLaunches(p: LaunchesPayload): Launch[] {
  return p.rows.map((r) => ({
    id: r.id,
    name: r.name,
    provider: r.provider,
    padName: r.pad_name,
    lat: r.lat,
    lon: r.lon,
    netMs: r.net_ms,
    status: r.status,
    statusName: r.status_name,
    mission: r.mission,
    rocketName: r.rocket_name
  }))
}

const DONE_STATUSES = new Set(['Success', 'Failure', 'Partial Failure'])

/** Is a launch still upcoming (rather than already flown/failed)? */
export const isUpcoming = (l: Launch): boolean => !l.status || !DONE_STATUSES.has(l.status)
