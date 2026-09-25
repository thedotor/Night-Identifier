import type { CSSProperties, ReactElement } from 'react'

export function TitleBar(): ReactElement {
  return (
    <div
      className="flex h-9 shrink-0 items-center justify-center border-b border-border bg-surface text-xs text-text-muted"
      style={{ WebkitAppRegion: 'drag' } as CSSProperties}
    >
      Night Sky Object Identifier
    </div>
  )
}
