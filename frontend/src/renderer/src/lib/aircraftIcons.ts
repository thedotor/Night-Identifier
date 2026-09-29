// What kinds of aircraft there are, the colour of each, and the icons that draw them. Shared by the sky overlay in Live View (2D canvas),
// the 3D Earth (one texture with every icon in it) and the filter lists (SVG), so all three show the same pictures.
//
// The backend decides which kind and which shape an aircraft is (backend/app/services/aircraft.py, classify()). A military helicopter is
// kind "mil" (one chip, one colour) but shape "heli" (drawn as a helicopter).

export type AircraftKind = 'jet' | 'biz' | 'prop' | 'heli' | 'mil' | 'cargo' | 'drone' | 'unknown'
export type AircraftShape = 'jet' | 'biz' | 'prop' | 'heli' | 'fighter' | 'drone' | 'unknown'

export interface KindInfo {
  kind: AircraftKind
  label: string
  colour: string
  /** the icon shown next to the label in the filter */
  shape: AircraftShape
  hint: string
}

/** In the order the filter lists them. */
export const AIRCRAFT_KINDS: readonly KindInfo[] = [
  { kind: 'jet', label: 'Airliners', colour: '#7dd3fc', shape: 'jet', hint: 'Passenger jets, narrowbody to jumbo' },
  { kind: 'biz', label: 'Business jets', colour: '#c4b5fd', shape: 'biz', hint: 'Business and light jets: Learjet, Citation, Gulfstream…' },
  { kind: 'prop', label: 'Small planes', colour: '#86efac', shape: 'prop', hint: 'Piston and turboprop planes: Cessna, Piper, King Air, ATR…' },
  { kind: 'heli', label: 'Helicopters', colour: '#fdba74', shape: 'heli', hint: 'Helicopters, gyrocopters and tiltrotors' },
  { kind: 'mil', label: 'Military', colour: '#f87171', shape: 'fighter', hint: 'Aircraft flagged as military in the aircraft database (drawn by what they are: fighter, helicopter, transport)' },
  { kind: 'cargo', label: 'Cargo', colour: '#fcd34d', shape: 'jet', hint: 'Freight jets, found from the airline in the callsign (FedEx, UPS, DHL…) and freighter types' },
  { kind: 'drone', label: 'Gliders, balloons, drones', colour: '#f0abfc', shape: 'drone', hint: 'Gliders, balloons, parachutists and drones' },
  { kind: 'unknown', label: 'Unidentified', colour: '#cbd5e1', shape: 'unknown', hint: 'Aircraft whose type is not known' }
]

const KIND_BY_ID = new Map(AIRCRAFT_KINDS.map((k) => [k.kind, k]))
export const kindInfo = (k: string): KindInfo => KIND_BY_ID.get(k as AircraftKind) ?? KIND_BY_ID.get('unknown')!
export const asKind = (v: unknown): AircraftKind => (KIND_BY_ID.has(v as AircraftKind) ? (v as AircraftKind) : 'unknown')

/** The order the shapes have in the 3D texture. */
export const SHAPE_ORDER: readonly AircraftShape[] = ['jet', 'biz', 'prop', 'heli', 'fighter', 'drone', 'unknown']
export const asShape = (v: unknown): AircraftShape => (SHAPE_ORDER.includes(v as AircraftShape) ? (v as AircraftShape) : 'unknown')

/** Icons on a 64 x 64 grid centred on 0,0, nose up (negative y), as SVG path data. Every path of a shape is filled; together they are one picture. */
export const SHAPE_PATHS: Record<AircraftShape, readonly string[]> = {
  // airliner: swept wings, tailplane
  jet: ['M0 -28 L2.6 -20 L3 -8 L26 8 L26 13 L3 6 L2.5 17 L10 24 L10 28 L0 25 L-10 28 L-10 24 L-2.5 17 L-3 6 L-26 13 L-26 8 L-3 -8 L-2.6 -20 Z'],
  // business jet: a smaller, slimmer jet with its engines on the tail
  biz: [
    'M0 -27 L2 -19 L2.4 -6 L21 10 L21 14 L2.4 7 L2 19 L8 25 L8 28 L0 26 L-8 28 L-8 25 L-2 19 L-2.4 7 L-21 14 L-21 10 L-2.4 -6 L-2 -19 Z',
    'M3.2 8 L6.4 8 L6.4 20 L3.2 20 Z',
    'M-3.2 8 L-6.4 8 L-6.4 20 L-3.2 20 Z'
  ],
  // small plane: straight wide wings and a propeller
  prop: ['M0 -25 L2.6 -21 L3 -5 L28 -5 L28 3 L3 5 L2.5 19 L12 21 L12 26 L0 25 L-12 26 L-12 21 L-2.5 19 L-3 5 L-28 3 L-28 -5 L-3 -5 L-2.6 -21 Z', 'M-10 -29 L10 -29 L10 -26.5 L-10 -26.5 Z'],
  // helicopter: a rounded body, a tail boom with its rotor, and one long main-rotor blade across the top
  heli: [
    'M0 -19 C9 -19 10 -6 8 4 L2.2 8 L1.8 25 L7 27 L7 31 L-7 31 L-7 27 L-1.8 25 L-2.2 8 L-8 4 C-10 -6 -9 -19 0 -19 Z',
    'M-29 -13 L-27 -18 L29 13 L27 18 Z'
  ],
  // fighter: a pointed delta
  fighter: ['M0 -30 L3 -14 L25 13 L25 19 L4 14 L3 22 L9 28 L9 30 L0 28 L-9 30 L-9 28 L-3 22 L-4 14 L-25 19 L-25 13 L-3 -14 Z'],
  // glider / balloon / drone: a quadcopter's cross and rotors
  drone: [
    'M-20 -17 L-17 -20 L20 17 L17 20 Z',
    'M17 -20 L20 -17 L-17 20 L-20 17 Z',
    'M-23.5 -18.5 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0 Z',
    'M13.5 -18.5 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0 Z',
    'M-23.5 18.5 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0 Z',
    'M13.5 18.5 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0 Z',
    'M-5 -5 L5 -5 L5 5 L-5 5 Z'
  ],
  // unidentified: a plain arrow
  unknown: ['M0 -22 L14 20 L0 11 L-14 20 Z']
}

const path2d = new Map<AircraftShape, Path2D[]>()
/** The shape's paths for a canvas (made once). */
export function shapePath2D(shape: AircraftShape): Path2D[] {
  let p = path2d.get(shape)
  if (!p) {
    p = SHAPE_PATHS[shape].map((d) => new Path2D(d))
    path2d.set(shape, p)
  }
  return p
}

/** Paint a shape at (x, y), `size` px across, its nose pointing `headingRad` clockwise from up on the canvas. */
export function drawShape(ctx: CanvasRenderingContext2D, shape: AircraftShape, x: number, y: number, size: number, headingRad: number, fill: string): void {
  const s = size / 64
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(headingRad)
  ctx.scale(s, s)
  ctx.lineJoin = 'round'
  ctx.lineWidth = 4
  ctx.strokeStyle = 'rgba(0,0,0,0.75)'
  ctx.fillStyle = fill
  const paths = shapePath2D(shape)
  for (const p of paths) ctx.stroke(p)
  for (const p of paths) ctx.fill(p)
  ctx.restore()
}
