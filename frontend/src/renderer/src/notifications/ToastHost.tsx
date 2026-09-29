import type { ReactElement } from 'react'
import { goToRoute, useNotifications } from './NotificationContext'

const POSITION_CLASS = {
  'top-right': 'top-12 right-4 items-end',
  'top-left': 'top-12 left-4 items-start',
  'bottom-right': 'bottom-4 right-4 items-end',
  'bottom-left': 'bottom-4 left-4 items-start'
} as const

const LEVEL_BAR = {
  info: 'bg-accent',
  success: 'bg-success',
  error: 'bg-danger'
} as const

export function ToastHost(): ReactElement {
  const { toasts, dismiss, settings } = useNotifications()

  return (
    <div
      className={`pointer-events-none fixed z-50 flex flex-col gap-2 ${POSITION_CLASS[settings.position]}`}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex w-80 overflow-hidden rounded-lg border border-border bg-surface-raised shadow-lg"
        >
          <div className={`w-1 shrink-0 ${LEVEL_BAR[t.level]}`} />
          <div
            className={`min-w-0 flex-1 px-3 py-2 ${t.route ? 'cursor-pointer hover:bg-surface' : ''}`}
            title={t.route ? 'Click to open' : undefined}
            onClick={
              t.route
                ? (): void => {
                    goToRoute(t.route!)
                    dismiss(t.id)
                  }
                : undefined
            }
          >
            <div className="text-sm font-medium text-text">{t.title}</div>
            <div className="mt-0.5 break-words text-xs text-text-muted">{t.body}</div>
            {t.route && <div className="mt-1 text-[10px] text-accent">Click to open</div>}
          </div>
          <button
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
            className="px-2 text-text-muted hover:text-text"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  )
}
