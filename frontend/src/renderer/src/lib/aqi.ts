export interface AqiStation {
  id: number
  name: string
  country: string
  latDeg: number
  lonDeg: number
  pm25: number
  aqi: number
  measuredAt: number | null
}

export interface AqiPayload {
  rows: { id: number; name: string; country: string; lat: number; lon: number; pm25: number; aqi: number; measured_at: string | null }[]
  credit: string
  has_key: boolean
}

export function parseAqiStations(p: AqiPayload): AqiStation[] {
  return p.rows.map((r) => ({
    id: r.id,
    name: r.name,
    country: r.country,
    latDeg: r.lat,
    lonDeg: r.lon,
    pm25: r.pm25,
    aqi: r.aqi,
    measuredAt: r.measured_at ? new Date(r.measured_at).getTime() : null
  }))
}

/** US EPA Air Quality Index categories, 0-50 Good up to 301+ Hazardous. */
const AQI_LEVELS: { max: number; label: string; colour: string }[] = [
  { max: 50, label: 'Good', colour: '#00e400' },
  { max: 100, label: 'Moderate', colour: '#ffff00' },
  { max: 150, label: 'Unhealthy for sensitive groups', colour: '#ff7e00' },
  { max: 200, label: 'Unhealthy', colour: '#ff0000' },
  { max: 300, label: 'Very unhealthy', colour: '#8f3f97' },
  { max: Infinity, label: 'Hazardous', colour: '#7e0023' }
]

export const aqiColour = (aqi: number): string => (AQI_LEVELS.find((l) => aqi <= l.max) ?? AQI_LEVELS[AQI_LEVELS.length - 1]).colour
export const aqiLabel = (aqi: number): string => (AQI_LEVELS.find((l) => aqi <= l.max) ?? AQI_LEVELS[AQI_LEVELS.length - 1]).label
