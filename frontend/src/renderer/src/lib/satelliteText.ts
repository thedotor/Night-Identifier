/** "3 h ago" for an epoch-seconds timestamp. */
export function fmtAge(epochS: number): string {
  const s = Math.max(0, Date.now() / 1000 - epochS)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 2 * 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}
