import type { ReactElement } from 'react'

interface PagePlaceholderProps {
  title: string
  description: string
}

export function PagePlaceholder({ title, description }: PagePlaceholderProps): ReactElement {
  return (
    <div className="flex h-full flex-col p-8">
      <h1 className="text-xl font-semibold text-text">{title}</h1>
      <p className="mt-2 max-w-2xl text-sm text-text-muted">{description}</p>
      <div className="mt-6 flex flex-1 items-center justify-center rounded-lg border border-dashed border-border text-sm text-text-muted">
        Coming soon
      </div>
    </div>
  )
}
