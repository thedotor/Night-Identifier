import { useEffect, type ReactElement } from 'react'

export function ImagePreviewModal({
  src,
  alt,
  onClose
}: {
  src: string
  alt: string
  onClose: () => void
}): ReactElement {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      className="fixed inset-x-0 bottom-0 top-9 z-50 flex flex-col items-center justify-center bg-black/80 p-8"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <button
        onClick={onClose}
        className="absolute right-4 top-4 rounded px-2 py-1 text-lg text-white hover:bg-white/10"
      >
        &times;
      </button>
      <img src={src} alt={alt} className="max-h-full max-w-full rounded-md object-contain shadow-xl" />
      <div className="mt-3 text-xs text-white/70">{alt}</div>
    </div>
  )
}
