// Small wording helpers for the web traffic views (kept apart from lib/traffic.ts, which needs the app's API and React).

const FLAG_BASE = 0x1f1e6 - 65
/** The flag emoji for an ISO country code ('' when unknown). Windows draws them as letters, so callers keep the code beside it. */
export function flagOf(cc: string): string {
  return /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(FLAG_BASE + cc.charCodeAt(0), FLAG_BASE + cc.charCodeAt(1)) : ''
}

export function placeName(p: { city: string; country: string }): string {
  return p.city ? `${p.city}, ${p.country}` : p.country || 'Unknown place'
}

export function minutesWords(min: number): string {
  if (min < 1) return 'under a minute'
  if (min < 90) return `${Math.round(min)} min`
  const h = min / 60
  return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`
}

/** Program names as people know them: no ".exe". */
export const programName = (name: string): string => name.replace(/\.exe$/i, '')
