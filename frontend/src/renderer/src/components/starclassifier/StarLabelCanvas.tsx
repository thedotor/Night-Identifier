import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Stage, Layer, Image as KonvaImage, Circle } from 'react-konva'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import useImage from 'use-image'
import type { StarCandidate, StarLabelRecord, StarLabelType } from '@renderer/lib/api'

interface Props {
  previewUrl: string
  imageWidth: number
  imageHeight: number
  candidates: StarCandidate[]
  labels: StarLabelRecord[]
  onCycleLabel: (candidate: StarCandidate) => void
}

const MIN_SCALE = 0.02
const MAX_SCALE = 25
const MATCH_RADIUS_PX = 6 // image-space distance under which a click is "on" an existing label

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
}

function colorFor(label: StarLabelType | null): string {
  if (label === 'star') return '#4ade80'
  if (label === 'not_star') return '#f87171'
  return 'rgba(255,255,255,0.5)'
}

export function StarLabelCanvas({
  previewUrl,
  imageWidth,
  imageHeight,
  candidates,
  labels,
  onCycleLabel
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

  useEffect(() => setHasFit(false), [previewUrl])

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

  const labelFor = (x: number, y: number): StarLabelType | null => {
    const hit = labels.find((l) => Math.hypot(l.x - x, l.y - y) < MATCH_RADIUS_PX)
    return hit?.label ?? null
  }

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-[#04050a]">
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
          {candidates.map((c, i) => {
            const label = labelFor(c.x, c.y)
            return (
              <Circle
                key={i}
                x={c.x}
                y={c.y}
                radius={6 / scale}
                stroke={colorFor(label)}
                strokeWidth={2 / scale}
                fill={label ? `${colorFor(label)}55` : 'transparent'}
                onClick={(e) => {
                  e.cancelBubble = true
                  onCycleLabel(c)
                }}
                onMouseEnter={(e) => {
                  const container = e.target.getStage()?.container()
                  if (container) container.style.cursor = 'pointer'
                }}
                onMouseLeave={(e) => {
                  const container = e.target.getStage()?.container()
                  if (container) container.style.cursor = 'default'
                }}
              />
            )
          })}
        </Layer>
      </Stage>
    </div>
  )
}
