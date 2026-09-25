import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { Detection, ImageRecord } from '@renderer/lib/api'
import { previewUrl } from '@renderer/lib/api'
import { colorForObjectType } from '@renderer/components/annotate/colors'

function boxRect(detection: Detection, imageWidth: number, imageHeight: number): {
  left: string
  top: string
  width: string
  height: string
} | null {
  const g = detection.geometry
  let x: number, y: number, w: number, h: number
  if ('width' in g && 'x' in g) {
    ;({ x, y, width: w, height: h } = g)
  } else if ('rx' in g) {
    x = g.cx - g.rx
    y = g.cy - g.ry
    w = g.rx * 2
    h = g.ry * 2
  } else {
    const xs = g.points.filter((_, i) => i % 2 === 0)
    const ys = g.points.filter((_, i) => i % 2 === 1)
    x = Math.min(...xs)
    y = Math.min(...ys)
    w = Math.max(...xs) - x
    h = Math.max(...ys) - y
  }
  return {
    left: `${(x / imageWidth) * 100}%`,
    top: `${(y / imageHeight) * 100}%`,
    width: `${(w / imageWidth) * 100}%`,
    height: `${(h / imageHeight) * 100}%`
  }
}

export function DetectionOverlayThumb({
  image,
  detections,
  onClick,
  onContextMenu
}: {
  image: ImageRecord
  detections: Detection[]
  onClick?: () => void
  onContextMenu?: (e: ReactMouseEvent) => void
}): ReactElement {
  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      className="relative cursor-pointer overflow-hidden rounded-md border border-border bg-surface"
    >
      <img src={previewUrl(image.id)} alt={image.filename} className="aspect-square w-full object-cover" />
      <div className="absolute inset-0">
        {detections.map((d) => {
          const rect = boxRect(d, image.width, image.height)
          if (!rect) return null
          return (
            <div
              key={d.id}
              style={{ ...rect, borderColor: colorForObjectType(d.object_type_id) }}
              className="absolute border-2"
            />
          )
        })}
      </div>
      <div className="truncate px-2 py-1 text-[10px] text-text-muted">{image.filename}</div>
      {detections.length > 0 && (
        <div className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
          {detections.length}
        </div>
      )}
    </div>
  )
}
