// Fetches everything the 3D scene draws from the backend and hands it to the engine, one dataset
// at a time so the scene fills in as data arrives. Shared by the Deep Space page and the Sky
// Overlay's zoom-out, which run the same engine.

import { api } from '@renderer/lib/api'
import { loadCatalogue } from '@renderer/lib/skyCatalogue'
import type { DistancesData, HostsData, LocalGroupData, MoonElementsData, OrbitData, StarsData, SystemsData, TextureData } from '@renderer/lib/solarSystemData'
import type { SolarSystemEngine } from './solarSystemEngine'

export interface LoaderHooks {
  /** false once the caller has gone away, so late responses are dropped */
  live: () => boolean
  onCredit: (credit: string) => void
  /** a dataset could not be had (offline and not cached) */
  onMissing: (what: string) => void
  /** the set of bodies changed */
  onLoaded: () => void
}

export function loadUniverse(eng: SolarSystemEngine, h: LoaderHooks): void {
  const { live } = h
  const guard =
    <T,>(what: string, fn: (d: T) => void) =>
    (d: T & { offline?: boolean; credit?: string }): void => {
      if (!live()) return
      if (d.offline) return h.onMissing(what)
      fn(d)
      if (d.credit) h.onCredit(d.credit)
      h.onLoaded()
    }
  const fail = (what: string) => (): void => {
    if (live()) h.onMissing(what)
  }

  api
    .get<TextureData>('/deepspace/textures')
    .then((t) => {
      if (!live()) return
      eng.setTextures(t.urls)
      h.onCredit(t.credit)
    })
    .catch(() => undefined)
  api.get<OrbitData>('/deepspace/orbits').then(guard('dwarf planets, asteroids and comets', (d: OrbitData) => eng.setOrbits(d))).catch(fail('dwarf planets, asteroids and comets'))
  api.get<MoonElementsData>('/deepspace/moons').then(guard('real moon positions', (d: MoonElementsData) => eng.setMoonTables(d))).catch(fail('real moon positions'))
  api.get<StarsData>('/deepspace/stars3d').then(guard('3D stars', (d: StarsData) => eng.setNearStars(d))).catch(fail('3D stars'))
  api.get<SystemsData>('/deepspace/systems').then(guard('planetary systems', (d: SystemsData) => eng.setSystems(d))).catch(fail('planetary systems'))
  api.get<HostsData>('/deepspace/hosts').then(guard('planet hosts', (d: HostsData) => eng.setHosts(d))).catch(fail('planet hosts'))
  loadCatalogue()
    .then((cat) => {
      if (!live()) return
      eng.setStars(cat)
      return api.get<DistancesData>('/deepspace/distances').then(guard('nebula and galaxy distances', (d: DistancesData) => eng.setDeepSky(cat, d)))
    })
    .catch(fail('nebula and galaxy distances'))
  api.get<LocalGroupData>('/deepspace/localgroup').then(guard('Local Group galaxies', (d: LocalGroupData) => eng.setLocalGroup(d))).catch(fail('Local Group galaxies'))
}
