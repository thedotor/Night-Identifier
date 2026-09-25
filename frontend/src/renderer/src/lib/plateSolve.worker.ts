// Runs plateSolve off the UI thread: a blind solve can take a few seconds.
import { plateSolve, type SolveInput, type SolveOutput } from './plateSolve'

export type SolveRequest = SolveInput
export type SolveResponse = { ok: true; result: SolveOutput | null } | { ok: false; error: string }

self.onmessage = (e: MessageEvent<SolveRequest>): void => {
  try {
    const result = plateSolve(e.data)
    ;(self as unknown as Worker).postMessage({ ok: true, result } satisfies SolveResponse)
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ ok: false, error: String(err) } satisfies SolveResponse)
  }
}
