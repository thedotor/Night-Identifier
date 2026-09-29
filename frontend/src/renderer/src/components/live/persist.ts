import { useCallback, useEffect, useRef, useState } from 'react'

export function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* preferences just will not persist */
  }
}

/**
 * State kept in localStorage: it survives changing page and closing the app. `merge` fills in fields an older saved copy does not have,
 * and is where anything read back gets checked.
 */
export function usePersisted<T>(key: string, initial: T, merge?: (saved: unknown) => T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    const saved = readJson<unknown>(key, undefined)
    if (saved === undefined || saved === null) return initial
    return merge ? merge(saved) : (saved as T)
  })
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    writeJson(key, value)
  }, [key, value])
  const set = useCallback((v: T | ((prev: T) => T)) => setValue(v), [])
  return [value, set]
}
