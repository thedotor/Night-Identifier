import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * What each page was showing, kept in localStorage so that changing page (or closing the app) and coming back finds everything where it was:
 * the selected item, the tab, the filters, the settings typed in, how far the page was scrolled.
 */
const PREFIX = 'page-state:'

export function readPageState<T>(page: string, key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`${PREFIX}${page}:${key}`)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}

export function writePageState(page: string, key: string, value: unknown): void {
  try {
    localStorage.setItem(`${PREFIX}${page}:${key}`, JSON.stringify(value))
  } catch {
    /* it just will not survive leaving the page */
  }
}

/**
 * `useState` that remembers itself. `check` gets what was saved and returns the value to use (or the initial one when it no longer makes
 * sense), so a page never starts from something that has since gone.
 */
export function usePageState<T>(page: string, key: string, initial: T, check?: (saved: unknown) => T | undefined): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    const saved = readPageState<unknown>(page, key, undefined)
    if (saved === undefined || saved === null) return initial
    if (!check) return saved as T
    const ok = check(saved)
    return ok === undefined ? initial : ok
  })
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    writePageState(page, key, value)
  }, [page, key, value])
  const set = useCallback((v: T | ((prev: T) => T)) => setValue(v), [])
  return [value, set]
}

// ---------- scroll ----------

/** Where in the page a scrolled box is: tags and positions from the container down (the pages have no ids to go by). */
function pathOf(el: Element, root: Element): string {
  const parts: string[] = []
  for (let n: Element | null = el; n && n !== root; n = n.parentElement) {
    const parent: Element | null = n.parentElement
    parts.push(`${n.tagName}${parent ? Array.prototype.indexOf.call(parent.children, n) : 0}`)
  }
  return parts.reverse().join('>')
}

function find(root: Element, path: string): Element | null {
  let n: Element | null = root
  for (const part of path.split('>')) {
    if (!n) return null
    const m = /^([A-Z0-9]+?)(\d+)$/.exec(part)
    if (!m) return null
    n = n.children[Number(m[2])] ?? null
    if (!n || n.tagName !== m[1]) return null
  }
  return n
}

const SCROLL_KEY = 'page-scroll:'
const RESTORE_FOR_MS = 4000

/**
 * Remembers how far each scrolled box inside `root` was scrolled, per page, and puts it back when the page is opened again. The content often
 * arrives after the page does (lists load), so it keeps trying for a few seconds, and gives up as soon as the user scrolls for themselves.
 */
export function useScrollMemory(root: RefObject<HTMLElement | null>, page: string): void {
  useEffect(() => {
    const box = root.current
    if (!box) return
    let saved: Record<string, number> = {}
    try {
      saved = JSON.parse(localStorage.getItem(SCROLL_KEY + page) ?? '{}') as Record<string, number>
    } catch {
      /* none */
    }
    const now: Record<string, number> = { ...saved }
    let userScrolled = false
    let programmatic = 0
    let timer = 0
    const onScroll = (e: Event): void => {
      const el = e.target as Element
      if (!(el instanceof Element) || !box.contains(el)) return
      if (performance.now() < programmatic) return // our own restoring, not the user
      userScrolled = true
      now[pathOf(el, box)] = (el as HTMLElement).scrollTop
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        try {
          localStorage.setItem(SCROLL_KEY + page, JSON.stringify(now))
        } catch {
          /* not remembered */
        }
      }, 250)
    }
    box.addEventListener('scroll', onScroll, true)
    const pending = new Map(Object.entries(saved).filter(([, top]) => top > 0))
    const started = performance.now()
    const tick = window.setInterval(() => {
      if (userScrolled || pending.size === 0 || performance.now() - started > RESTORE_FOR_MS) return window.clearInterval(tick)
      for (const [path, top] of pending) {
        const el = find(box, path) as HTMLElement | null
        if (!el || el.scrollHeight - el.clientHeight < top) continue // not long enough yet: the content is still arriving
        programmatic = performance.now() + 120
        el.scrollTop = top
        pending.delete(path)
      }
    }, 120)
    return () => {
      window.clearInterval(tick)
      window.clearTimeout(timer)
      box.removeEventListener('scroll', onScroll, true)
      // a scroll that had not been written yet
      if (userScrolled) {
        try {
          localStorage.setItem(SCROLL_KEY + page, JSON.stringify(now))
        } catch {
          /* not remembered */
        }
      }
    }
  }, [root, page])
}
