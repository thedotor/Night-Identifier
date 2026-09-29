// Checks for the text helpers in lib/trafficText.ts. Run: node --import ./scripts/ts-resolve.mjs scripts/traffic.check.ts
import { flagOf, minutesWords, placeName, programName } from '../src/renderer/src/lib/trafficText'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
  if (!ok) failed++
}

check('flag for GB is the two regional indicators', flagOf('GB') === '\u{1F1EC}\u{1F1E7}', flagOf('GB'))
check('no flag for a bad code', flagOf('') === '' && flagOf('usa') === '' && flagOf('u1') === '')
check('place name with a city', placeName({ city: 'Helsinki', country: 'Finland' }) === 'Helsinki, Finland')
check('place name without a city', placeName({ city: '', country: 'Finland' }) === 'Finland' && placeName({ city: '', country: '' }) === 'Unknown place')
check('program names lose .exe', programName('claude.exe') === 'claude' && programName('Code.EXE') === 'Code' && programName('python') === 'python')
check('minutes in words', minutesWords(0.4) === 'under a minute' && minutesWords(12) === '12 min' && minutesWords(180) === '3.0 h' && minutesWords(4320) === '3.0 days', `${minutesWords(180)} ${minutesWords(4320)}`)

if (failed) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
