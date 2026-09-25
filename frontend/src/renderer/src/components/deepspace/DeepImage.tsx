import { useEffect, useState, type ReactElement } from 'react'

interface Props {
  src: string | null
  alt: string
  className?: string
  /** how the image sits in its box */
  fit?: 'cover' | 'contain'
  onLoad?: (e: React.SyntheticEvent<HTMLImageElement>) => void
}

/** An image that degrades to a quiet placeholder (no broken-image icon) when it can't be loaded,
 * e.g. an uncached picture with no internet connection. */
export function DeepImage({ src, alt, className = '', fit = 'cover', onLoad }: Props): ReactElement {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    setFailed(false)
    setLoaded(false)
  }, [src])

  if (!src || failed)
    return (
      <div className={`flex items-center justify-center bg-bg text-center text-[11px] text-text-muted ${className}`}>
        <span className="px-3">{src ? 'Image not available offline' : 'No image'}</span>
      </div>
    )
  return (
    <div className={`relative overflow-hidden bg-bg ${className}`}>
      {!loaded && <div className="absolute inset-0 animate-pulse bg-surface-raised" />}
      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(e) => {
          setLoaded(true)
          onLoad?.(e)
        }}
        onError={() => setFailed(true)}
        className={`h-full w-full transition-opacity duration-500 ${fit === 'cover' ? 'object-cover' : 'object-contain'} ${loaded ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  )
}
