import { readPageState, writePageState } from '@renderer/lib/pageState'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Stage, Layer, Image as KonvaImage, Rect, Ellipse, Line, Circle, Transformer } from 'react-konva'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import useImage from 'use-image'
import type {
  Annotation,
  EllipseGeometry,
  Geometry,
  PolygonGeometry,
  RectGeometry,
  ShapeType
} from '@renderer/lib/api'
import { colorForObjectType } from './colors'
import type { Region } from '@renderer/lib/blockedAreas'

export type Tool = 'select' | 'pan' | 'rect' | 'ellipse' | 'polygon' | 'block'

interface Props {
  previewUrl: string
  imageWidth: number
  imageHeight: number
  annotations: Annotation[]
  tool: Tool
  activeObjectTypeId: number | null
  selectedAnnotationId: number | null
  onSelectAnnotation: (id: number | null) => void
  onCreateShape: (shapeType: ShapeType, geometry: Geometry) => void
  onUpdateGeometry: (id: number, geometry: Geometry) => void
  /** areas fenced off from detection, drawn red; the Block tool adds/removes them */
  blockedRegions: Region[]
  onAddBlockedRegion: (region: Region) => void
  onRemoveBlockedRegion: (index: number) => void
}

const MIN_SCALE = 0.02
const MAX_SCALE = 25
const MIN_LASSO_POINTS = 3
const LASSO_SPACING_SCREEN_PX = 4
const MIN_DRAFT_SIZE = 4 // in image-pixel space; smaller drags are treated as accidental clicks
// Screen-space (not image-space) stroke width: dividing by `scale` keeps it
// this many pixels wide on screen at any zoom level. Kept thin so it doesn't
// visually swamp small objects when zoomed out to view the whole image.
const STROKE_SCREEN_PX = 1.25

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
}

function isRect(g: Geometry): g is RectGeometry {
  return 'width' in g && 'x' in g
}
function isEllipse(g: Geometry): g is EllipseGeometry {
  return 'rx' in g
}
function isPolygon(g: Geometry): g is PolygonGeometry {
  return 'points' in g
}

