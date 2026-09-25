import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Stage, Layer, Image as KonvaImage, Rect, Ellipse, Line, Text } from 'react-konva'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import useImage from 'use-image'
import type { Detection, ObjectType } from '@renderer/lib/api'
import { colorForObjectType } from '@renderer/components/annotate/colors'

interface Props {
  previewUrl: string
  imageWidth: number
  imageHeight: number
  detections: Detection[]
  objectTypesById: Map<number, ObjectType>
  onClose: () => void
}

const MIN_SCALE = 0.02
const MAX_SCALE = 25

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
}

export function DetectionViewer({
  previewUrl,
  imageWidth,
  imageHeight,
  detections,
  objectTypesById,
  onClose
}: Props): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const [image] = useImage(previewUrl)
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [scale, setScale] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [hasFit, setHasFit] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (hasFit || stageSize.width === 0 || imageWidth === 0) return
    const fitScale = clampScale(
      Math.min((stageSize.width * 0.92) / imageWidth, (stageSize.height * 0.92) / imageHeight)
    )
    setScale(fitScale)
    setPos({
      x: (stageSize.width - imageWidth * fitScale) / 2,
      y: (stageSize.height - imageHeight * fitScale) / 2
    })
    setHasFit(true)
  }, [stageSize, imageWidth, imageHeight, hasFit])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleWheel = (e: KonvaEventObject<WheelEvent>): void => {
    e.evt.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    const pointer = stage.getPointerPosition()
    if (!pointer) return
    const oldScale = scale
    const mousePointTo = { x: (pointer.x - pos.x) / oldScale, y: (pointer.y - pos.y) / oldScale }
    const direction = e.evt.deltaY > 0 ? -1 : 1
    const scaleBy = 1.08
    const newScale = clampScale(direction > 0 ? oldScale * scaleBy : oldScale / scaleBy)
    setScale(newScale)
    setPos({ x: pointer.x - mousePointTo.x * newScale, y: pointer.y - mousePointTo.y * newScale })
  }

  return (
    <div
      className="fixed inset-x-0 bottom-0 top-9 z-50 flex flex-col bg-black/80"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex items-center justify-between px-4 py-2 text-sm text-white">
        <span>Scroll to zoom, drag to pan &middot; Esc to close</span>
        <button onClick={onClose} className="rounded px-2 py-1 text-lg hover:bg-white/10">
          &times;
        </button>
      </div>
      <div ref={containerRef} className="relative min-h-0 flex-1">
        <Stage
          ref={stageRef}
          width={stageSize.width}
          height={stageSize.height}
          scaleX={scale}
          scaleY={scale}
          x={pos.x}
          y={pos.y}
          draggable
          onWheel={handleWheel}
          onDragEnd={(e) => {
            if (e.target === stageRef.current) setPos({ x: e.target.x(), y: e.target.y() })
          }}
        >
          <Layer>
            {image && <KonvaImage image={image} x={0} y={0} width={imageWidth} height={imageHeight} />}
            {detections.map((d) => {
              const color = colorForObjectType(d.object_type_id)
              const label = objectTypesById.get(d.object_type_id)?.name ?? 'Unknown'
              const confPct = d.confidence != null ? `${Math.round(d.confidence * 100)}%` : ''
              if (d.shape_type === 'rect' && 'width' in d.geometry) {
                const g = d.geometry
                return (
                  <RectWithLabel
                    key={d.id}
                    x={g.x}
                    y={g.y}
                    width={g.width}
                    height={g.height}
                    color={color}
                    label={`${label} ${confPct}`}
                    scale={scale}
                  />
                )
              }
              if (d.shape_type === 'ellipse' && 'rx' in d.geometry) {
                const g = d.geometry
                return (
                  <Ellipse
                    key={d.id}
                    x={g.cx}
                    y={g.cy}
                    radiusX={g.rx}
                    radiusY={g.ry}
                    stroke={color}
                    strokeWidth={2 / scale}
                    listening={false}
                  />
                )
              }
              if (d.shape_type === 'polygon' && 'points' in d.geometry) {
                return (
                  <Line
                    key={d.id}
                    points={d.geometry.points}
                    closed
                    stroke={color}
                    strokeWidth={2 / scale}
                    listening={false}
                  />
                )
              }
              return null
            })}
          </Layer>
        </Stage>
      </div>
    </div>
  )
}

function RectWithLabel({
  x,
  y,
  width,
  height,
  color,
  label,
  scale
}: {
  x: number
  y: number
  width: number
  height: number
  color: string
  label: string
  scale: number
}): ReactElement {
  return (
    <>
      <Rect x={x} y={y} width={width} height={height} stroke={color} strokeWidth={2 / scale} listening={false} />
      <Text
        x={x}
        y={y - 16 / scale}
        text={label}
        fontSize={13 / scale}
        fill={color}
        listening={false}
      />
    </>
  )
}
