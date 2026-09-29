import { useState, type ReactElement } from 'react'
import { SolarSystemView } from '@renderer/components/deepspace/SolarSystemView'

/** Just the Earth, filling the page: the Deep Space view with all its menus and switches, minus the stars and galaxies. */
export function EarthPage(): ReactElement {
  const [start] = useState(() => Date.now())
  return <SolarSystemView startMs={start} fromPhoto={false} focus="earth" earthOnly />
}
