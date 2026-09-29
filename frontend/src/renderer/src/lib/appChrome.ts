import { useSyncExternalStore } from 'react'

// Whether the app's own frame (the title bar and the sidebar) is hidden, as when Live View fills the screen with one camera.
let hidden = false
const listeners = new Set<() => void>()

export function setChromeHidden(v: boolean): void {
  if (hidden === v) return
  hidden = v
  listeners.forEach((l) => l())
}

export function useChromeHidden(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => hidden
  )
}
