import {
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import {
  api,
  Annotation,
  Geometry,
  ImageRecord,
  ObjectType,
  ScanEvent,
  ShapeType,
  previewUrl,
  wsUrl
} from '@renderer/lib/api'
import { initialImageId, rememberImage } from '@renderer/lib/lastImage'
import { useBlockedAreas } from '@renderer/lib/blockedAreas'
import { AnnotationCanvas, Tool } from '@renderer/components/annotate/AnnotationCanvas'
import { colorForObjectType } from '@renderer/components/annotate/colors'

import { usePageState } from '@renderer/lib/pageState'
const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'select', label: 'Select', hint: 'V' },
  { id: 'pan', label: 'Pan', hint: 'H' },
  { id: 'rect', label: 'Box', hint: 'R' },
  { id: 'ellipse', label: 'Circle', hint: 'C' },
  { id: 'polygon', label: 'Custom shape', hint: 'P' },
  { id: 'block', label: 'Block area', hint: 'B' }
]

const TYPES_HEIGHT_KEY = 'annotate-types-height'
const MIN_TYPES_HEIGHT = 120
const DEFAULT_TYPES_HEIGHT = 300
function readTypesHeight(): number {
  try {
    const v = Number(localStorage.getItem(TYPES_HEIGHT_KEY))
    return Number.isFinite(v) && v >= MIN_TYPES_HEIGHT ? v : DEFAULT_TYPES_HEIGHT
  } catch {
    return DEFAULT_TYPES_HEIGHT
  }
}

