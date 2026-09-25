// Shared class names and small helpers for the Live View components (theme tokens only, so the
// Dark, Light and Red themes all work).

export const btn =
  'whitespace-nowrap rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text-muted hover:border-accent hover:text-text disabled:opacity-50'
export const btnPrimary =
  'whitespace-nowrap rounded-md border border-accent bg-accent/20 px-2.5 py-1 text-xs font-medium text-text hover:bg-accent/30 disabled:opacity-50'
export const btnActive =
  'whitespace-nowrap rounded-md border border-accent bg-accent-muted px-2.5 py-1 text-xs font-medium text-text'
export const input =
  'w-full rounded-md border border-border bg-bg px-2 py-1 text-xs text-text placeholder:text-text-muted/60 focus:border-accent focus:outline-none'

export const STATE_LABEL: Record<string, string> = {
  stopped: 'Stopped',
  connecting: 'Connecting…',
  running: 'Live',
  lost: 'Connection lost, retrying…',
  error: 'Cannot connect',
  unavailable: 'Driver not installed'
}

export function stateDot(state: string | undefined): string {
  switch (state) {
    case 'running':
      return 'bg-success'
    case 'connecting':
      return 'bg-warning animate-pulse'
    case 'lost':
    case 'error':
    case 'unavailable':
      return 'bg-danger'
    default:
      return 'bg-text-muted/40'
  }
}
