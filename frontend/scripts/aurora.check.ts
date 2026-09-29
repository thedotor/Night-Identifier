// Checks for lib/aurora.ts. Run: node --import ./scripts/ts-resolve.mjs scripts/aurora.check.ts
import { chanceAt, chanceVerdict, gScale, kpMeaning, ovalReach, parseGrid, windMeaning, type AuroraGridPayload } from '../src/renderer/src/lib/aurora'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
  if (!ok) failed++
}

// a synthetic grid: an oval of 40% at latitudes 65..70 north and south, 90% at longitude 100 for one cell
const W = 360
const H = 181
const bytes = new Uint8Array(W * H)
for (let lon = 0; lon < W; lon++)
  for (const lat of [65, 66, 67, 68, 69, 70, -65, -66, -67, -68, -69, -70]) bytes[(lat + 90) * W + lon] = 40
bytes[(80 + 90) * W + 100] = 90
let bin = ''
for (const b of bytes) bin += String.fromCharCode(b)
const payload: AuroraGridPayload = { width: W, height: H, data: btoa(bin), observation_time: '2026-09-25T19:28:00Z', forecast_time: '2026-09-25T20:23:00Z', max: 90, fetched_at: 1_800_000_000, credit: 'x' }
const g = parseGrid(payload)

check('grid round-trips through base64', g.data.length === W * H && g.data[(67 + 90) * W + 5] === 40 && g.validMs === Date.parse('2026-09-25T20:23:00Z'))
check('chance at a grid point', chanceAt(g, 67, 5) === 40 && chanceAt(g, 80, 100) === 90 && chanceAt(g, 0, 0) === 0)
check('chance is smooth between cells (halfway up the edge of the oval)', Math.abs(chanceAt(g, 64.5, 5) - 20) < 0.01 && Math.abs(chanceAt(g, 65, 5.5) - 40) < 0.01, chanceAt(g, 64.5, 5).toFixed(2))
check('longitudes wrap: -0.5 east is between column 359 and 0', chanceAt(g, 67, -0.5) === 40 && chanceAt(g, 67, 359.75) === 40)
check('the oval reaches 65 degrees in both hemispheres', ovalReach(g, 'north') === 65 && ovalReach(g, 'south') === 65)
check('no oval above a high threshold means null', ovalReach(g, 'south', 95) === null)

check('Kp to NOAA storm scale', gScale(4.67) === null && gScale(5) === 'G1' && gScale(6.33) === 'G2' && gScale(7) === 'G3' && gScale(9) === 'G5')
check('Kp meaning', kpMeaning(2).tone === 'quiet' && kpMeaning(4).tone === 'good' && kpMeaning(6).tone === 'great')
check('solar wind: Bz -12 is very favourable, +3 is closed, no reading is handled', windMeaning(-12, 400).tone === 'great' && windMeaning(3, 600).tone === 'quiet' && windMeaning(null, 400).text.includes('No magnetic'))
const dark = chanceVerdict(35, -30, 60)
check('verdict: 35% and dark says look north', dark.text.includes('north') && dark.text.includes('Good chance') && dark.tone === 'good', dark.text)
check('verdict: daylight says wait', chanceVerdict(35, 20, 60).text.includes('not dark enough'))
check('verdict: southern hemisphere looks south', chanceVerdict(45, -30, -43).text.includes('south'))
check('verdict: tropics', chanceVerdict(0, -30, 10).text.includes('Too far'))

console.log(failed ? `${failed} FAILED` : 'all passed')
process.exit(failed ? 1 : 0)
