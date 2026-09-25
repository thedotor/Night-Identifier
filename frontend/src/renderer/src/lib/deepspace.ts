// Client side of /deepspace: object details are fetched once per object and remembered for the
// session (the backend caches to disk, so a repeat visit is instant even offline).

import { useEffect, useState } from 'react'
import { api, type DeepSpaceKind, type DeepSpaceObject } from './api'

const memo = new Map<string, Promise<DeepSpaceObject>>()

export function fetchObject(kind: DeepSpaceKind, key: string): Promise<DeepSpaceObject> {
  const id = `${kind}:${key}`
  let p = memo.get(id)
  if (!p) {
    p = api.get<DeepSpaceObject>(`/deepspace/object?kind=${kind}&key=${encodeURIComponent(key)}`).then((o) => {
      // An offline answer is incomplete; forget it so the next look retries the archives.
      if (o.offline) memo.delete(id)
      return o
    })
    p.catch(() => memo.delete(id))
    memo.set(id, p)
  }
  return p
}

export interface ObjectState {
  info: DeepSpaceObject | null
  loading: boolean
  error: boolean
}

export function useObjectInfo(kind: DeepSpaceKind | null, key: string | null): ObjectState {
  const [state, setState] = useState<ObjectState>({ info: null, loading: false, error: false })
  useEffect(() => {
    if (!kind || key === null) {
      setState({ info: null, loading: false, error: false })
      return
    }
    let live = true
    setState({ info: null, loading: true, error: false })
    fetchObject(kind, key)
      .then((info) => live && setState({ info, loading: false, error: false }))
      .catch(() => live && setState({ info: null, loading: false, error: true }))
    return () => {
      live = false
    }
  }, [kind, key])
  return state
}

export const fmtBytes = (n: number): string =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(0)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`
