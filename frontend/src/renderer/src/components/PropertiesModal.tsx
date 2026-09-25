import { useEffect, type ReactElement } from 'react'
import type { ImageProperties } from '@renderer/lib/api'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

export function PropertiesModal({
  properties,
  onClose
}: {
  properties: ImageProperties
  onClose: () => void
}): ReactElement {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const rows: [string, string][] = [
    ['Filename', properties.filename],
    ['Dimensions', `${properties.width} × ${properties.height}`],
    ['File size', formatBytes(properties.file_size_bytes)],
    ['Status', properties.status],
    ['Imported', new Date(properties.created_at).toLocaleString()],
    ['Stored at', properties.stored_path]
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[420px] rounded-lg border border-border bg-surface p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text">Properties</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text">
            &times;
          </button>
        </div>
        <dl className="flex flex-col gap-2 text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="flex gap-3">
              <dt className="w-24 shrink-0 text-text-muted">{label}</dt>
              <dd className="min-w-0 flex-1 break-words text-text">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
