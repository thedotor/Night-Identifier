import { useState, type ReactElement } from 'react'
import { SolarSystemView } from '@renderer/components/deepspace/SolarSystemView'

/**
 * Just the Earth, for the dashboard and the monitoring window: the Deep Space view with the same menus and switches (Earth, Weather, Hazards, Sun, Field & wind,
 * Traffic, Panels, and the planets' orbits and names), but without the stars, galaxies and Find list. The other globe card has the whole universe around it.
 */
export function EarthOnlyCard(): ReactElement {
  const [start] = useState(() => Date.now())
  return (
    <div className="h-full min-h-[36rem] overflow-hidden rounded-lg border border-border bg-black">
      <SolarSystemView startMs={start} fromPhoto={false} focus="earth" compact earthOnly />
    </div>
  )
}