export function Annotate(): ReactElement {
  const [images, setImages] = useState<ImageRecord[]>([])
  const [selectedImageId, setSelectedImageId] = useState<number | null>(null)
  const [objectTypes, setObjectTypes] = useState<ObjectType[]>([])
  const [activeObjectTypeId, setActiveObjectTypeId] = usePageState<number | null>('annotate', 'type', null, (v) => (typeof v === 'number' ? v : undefined))
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [tool, setTool] = usePageState<Tool>('annotate', 'tool', 'select', (v) => (TOOLS.some((t) => t.id === v) ? (v as Tool) : undefined))
  const blocked = useBlockedAreas(selectedImageId)
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<number | null>(null)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{ processed: number; total: number } | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)
  const [quickAddName, setQuickAddName] = usePageState('annotate', 'quickAdd', '', (v) => (typeof v === 'string' ? v : undefined))
  const [typeFilter, setTypeFilter] = usePageState('annotate', 'typeFilter', '', (v) => (typeof v === 'string' ? v : undefined))
  const [typesHeight, setTypesHeight] = useState(readTypesHeight)
  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startY = e.clientY
    const startH = typesHeight
    const panel = e.currentTarget.parentElement
    const maxH = Math.max(MIN_TYPES_HEIGHT, (panel?.clientHeight ?? 700) - 120)
    let latest = startH
    const move = (ev: PointerEvent): void => {
      latest = Math.min(maxH, Math.max(MIN_TYPES_HEIGHT, startH + ev.clientY - startY))
      setTypesHeight(latest)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem(TYPES_HEIGHT_KEY, String(latest))
      } catch {
        /* size just won't persist */
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  useEffect(() => {
    api
      .get<ImageRecord[]>('/images?category=training')
      .then((imgs) => {
        setImages(imgs)
        setSelectedImageId(initialImageId(imgs))
      })
      .catch(() => setError('Could not load images from the backend.'))

    api
      .get<ObjectType[]>('/objects')
      .then((types) => {
        setObjectTypes(types)
        if (types.length > 0) setActiveObjectTypeId((cur) => (cur !== null && types.some((t) => t.id === cur) ? cur : types[0].id))
      })
      .catch(() => setError('Could not load object types from the backend.'))
  }, [])

  useEffect(() => {
    setSelectedAnnotationId(null)
    if (selectedImageId == null) {
      setAnnotations([])
      return
    }
    api
      .get<Annotation[]>(`/images/${selectedImageId}/annotations`)
      .then(setAnnotations)
      .catch(() => setError('Could not load annotations for this image.'))
  }, [selectedImageId])

  useEffect(() => {
    const ws = new WebSocket(wsUrl('/images/ws'))
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as ScanEvent
      if (event.type === 'import_start') {
        setImportProgress({ processed: 0, total: event.total })
      } else if (event.type === 'import_progress') {
        setImportProgress({ processed: event.processed, total: event.total })
      }
    }
    return () => ws.close()
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedAnnotationId != null) {
        handleDeleteAnnotation(selectedAnnotationId)
      }
      const shortcut = TOOLS.find((t) => t.hint.toLowerCase() === e.key.toLowerCase())
      if (shortcut) setTool(shortcut.id)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAnnotationId])

  const selectedImage = useMemo(
    () => images.find((i) => i.id === selectedImageId) ?? null,
    [images, selectedImageId]
  )

  const handleAddImages = async (): Promise<void> => {
    const paths = await window.api.selectFiles()
    if (!paths || paths.length === 0) return
    setImporting(true)
    setImportProgress({ processed: 0, total: paths.length })
    setError(null)
    try {
      const result = await api.post<{ imported: ImageRecord[]; skipped: string[] }>(
        '/images/import',
        { paths, category: 'training' }
      )
      setImages((prev) => [...result.imported, ...prev])
      if (result.imported.length > 0) {
        setSelectedImageId(result.imported[0].id)
        rememberImage(result.imported[0].id)
      }
      if (result.skipped.length > 0) {
        setError(`${result.skipped.length} file(s) could not be imported (unsupported format).`)
      }
    } catch {
      setError('Import failed.')
    } finally {
      setImporting(false)
      setImportProgress(null)
    }
  }

  const handleCreateShape = async (shapeType: ShapeType, geometry: Geometry): Promise<void> => {
    if (selectedImageId == null || activeObjectTypeId == null) return
    try {
      const created = await api.post<Annotation>(`/images/${selectedImageId}/annotations`, {
        object_type_id: activeObjectTypeId,
        shape_type: shapeType,
        geometry
      })
      setAnnotations((prev) => [...prev, created])
      setSelectedAnnotationId(created.id)
    } catch {
      setError('Failed to save the shape.')
    }
  }

  const handleUpdateGeometry = async (id: number, geometry: Geometry): Promise<void> => {
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, geometry } : a)))
    try {
      await api.put(`/annotations/${id}`, { geometry })
    } catch {
      setError('Failed to save changes.')
    }
  }

  const handleDeleteAnnotation = async (id: number): Promise<void> => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id))
    setSelectedAnnotationId((cur) => (cur === id ? null : cur))
    try {
      await api.delete(`/annotations/${id}`)
    } catch {
      setError('Failed to delete the shape.')
    }
  }

  const handleDeleteImage = async (id: number, e: ReactMouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!window.confirm('Delete this image and its annotations from the training pool?')) return
    const prevImages = images
    setImages((cur) => cur.filter((i) => i.id !== id))
    if (selectedImageId === id) {
      const remaining = images.filter((i) => i.id !== id)
      setSelectedImageId(remaining.length > 0 ? remaining[0].id : null)
    }
    try {
      await api.delete(`/images/${id}`)
    } catch {
      setImages(prevImages)
      setError('Failed to delete the image.')
    }
  }

  const handleReassign = async (id: number, objectTypeId: number): Promise<void> => {
    setAnnotations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, object_type_id: objectTypeId } : a))
    )
    try {
      await api.put(`/annotations/${id}`, { object_type_id: objectTypeId })
    } catch {
      setError('Failed to reassign object type.')
    }
  }

  const handleQuickAddType = async (): Promise<void> => {
    const name = quickAddName.trim()
    if (!name) return
    try {
      const created = await api.post<ObjectType>('/objects', { name, description: '' })
      setObjectTypes((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
      setActiveObjectTypeId(created.id)
      setQuickAddName('')
    } catch {
      setError('Failed to add object type (name may already exist).')
    }
  }

  return (
    <div className="flex h-full">
      {/* Image list */}
      <div className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
        <div className="border-b border-border p-3">
          <button
            onClick={handleAddImages}
            disabled={importing}
            className="w-full rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-50"
          >
            {importing ? 'Importing...' : '+ Add images'}
          </button>
          {importing && importProgress && importProgress.total > 0 && (
            <div className="mt-2">
              <div className="mb-1 flex justify-between text-[11px] text-text-muted">
                <span>
                  {importProgress.processed} / {importProgress.total}
                </span>
                <span>{Math.round((importProgress.processed / importProgress.total) * 100)}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-bg">
                <div
                  className="h-full bg-accent transition-all"
                  style={{
                    width: `${(importProgress.processed / importProgress.total) * 100}%`
                  }}
                />
              </div>
            </div>
          )}
          <p className="mt-2 text-[11px] leading-snug text-text-muted">
            This is a separate training pool, not your general library &mdash; images added here
            are for labeling only and won&apos;t appear in Upload &amp; Watch Folder or Results
            Gallery.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {images.length === 0 && (
            <div className="mt-4 px-2 text-center text-xs text-text-muted">
              No images yet. Add some to start labeling.
            </div>
          )}
          {images.map((img) => (
            <div key={img.id} className="group relative mb-2">
              <button
                onClick={() => {
                  setSelectedImageId(img.id)
                  rememberImage(img.id)
                }}
                className={`block w-full overflow-hidden rounded-md border text-left ${
                  img.id === selectedImageId ? 'border-accent' : 'border-border hover:border-accent/50'
                }`}
              >
                <img
                  src={previewUrl(img.id)}
                  alt={img.filename}
                  className="h-24 w-full object-cover"
                />
                <div className="truncate px-2 py-1 text-xs text-text-muted">{img.filename}</div>
              </button>
              <button
                onClick={(e) => handleDeleteImage(img.id, e)}
                title="Delete image"
                className="absolute right-1 top-1 hidden rounded-md bg-danger/90 px-1.5 py-0.5 text-xs text-white group-hover:block"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Canvas */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-border bg-surface px-3 py-2">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTool(t.id)}
              title={`${t.label} (${t.hint})`}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                tool === t.id
                  ? 'bg-accent-muted text-text'
                  : 'text-text-muted hover:bg-surface-raised hover:text-text'
              }`}
            >
              {t.label}
            </button>
          ))}
          {tool === 'block' && (
            <span className="ml-3 text-xs text-text-muted">
              Drag around lights, trees or anything the detectors should ignore · click a red area to remove it
            </span>
          )}
          {blocked.regions.length > 0 && (
            <button
              onClick={() => window.confirm(`Remove all ${blocked.regions.length} blocked areas on this image?`) && blocked.clear()}
              title="Blocked areas are skipped by every detector"
              className="ml-auto rounded-md border border-danger/50 px-2 py-1 text-xs text-danger hover:bg-danger/10"
            >
              Clear {blocked.regions.length} blocked
            </button>
          )}
          {tool === 'polygon' && (
            <span className="ml-3 text-xs text-text-muted">
              Click to add points, Enter to finish, Esc to cancel
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1">
          {selectedImage ? (
            <AnnotationCanvas
              key={selectedImage.id}
              previewUrl={previewUrl(selectedImage.id)}
              imageWidth={selectedImage.width}
              imageHeight={selectedImage.height}
              annotations={annotations}
              tool={tool}
              activeObjectTypeId={activeObjectTypeId}
              selectedAnnotationId={selectedAnnotationId}
              onSelectAnnotation={setSelectedAnnotationId}
              onCreateShape={handleCreateShape}
              onUpdateGeometry={handleUpdateGeometry}
              blockedRegions={blocked.regions}
              onAddBlockedRegion={blocked.add}
              onRemoveBlockedRegion={blocked.remove}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-text-muted">
              Select or add an image to begin annotating
            </div>
          )}
        </div>

        {error && (
          <div className="border-t border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger">
            {error}
          </div>
        )}
      </div>

      {/* Object types + annotation list */}
      <div className="flex w-64 shrink-0 flex-col border-l border-border bg-surface">
        <div className="flex shrink-0 flex-col p-3" style={{ height: typesHeight }}>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Active object type
          </div>
          {objectTypes.length > 8 && (
            <input
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              placeholder={`Filter ${objectTypes.length} types…`}
              className="mb-2 w-full rounded-md border border-border bg-bg px-2 py-1 text-xs text-text outline-none focus:border-accent"
            />
          )}
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {objectTypes
              .filter((ot) => ot.id === activeObjectTypeId || ot.name.toLowerCase().includes(typeFilter.trim().toLowerCase()))
              .map((ot) => (
              <button
                key={ot.id}
                onClick={() => setActiveObjectTypeId(ot.id)}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                  activeObjectTypeId === ot.id
                    ? 'bg-accent-muted text-text'
                    : 'text-text-muted hover:bg-surface-raised hover:text-text'
                }`}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: colorForObjectType(ot.id) }}
                />
                <span className="truncate">{ot.name}</span>
              </button>
            ))}
          </div>
          <div className="mt-2 flex gap-1">
            <input
              value={quickAddName}
              onChange={(e) => setQuickAddName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleQuickAddType()}
              placeholder="New type name"
              className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-xs text-text outline-none focus:border-accent"
            />
            <button
              onClick={handleQuickAddType}
              className="rounded-md border border-border px-2 py-1 text-xs text-text-muted hover:border-accent hover:text-text"
            >
              Add
            </button>
          </div>
        </div>

        <div
          onPointerDown={startResize}
          title="Drag to resize"
          className="group flex h-2 shrink-0 cursor-row-resize items-center border-y border-border bg-surface-raised hover:bg-accent-muted"
        >
          <div className="mx-auto h-0.5 w-10 rounded-full bg-text-muted group-hover:bg-text" />
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Shapes on this image ({annotations.length})
          </div>
          {annotations.map((a) => {
            return (
              <div
                key={a.id}
                onClick={() => setSelectedAnnotationId(a.id)}
                className={`mb-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs ${
                  selectedAnnotationId === a.id ? 'bg-accent-muted' : 'hover:bg-surface-raised'
                }`}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: colorForObjectType(a.object_type_id) }}
                />
                <select
                  value={a.object_type_id}
                  onChange={(e) => handleReassign(a.id, Number(e.target.value))}
                  onClick={(e) => e.stopPropagation()}
                  className="min-w-0 flex-1 truncate bg-transparent text-text outline-none"
                >
                  {objectTypes.map((ot) => (
                    <option key={ot.id} value={ot.id} className="bg-surface text-text">
                      {ot.name}
                    </option>
                  ))}
                </select>
                <span className="text-text-muted">{a.shape_type}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDeleteAnnotation(a.id)
                  }}
                  className="text-danger hover:opacity-80"
                >
                  &times;
                </button>
              </div>
            )
          })}
          {annotations.length === 0 && (
            <div className="text-xs text-text-muted">No shapes yet. Pick a tool and draw on the image.</div>
          )}
        </div>
      </div>
    </div>
  )
}