export function AnnotationCanvas({
  previewUrl,
  imageWidth,
  imageHeight,
  annotations,
  tool,
  activeObjectTypeId,
  selectedAnnotationId,
  onSelectAnnotation,
  onCreateShape,
  onUpdateGeometry,
  blockedRegions,
  onAddBlockedRegion,
  onRemoveBlockedRegion
}: Props): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const transformerRef = useRef<Konva.Transformer>(null)
  const shapeNodeRefs = useRef<Map<number, Konva.Node>>(new Map())

  const [image] = useImage(previewUrl)
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [scale, setScale] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [hasFit, setHasFit] = useState(false)

  const [draftRect, setDraftRect] = useState<RectGeometry | null>(null)
  const [draftPolygon, setDraftPolygon] = useState<number[] | null>(null)
  const [polygonCursor, setPolygonCursor] = useState<{ x: number; y: number } | null>(null)
  const drawStart = useRef<{ x: number; y: number } | null>(null)
  const [lasso, setLasso] = useState<Region | null>(null)
  const lassoScreenLast = useRef<{ x: number; y: number } | null>(null)

  // Track container size
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

  // Fit image to view once we know both the container size and image dimensions
  useEffect(() => {
    if (hasFit || stageSize.width === 0 || imageWidth === 0) return
    // the zoom and pan this image had when it was last open
    const saved = readPageState<{ scale: number; x: number; y: number } | null>('annotate', `view:${previewUrl}`, null)
    if (saved && [saved.scale, saved.x, saved.y].every(Number.isFinite) && saved.scale > 0) {
      setScale(clampScale(saved.scale))
      setPos({ x: saved.x, y: saved.y })
      setHasFit(true)
      return
    }
    const fitScale = Math.min(
      (stageSize.width * 0.92) / imageWidth,
      (stageSize.height * 0.92) / imageHeight
    )
    const s = clampScale(fitScale)
    setScale(s)
    setPos({
      x: (stageSize.width - imageWidth * s) / 2,
      y: (stageSize.height - imageHeight * s) / 2
    })
    setHasFit(true)
  }, [stageSize, imageWidth, imageHeight, hasFit, previewUrl])

  // remember the view for next time
  useEffect(() => {
    if (!hasFit) return
    const t = window.setTimeout(() => writePageState('annotate', `view:${previewUrl}`, { scale, x: pos.x, y: pos.y }), 300)
    return () => window.clearTimeout(t)
  }, [hasFit, scale, pos, previewUrl])

  // Reset fit state when switching images
  useEffect(() => {
    setHasFit(false)
    setDraftRect(null)
    setDraftPolygon(null)
    setLasso(null)
    drawStart.current = null
  }, [previewUrl])

  // Bind transformer to the selected rect/ellipse node
  useEffect(() => {
    const tr = transformerRef.current
    if (!tr) return
    if (selectedAnnotationId == null || tool !== 'select') {
      tr.nodes([])
      tr.getLayer()?.batchDraw()
      return
    }
    const node = shapeNodeRefs.current.get(selectedAnnotationId)
    const selected = annotations.find((a) => a.id === selectedAnnotationId)
    if (node && selected && selected.shape_type !== 'polygon') {
      tr.nodes([node])
    } else {
      tr.nodes([])
    }
    tr.getLayer()?.batchDraw()
  }, [selectedAnnotationId, tool, annotations])

  const toLocal = (stage: Konva.Stage): { x: number; y: number } | null => {
    const p = stage.getPointerPosition()
    if (!p) return null
    return { x: (p.x - pos.x) / scale, y: (p.y - pos.y) / scale }
  }

  const handleWheel = (e: KonvaEventObject<WheelEvent>): void => {
    e.evt.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    const pointer = stage.getPointerPosition()
    if (!pointer) return

    const oldScale = scale
    const mousePointTo = {
      x: (pointer.x - pos.x) / oldScale,
      y: (pointer.y - pos.y) / oldScale
    }
    const direction = e.evt.deltaY > 0 ? -1 : 1
    const scaleBy = 1.08
    const newScale = clampScale(direction > 0 ? oldScale * scaleBy : oldScale / scaleBy)

    setScale(newScale)
    setPos({
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale
    })
  }

  const handleStageMouseDown = (e: KonvaEventObject<MouseEvent>): void => {
    const stage = stageRef.current
    if (!stage) return
    const clickedOnEmpty = e.target === stage || e.target.name() === 'bg-image'

    if (tool === 'select') {
      if (clickedOnEmpty) onSelectAnnotation(null)
      return
    }

    const local = toLocal(stage)
    if (!local) return

    if (tool === 'block') {
      setLasso([[local.x, local.y]])
      lassoScreenLast.current = stage.getPointerPosition()
      return
    }

    if (tool === 'rect' || tool === 'ellipse') {
      drawStart.current = local
      setDraftRect({ x: local.x, y: local.y, width: 0, height: 0 })
      return
    }

    if (tool === 'polygon') {
      setDraftPolygon((prev) => (prev ? [...prev, local.x, local.y] : [local.x, local.y]))
    }
  }

  const handleStageMouseMove = (): void => {
    const stage = stageRef.current
    if (!stage) return
    const local = toLocal(stage)
    if (!local) return

    if (tool === 'block' && lasso) {
      // Keep a point only once the pointer has moved a few screen pixels: a raw mousemove stream
      // would pile up hundreds of near-duplicates per stroke.
      const p = stage.getPointerPosition()
      const last = lassoScreenLast.current
      if (p && (!last || Math.hypot(p.x - last.x, p.y - last.y) >= LASSO_SPACING_SCREEN_PX)) {
        setLasso([...lasso, [local.x, local.y]])
        lassoScreenLast.current = p
      }
    } else if ((tool === 'rect' || tool === 'ellipse') && drawStart.current) {
      const start = drawStart.current
      setDraftRect({
        x: Math.min(start.x, local.x),
        y: Math.min(start.y, local.y),
        width: Math.abs(local.x - start.x),
        height: Math.abs(local.y - start.y)
      })
    } else if (tool === 'polygon' && draftPolygon) {
      setPolygonCursor(local)
    }
  }

  const finishRectDraw = (): void => {
    if (draftRect && draftRect.width >= MIN_DRAFT_SIZE && draftRect.height >= MIN_DRAFT_SIZE) {
      if (tool === 'rect') {
        onCreateShape('rect', draftRect)
      } else if (tool === 'ellipse') {
        const geometry: EllipseGeometry = {
          cx: draftRect.x + draftRect.width / 2,
          cy: draftRect.y + draftRect.height / 2,
          rx: draftRect.width / 2,
          ry: draftRect.height / 2
        }
        onCreateShape('ellipse', geometry)
      }
    }
    setDraftRect(null)
    drawStart.current = null
  }

  const handleStageMouseUp = (): void => {
    if (tool === 'block' && lasso) {
      if (lasso.length >= MIN_LASSO_POINTS) onAddBlockedRegion(lasso)
      setLasso(null)
      lassoScreenLast.current = null
      return
    }
    if (tool === 'rect' || tool === 'ellipse') finishRectDraw()
  }

  const finishPolygon = (): void => {
    if (draftPolygon && draftPolygon.length >= 6) {
      onCreateShape('polygon', { points: draftPolygon })
    }
    setDraftPolygon(null)
    setPolygonCursor(null)
  }

  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent): void => {
      if (tool === 'polygon' && draftPolygon) {
        if (e.key === 'Enter') finishPolygon()
        if (e.key === 'Escape') {
          setDraftPolygon(null)
          setPolygonCursor(null)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, draftPolygon])

  const rectAnnotations = useMemo(
    () => annotations.filter((a): a is Annotation & { geometry: RectGeometry } => a.shape_type === 'rect'),
    [annotations]
  )
  const ellipseAnnotations = useMemo(
    () =>
      annotations.filter((a): a is Annotation & { geometry: EllipseGeometry } => a.shape_type === 'ellipse'),
    [annotations]
  )
  const polygonAnnotations = useMemo(
    () =>
      annotations.filter((a): a is Annotation & { geometry: PolygonGeometry } => a.shape_type === 'polygon'),
    [annotations]
  )

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
        draggable={tool === 'select' || tool === 'pan'}
        onWheel={handleWheel}
        onMouseDown={handleStageMouseDown}
        onMouseMove={handleStageMouseMove}
        onMouseUp={handleStageMouseUp}
        onDblClick={() => tool === 'polygon' && finishPolygon()}
        onDragEnd={(e) => {
          if (e.target === stageRef.current) setPos({ x: e.target.x(), y: e.target.y() })
        }}
        style={{ cursor: tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair' }}
      >
        <Layer>
          {image && (
            <KonvaImage
              name="bg-image"
              image={image}
              x={0}
              y={0}
              width={imageWidth}
              height={imageHeight}
              listening={tool !== 'select'}
            />
          )}

          {rectAnnotations.map((a) => (
            <Rect
              key={a.id}
              ref={(node) => {
                if (node) shapeNodeRefs.current.set(a.id, node)
                else shapeNodeRefs.current.delete(a.id)
              }}
              x={a.geometry.x}
              y={a.geometry.y}
              width={a.geometry.width}
              height={a.geometry.height}
              stroke={colorForObjectType(a.object_type_id)}
              strokeWidth={STROKE_SCREEN_PX / scale}
              draggable={tool === 'select'}
              onClick={() => tool === 'select' && onSelectAnnotation(a.id)}
              onTap={() => tool === 'select' && onSelectAnnotation(a.id)}
              onDragEnd={(e) =>
                onUpdateGeometry(a.id, { ...a.geometry, x: e.target.x(), y: e.target.y() })
              }
              onTransformEnd={(e) => {
                const node = e.target as Konva.Rect
                const sx = node.scaleX()
                const sy = node.scaleY()
                node.scaleX(1)
                node.scaleY(1)
                onUpdateGeometry(a.id, {
                  x: node.x(),
                  y: node.y(),
                  width: Math.max(MIN_DRAFT_SIZE, node.width() * sx),
                  height: Math.max(MIN_DRAFT_SIZE, node.height() * sy)
                })
              }}
            />
          ))}

          {ellipseAnnotations.map((a) => (
            <Ellipse
              key={a.id}
              ref={(node) => {
                if (node) shapeNodeRefs.current.set(a.id, node)
                else shapeNodeRefs.current.delete(a.id)
              }}
              x={a.geometry.cx}
              y={a.geometry.cy}
              radiusX={a.geometry.rx}
              radiusY={a.geometry.ry}
              stroke={colorForObjectType(a.object_type_id)}
              strokeWidth={STROKE_SCREEN_PX / scale}
              draggable={tool === 'select'}
              onClick={() => tool === 'select' && onSelectAnnotation(a.id)}
              onTap={() => tool === 'select' && onSelectAnnotation(a.id)}
              onDragEnd={(e) =>
                onUpdateGeometry(a.id, { ...a.geometry, cx: e.target.x(), cy: e.target.y() })
              }
              onTransformEnd={(e) => {
                const node = e.target as Konva.Ellipse
                const sx = node.scaleX()
                const sy = node.scaleY()
                node.scaleX(1)
                node.scaleY(1)
                onUpdateGeometry(a.id, {
                  cx: node.x(),
                  cy: node.y(),
                  rx: Math.max(MIN_DRAFT_SIZE / 2, node.radiusX() * sx),
                  ry: Math.max(MIN_DRAFT_SIZE / 2, node.radiusY() * sy)
                })
              }}
            />
          ))}

          {polygonAnnotations.map((a) => {
            const isSelected = tool === 'select' && selectedAnnotationId === a.id
            return (
              <PolygonShape
                key={a.id}
                annotation={a}
                scale={scale}
                selected={isSelected}
                selectable={tool === 'select'}
                onSelect={() => onSelectAnnotation(a.id)}
                onChange={(points) => onUpdateGeometry(a.id, { points })}
              />
            )
          })}

          {draftRect && (
            <Rect
              x={draftRect.x}
              y={draftRect.y}
              width={draftRect.width}
              height={draftRect.height}
              stroke={activeObjectTypeId ? colorForObjectType(activeObjectTypeId) : '#ffffff'}
              dash={[6 / scale, 4 / scale]}
              strokeWidth={STROKE_SCREEN_PX / scale}
              listening={false}
            />
          )}

          {draftPolygon && (
            <Line
              points={polygonCursor ? [...draftPolygon, polygonCursor.x, polygonCursor.y] : draftPolygon}
              stroke={activeObjectTypeId ? colorForObjectType(activeObjectTypeId) : '#ffffff'}
              strokeWidth={STROKE_SCREEN_PX / scale}
              dash={[6 / scale, 4 / scale]}
              listening={false}
            />
          )}

          {blockedRegions.map((region, i) => (
            <Line
              key={`blocked-${i}`}
              points={region.flat()}
              closed
              fill="rgba(239, 68, 68, 0.22)"
              stroke="#ef4444"
              strokeWidth={STROKE_SCREEN_PX / scale}
              dash={[6 / scale, 4 / scale]}
              listening={tool === 'block'}
              onMouseDown={(e) => {
                e.cancelBubble = true // a click removes it; don't start a new outline
              }}
              onClick={() => onRemoveBlockedRegion(i)}
              onTap={() => onRemoveBlockedRegion(i)}
            />
          ))}

          {lasso && (
            <Line
              points={lasso.flat()}
              closed={lasso.length >= MIN_LASSO_POINTS}
              fill="rgba(239, 68, 68, 0.15)"
              stroke="#ef4444"
              strokeWidth={STROKE_SCREEN_PX / scale}
              listening={false}
            />
          )}

          {tool === 'select' && <Transformer ref={transformerRef} rotateEnabled={false} />}
        </Layer>
      </Stage>
    </div>
  )
}

function PolygonShape({
  annotation,
  scale,
  selected,
  selectable,
  onSelect,
  onChange
}: {
  annotation: Annotation & { geometry: PolygonGeometry }
  scale: number
  selected: boolean
  selectable: boolean
  onSelect: () => void
  onChange: (points: number[]) => void
}): ReactElement {
  const [points, setPoints] = useState(annotation.geometry.points)

  useEffect(() => setPoints(annotation.geometry.points), [annotation.geometry.points])

  return (
    <>
      <Line
        points={points}
        closed
        stroke={colorForObjectType(annotation.object_type_id)}
        strokeWidth={STROKE_SCREEN_PX / scale}
        draggable={selectable}
        onClick={() => selectable && onSelect()}
        onTap={() => selectable && onSelect()}
        onDragEnd={(e) => {
          const dx = e.target.x()
          const dy = e.target.y()
          e.target.position({ x: 0, y: 0 })
          const next = points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy))
          setPoints(next)
          onChange(next)
        }}
      />
      {selected &&
        Array.from({ length: points.length / 2 }).map((_, i) => (
          <Circle
            key={i}
            x={points[i * 2]}
            y={points[i * 2 + 1]}
            radius={5 / scale}
            fill={colorForObjectType(annotation.object_type_id)}
            draggable
            onDragMove={(e) => {
              const next = [...points]
              next[i * 2] = e.target.x()
              next[i * 2 + 1] = e.target.y()
              setPoints(next)
            }}
            onDragEnd={() => onChange(points)}
          />
        ))}
    </>
  )
}
