import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'

/** A button in the Solar System toolbar that opens a small menu of related switches. */
export function ToolbarMenu({
  label,
  count,
  open,
  onToggle,
  onClose,
  align = 'left',
  width = 'w-72',
  title,
  children
}: {
  label: ReactNode
  /** how many of the menu's switches are on; nothing is shown for 0 */
  count?: number
  open: boolean
  onToggle: () => void
  onClose: () => void
  align?: 'left' | 'right'
  width?: string
  title?: string
  children: ReactNode
}): ReactElement {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) close.current()
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close.current()
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  return (
    <div ref={box} className="relative">
      <button
        onClick={onToggle}
        aria-expanded={open}
        title={title}
        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${open ? 'border-accent bg-accent/20 text-text' : 'border-border bg-surface/90 text-text-muted hover:border-accent hover:text-text'}`}
      >
        {label}
        {count ? <span className="rounded-full bg-accent/30 px-1.5 text-[10px] tabular-nums text-text">{count}</span> : null}
        <span className="text-[10px]">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className={`absolute top-full z-30 mt-1 max-h-[70vh] space-y-1 overflow-y-auto rounded-md border border-border bg-surface p-2.5 text-xs text-text-muted shadow-lg ${width} ${align === 'right' ? 'right-0' : 'left-0'}`}>{children}</div>
      )}
    </div>
  )
}

/** A switch inside a toolbar menu. Live status goes on its own line underneath. */
export function MenuRow({
  checked,
  onChange,
  title,
  disabled,
  status,
  statusTone = 'muted',
  right,
  children
}: {
  checked: boolean
  onChange: (on: boolean) => void
  title?: string
  disabled?: boolean
  status?: ReactNode
  statusTone?: 'muted' | 'warn' | 'bad'
  right?: ReactNode
  children: ReactNode
}): ReactElement {
  return (
    <label className={`flex items-start gap-2 rounded px-1 py-0.5 hover:bg-accent/10 hover:text-text ${disabled ? 'cursor-default opacity-50' : 'cursor-pointer'}`} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-accent" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {children}
          {right && <span className="ml-auto">{right}</span>}
        </span>
        {status ? <span className={`block text-[11px] ${statusTone === 'bad' ? 'text-danger' : statusTone === 'warn' ? 'text-warning' : 'text-text-muted'}`}>{status}</span> : null}
      </span>
    </label>
  )
}

/** Extra controls that belong to the switch above them, shown while it is on. */
export function MenuSub({ children }: { children: ReactNode }): ReactElement {
  return <div className="ml-6 space-y-1 border-l border-border pl-2.5">{children}</div>
}

export function MenuHeading({ children }: { children: ReactNode }): ReactElement {
  return <div className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-wide">{children}</div>
}

/** The title line of a folding info box: click it to fold the box down to just this line. */
export function PanelHeader({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }): ReactElement {
  return (
    <button onClick={onToggle} aria-expanded={open} title={open ? 'Fold this box' : 'Unfold this box'} className="flex w-full items-start gap-1.5 text-left hover:text-text">
      <span className="mt-px w-2.5 shrink-0 text-[10px]">{open ? '▾' : '▸'}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  )
}
