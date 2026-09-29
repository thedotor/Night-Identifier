// Global ionospheric TEC (CODE, via the backend): types and reading the byte grid. Pure functions, no DOM.

export interface IonosphereGridPayload {
  width: number
  height: number
  /** base64 of width x height bytes: TECU x tecu_scale, row 0 = latitude -87.5, column 0 = longitude 0 (east) */
  data: string
  tecu_scale: number
  day: string
  hour: number
  credit: string
}

export interface IonosphereGrid {
  width: number
  height: number
  data: Uint8Array
  tecuScale: number
  day: string
  hour: number
  credit: string
}

export function parseIonosphereGrid(p: IonosphereGridPayload): IonosphereGrid {
  const bin = atob(p.data)
  const data = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)
  return { width: p.width, height: p.height, data, tecuScale: p.tecu_scale, day: p.day, hour: p.hour, credit: p.credit }
}
