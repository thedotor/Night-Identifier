// A soft thunder cue, made from noise (no sound files): a short crack followed by a low rumble that dies away.
// Nearer strikes are louder and crack sooner. Browsers only allow sound after the user has interacted with the
// page once; until then playing simply does nothing.

let ctx: AudioContext | null = null
let noise: AudioBuffer | null = null
let lastPlayed = 0

function context(): AudioContext | null {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx.state === 'closed' ? null : ctx
  } catch {
    return null
  }
}

/** Brown noise (each sample a small step from the last): the low, rolling texture thunder has. */
function brownNoise(c: AudioContext): AudioBuffer {
  if (noise) return noise
  const len = c.sampleRate * 6
  const buf = c.createBuffer(1, len, c.sampleRate)
  const d = buf.getChannelData(0)
  let last = 0
  for (let i = 0; i < len; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02
    d[i] = last * 3.5
  }
  noise = buf
  return buf
}

/** Play one rumble for a strike `km` away (louder when nearer). At most one every 4 seconds, so a burst of strikes is one storm, not a machine gun. */
export function playThunder(km: number, maxKm = 50): boolean {
  const now = performance.now()
  if (now - lastPlayed < 4000) return false
  const c = context()
  if (!c) return false
  lastPlayed = now
  const near = Math.max(0, Math.min(1, 1 - km / maxKm)) // 1 right here, 0 at the edge of range
  const level = 0.06 + 0.24 * near * near
  const t0 = c.currentTime + 0.05 + (1 - near) * 0.9 // farther: the sound arrives later
  const src = c.createBufferSource()
  src.buffer = brownNoise(c)
  src.loop = true
  const low = c.createBiquadFilter()
  low.type = 'lowpass'
  low.frequency.setValueAtTime(900 - 500 * (1 - near), t0)
  low.frequency.exponentialRampToValueAtTime(120, t0 + 3.2)
  const gain = c.createGain()
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.exponentialRampToValueAtTime(level, t0 + 0.06) // the crack
  gain.gain.exponentialRampToValueAtTime(level * 0.45, t0 + 0.6)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.6) // the rumble dying away
  src.connect(low).connect(gain).connect(c.destination)
  src.start(t0, Math.random() * 2)
  src.stop(t0 + 3.8)
  return true
}
