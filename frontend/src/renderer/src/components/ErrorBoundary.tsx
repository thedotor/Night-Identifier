import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** Without this, one exception while a page renders unmounts the whole app and leaves a blank window. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Page crashed:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="text-base font-semibold text-text">This page hit a problem</h2>
        <p className="max-w-xl break-words text-sm text-text-muted">{error.message}</p>
        <div className="flex gap-2">
          <button
            onClick={() => this.setState({ error: null })}
            className="rounded-md border border-accent bg-accent/20 px-3 py-1.5 text-xs font-medium text-text hover:bg-accent/30"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:border-accent hover:text-text"
          >
            Reload the app
          </button>
        </div>
      </div>
    )
  }
}
