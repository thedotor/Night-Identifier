import type { ReactElement } from 'react'
import { nsKey } from '@renderer/lib/storeNs'
import { MenuHeading, MenuRow, MenuSub } from '@renderer/components/deepspace/panelChrome'

export interface FieldWindState {
  on: boolean
  lines: boolean
  map: boolean
  mapKind: 'strength' | 'declination'
  surfaces: boolean
  stations: boolean
  belts: boolean
  stream: boolean
  markers: boolean
  sheet: boolean
  sheetPanel: 'density' | 'velocity'
}

export const DEFAULT_FW: FieldWindState = { on: true, lines: true, map: false, mapKind: 'strength', surfaces: true, stations: true, belts: false, stream: true, markers: true, sheet: false, sheetPanel: 'velocity' }
const KEY = 'night-identifier:field-wind'

export function readFw(): FieldWindState {
  try {
    const raw = JSON.parse(localStorage.getItem(nsKey(KEY)) ?? 'null') as Partial<FieldWindState> | null
    return raw ? { ...DEFAULT_FW, ...raw } : DEFAULT_FW
  } catch {
    return DEFAULT_FW
  }
}

export function saveFw(s: FieldWindState): void {
  try {
    localStorage.setItem(nsKey(KEY), JSON.stringify(s))
  } catch {
    /* not remembered */
  }
}

const sel = 'rounded border border-border bg-bg px-1 py-0.5 text-text'

/** What to show of the Earth's field and the solar wind: the contents of the "Field & wind" toolbar menu. */
export function FieldWindOptions({ state, set, year }: { state: FieldWindState; set: (s: FieldWindState) => void; year: number }): ReactElement {
  const up = (patch: Partial<FieldWindState>): void => set({ ...state, ...patch })
  const inRange = year >= 2000 && year <= 2035
  const off = !state.on
  return (
    <>
      <MenuRow
        checked={state.on}
        onChange={(on) => up({ on })}
        title="The Earth's magnetic field (real IGRF-14 model for the scene's date, with live storm data), and the solar wind that shapes it (real measurements at L1 and NOAA's model)"
      >
        🧲 Field &amp; wind
      </MenuRow>
      <MenuSub>
        <MenuHeading>Magnetic field</MenuHeading>
        <MenuRow disabled={off} checked={state.lines} onChange={(lines) => up({ lines })} title="Field lines traced through the real IGRF-14 model, bent by the wind. Blue when calm, orange and shaking in a storm.">
          Field lines
        </MenuRow>
        <MenuRow
          disabled={off}
          checked={state.map}
          onChange={(map) => up({ map })}
          title="A colour map of the field on the ground, with contour lines"
          right={
            <select value={state.mapKind} disabled={off} onChange={(e) => up({ mapKind: e.target.value as FieldWindState['mapKind'] })} className={sel}>
              <option value="strength">Strength</option>
              <option value="declination">Compass declination</option>
            </select>
          }
        >
          Surface map
        </MenuRow>
        <MenuRow disabled={off} checked={state.surfaces} onChange={(surfaces) => up({ surfaces })} title="The magnetopause (the edge of the Earth's magnetic domain) and the bow shock in front of it, sized from the live wind">
          Magnetopause &amp; bow shock
        </MenuRow>
        <MenuRow disabled={off} checked={state.stations} onChange={(stations) => up({ stations })} title="13 real observatories (US territory only) coloured by how much their field moved in the last hour">
          Ground magnetometers (US)
        </MenuRow>
        <MenuRow disabled={off} checked={state.belts} onChange={(belts) => up({ belts })} title="The Van Allen radiation belts: a schematic shape (not a modelled one), tilted to the real dipole axis. The outer belt's brightness follows NOAA's live GOES electron flux, a standard proxy for how charged up it is.">
          Radiation belts
        </MenuRow>
        <MenuHeading>Solar wind</MenuHeading>
        <MenuRow disabled={off} checked={state.stream} onChange={(stream) => up({ stream })} title="Particles streaming from the Sun to the Earth at the speed and density measured at L1 (time sped up about 6,000 times)">
          Stream to Earth
        </MenuRow>
        <MenuRow disabled={off} checked={state.markers} onChange={(markers) => up({ markers })} title="CMEs, high-speed streams and shocks on their way, at the distance they would be now, with their arrival times">
          Arriving gusts, shocks and CMEs
        </MenuRow>
        <MenuRow
          disabled={off}
          checked={state.sheet}
          onChange={(sheet) => up({ sheet })}
          title="NOAA's WSA-Enlil model of the wind in the plane of the planets, out to 1.7 AU, hourly for about a week. A forecast model, a flat slice."
          right={
            <select value={state.sheetPanel} disabled={off} onChange={(e) => up({ sheetPanel: e.target.value as FieldWindState['sheetPanel'] })} className={sel}>
              <option value="velocity">Speed</option>
              <option value="density">Density</option>
            </select>
          }
        >
          Flow map (NOAA model)
        </MenuRow>
      </MenuSub>
      {!inRange && <div className="px-1 text-warning">The field model is only valid around 2020 to 2030: the lines fade out at this date.</div>}
      <div className="px-1 text-[10px]">Live data (wind, Dst, stations) means something only near the present; scrub the date and the field follows the model, the live parts fade.</div>
    </>
  )
}
