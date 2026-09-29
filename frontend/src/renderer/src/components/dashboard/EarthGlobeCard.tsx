import { useState, type ReactElement } from 'react'
import { SolarSystemView } from '@renderer/components/deepspace/SolarSystemView'

/**
 * The live Earth and the solar system around it, for the dashboard and the monitoring window: the Deep Space view itself, so every switch it has
 * (clouds, wind, currents, planes, ships, lightning, aurora, the live Sun and its CMEs and sunspots, the magnetic field and solar wind, the planets'
 * orbits and names, satellites…) and every info box (the Sun now, the field and wind now, aurora, lightning) is here, each one switched on and off in
 * its menus. It starts on the Earth: scroll out to see the planets, or use the scale bar under the picture.
 */
export function EarthGlobeCard(): ReactElement {
  const [start] = useState(() => Date.now())
  return (
    <div className="h-full min-h-[36rem] overflow-hidden rounded-lg border border-border bg-black">
      <SolarSystemView startMs={start} fromPhoto={false} focus="earth" compact />
    </div>
  )
}
