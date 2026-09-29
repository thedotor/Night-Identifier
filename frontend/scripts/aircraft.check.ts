// Sanity checks for lib/aircraft.ts. Run: node --import ./scripts/ts-resolve.mjs scripts/aircraft.check.ts
import { advance, buildPlaneFrame, countKinds, lookFrom, parseAircraft, type Aircraft } from '../src/renderer/src/lib/aircraft'
import { AIRCRAFT_KINDS, SHAPE_ORDER, SHAPE_PATHS, asKind, type AircraftKind } from '../src/renderer/src/lib/aircraftIcons'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
  if (!ok) failed++
}

const plane = (o: Partial<Aircraft>): Aircraft => ({ hex: 'x', callsign: '', latDeg: 0, lonDeg: 0, altM: 10000, speedMs: 250, trackDeg: 90, vrateMs: 0, type: '', reg: '', kind: 'jet', shape: 'jet', tMs: 0, ...o })

// directly overhead: 90 degrees
const site = { latDeg: 51.5, lonDeg: -0.1 }
const over = lookFrom(site, { latDeg: 51.5, lonDeg: -0.1, altM: 10000 })
check('overhead aircraft is at the zenith', over.altDeg > 89.9 && Math.abs(over.rangeKm - 10) < 0.05, `${over.altDeg.toFixed(2)} deg, ${over.rangeKm.toFixed(2)} km`)

// 100 km due north on the ground at 10 km: atan(10/100) minus ~0.7 deg of Earth curvature
const north = lookFrom(site, { latDeg: 51.5 + 100 / 111.19, lonDeg: -0.1, altM: 10000 })
check('100 km north at 10 km height: about 4.5 deg up, azimuth north', north.altDeg > 4 && north.altDeg < 5.6 && (north.azDeg < 1 || north.azDeg > 359), `${north.altDeg.toFixed(2)} deg az ${north.azDeg.toFixed(2)}`)

const east = lookFrom(site, { latDeg: 51.5, lonDeg: -0.1 + 100 / (111.19 * Math.cos((51.5 * Math.PI) / 180)), altM: 10000 })
check('a point 100 km along the same parallel is at azimuth ~89.4 (great-circle bearing curves toward the pole)', Math.abs(east.azDeg - 89.43) < 0.1, `${east.azDeg.toFixed(2)}`)

// dead reckoning: 250 m/s due east for 60 s at the equator = 15 km = 0.1349 deg
const moved = advance(plane({ tMs: 0 }), 60_000)
check('60 s at 250 m/s due east moves 0.1349 deg of longitude', Math.abs(moved.lonDeg - 0.13489) < 0.0005 && Math.abs(moved.latDeg) < 0.0005, `${moved.lonDeg.toFixed(5)}`)
const north2 = advance(plane({ tMs: 0, trackDeg: 0 }), 100_000)
check('due north moves latitude only', Math.abs(north2.latDeg - 25000 / 111195) < 0.001 && Math.abs(north2.lonDeg) < 1e-6, `${north2.latDeg.toFixed(5)}`)
const climbing = advance(plane({ tMs: 0, vrateMs: 10 }), 30_000)
check('climb rate is applied', Math.abs(climbing.altM - 10300) < 0.5)
const stale = advance(plane({ tMs: 0 }), 5_000_000)
check('very old reports are not carried on forever', Math.abs(stale.lonDeg - (250 * 900) / 111195) < 0.01, `${stale.lonDeg.toFixed(3)}`)
const wrap = advance(plane({ lonDeg: 179.99, tMs: 0 }), 60_000)
check('longitude wraps across the date line', Math.abs(wrap.lonDeg - -179.875) < 0.01, `${wrap.lonDeg.toFixed(3)}`)

// kinds and shapes from the backend's rows
const parsed = parseAircraft({
  fields: ['hex', 'callsign', 'lat', 'lon', 'alt_m', 'speed_ms', 'track', 'vrate_ms', 'type', 'reg', 't', 'kind', 'shape'],
  rows: [['abc123', 'BAW1', 1, 2, 10000, 200, 90, 0, 'B738', 'G-X', 100, 'heli', 'heli'], ['abc124', '', 1, 2, 10000, 200, 90, 0, '', '', 100, 'nonsense', 'nonsense']],
  fetched_at: 1,
  credit: ''
})
check('kind and shape are read from the rows', parsed[0].kind === 'heli' && parsed[0].shape === 'heli')
check('an unknown kind or shape falls back to unidentified', parsed[1].kind === 'unknown' && parsed[1].shape === 'unknown')
const old = parseAircraft({ fields: ['hex', 'callsign', 'lat', 'lon'], rows: [['a', '', 1, 2]], fetched_at: 1, credit: '' })
check('rows from before kinds existed still parse', old.length === 1 && old[0].kind === 'unknown')
check('every kind has a shape drawn', AIRCRAFT_KINDS.every((k) => SHAPE_PATHS[k.shape].length > 0) && SHAPE_ORDER.every((s) => SHAPE_PATHS[s].length > 0))
check('asKind accepts known kinds only', asKind('mil') === 'mil' && asKind('zzz') === 'unknown')

// the filter: aircraft overhead of the site, three kinds
const at = (kind: AircraftKind, dLon: number): Aircraft => plane({ kind, hex: kind, latDeg: 51.5, lonDeg: -0.1 + dLon, altM: 3000, speedMs: 0 })
const fleet = [at('jet', 0.01), at('heli', 0.02), at('prop', 0.03), at('heli', 0.04)]
const now = Date.now()
const frame = { latDeg: 51.5, lonDeg: -0.1, date: new Date(now) }
const all = buildPlaneFrame(fleet, now, site, frame)
check('with no filter every aircraft above the horizon is drawn', all.dots.length === 4 && all.counts.heli === 2 && all.counts.jet === 1)
const noHeli = buildPlaneFrame(fleet, now, site, frame, new Set<AircraftKind>(['heli']))
check('a hidden kind is not drawn but is still counted', noHeli.dots.length === 2 && noHeli.dots.every((d) => d.kind !== 'heli') && noHeli.counts.heli === 2)
check('countKinds counts the whole list', countKinds(fleet).heli === 2 && countKinds(fleet).prop === 1)

console.log(failed ? `${failed} FAILED` : 'all passed')
process.exit(failed ? 1 : 0)
