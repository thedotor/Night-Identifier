import {
  useEffect,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import { api, ApiError, ObjectType, referenceImageUrl } from '@renderer/lib/api'
import { ContextMenu, ContextMenuItem } from '@renderer/components/ContextMenu'
import { ImagePreviewModal } from '@renderer/components/ImagePreviewModal'

export function ObjectLibrary(): ReactElement {
  const [objects, setObjects] = useState<ObjectType[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [imgVersion, setImgVersion] = useState<Record<number, number>>({})
  const [editingDescriptionId, setEditingDescriptionId] = useState<number | null>(null)
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [previewObject, setPreviewObject] = useState<ObjectType | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; objectId: number } | null>(
    null
  )

  const load = (): void => {
    setLoading(true)
    api
      .get<ObjectType[]>('/objects')
      .then(setObjects)
      .catch(() => setError('Could not load object types from the backend.'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const handleCreate = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const created = await api.post<ObjectType>('/objects', {
        name: name.trim(),
        description: description.trim()
      })
      setObjects((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
      setName('')
      setDescription('')
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? 'That name is already in use.' : 'Failed to create object type.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleSetReferenceImage = async (id: number): Promise<void> => {
    const paths = await window.api.selectFiles()
    if (!paths || paths.length === 0) return
    setError(null)
    try {
      const updated = await api.put<ObjectType>(`/objects/${id}/reference-image`, { path: paths[0] })
      setObjects((prev) => prev.map((o) => (o.id === id ? updated : o)))
      setImgVersion((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }))
    } catch {
      setError('Failed to set reference image.')
    }
  }

  const handleImageClick = (obj: ObjectType): void => {
    if (obj.reference_image_path) {
      setPreviewObject(obj)
    } else {
      handleSetReferenceImage(obj.id)
    }
  }

  const openContextMenu = (e: ReactMouseEvent, objectId: number): void => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, objectId })
  }

  const buildContextItems = (obj: ObjectType): ContextMenuItem[] => {
    const items: ContextMenuItem[] = []
    if (obj.reference_image_path) {
      items.push(
        { label: 'Open image', onClick: () => window.api.openPath(obj.reference_image_path!) },
        {
          label: 'Open file location',
          onClick: () => window.api.showItemInFolder(obj.reference_image_path!)
        }
      )
    }
    items.push({
      label: obj.reference_image_path ? 'Change reference image' : 'Set reference image',
      onClick: () => handleSetReferenceImage(obj.id)
    })
    return items
  }

  const startEditingDescription = (obj: ObjectType): void => {
    setEditingDescriptionId(obj.id)
    setDescriptionDraft(obj.description)
  }

  const saveDescription = async (id: number): Promise<void> => {
    const trimmed = descriptionDraft.trim()
    setEditingDescriptionId(null)
    const prev = objects
    setObjects((cur) => cur.map((o) => (o.id === id ? { ...o, description: trimmed } : o)))
    try {
      await api.put(`/objects/${id}`, { description: trimmed })
    } catch {
      setObjects(prev)
      setError('Failed to save description.')
    }
  }

  const handleDelete = async (id: number): Promise<void> => {
    const prev = objects
    setObjects((cur) => cur.filter((o) => o.id !== id))
    try {
      await api.delete(`/objects/${id}`)
    } catch {
      setObjects(prev)
      setError('Failed to delete object type.')
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-8">
      <h1 className="text-xl font-semibold text-text">Object Library</h1>
      <p className="mt-2 max-w-2xl text-sm text-text-muted">
        Manage the list of trainable object types. New types are available immediately in the
        Annotate workspace.
      </p>

      <form onSubmit={handleCreate} className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4">
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Orion Nebula"
            className="w-56 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-text-muted">
          Description
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
            className="rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-bg disabled:opacity-50"
        >
          Add object type
        </button>
      </form>

      {error && (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
        {loading && <div className="text-sm text-text-muted">Loading...</div>}
        {!loading && objects.length === 0 && (
          <div className="col-span-full rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-muted">
            No object types yet. Add one above to start labeling.
          </div>
        )}
        {objects.map((obj) => (
          <div key={obj.id} className="group relative rounded-lg border border-border bg-surface p-4">
            <button
              onClick={() => handleImageClick(obj)}
              onContextMenu={(e) => openContextMenu(e, obj.id)}
              className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-md border border-dashed border-border text-xs text-text-muted hover:border-accent"
              title={obj.reference_image_path ? 'Click to preview' : 'Click to set a reference image'}
            >
              {obj.reference_image_path ? (
                <img
                  src={`${referenceImageUrl(obj.id)}${imgVersion[obj.id] ? `?v=${imgVersion[obj.id]}` : ''}`}
                  alt={obj.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                'Click to set reference image'
              )}
            </button>
            <div className="mt-3 text-sm font-medium text-text">{obj.name}</div>
            {editingDescriptionId === obj.id ? (
              <input
                autoFocus
                value={descriptionDraft}
                onChange={(e) => setDescriptionDraft(e.target.value)}
                onBlur={() => saveDescription(obj.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') setEditingDescriptionId(null)
                }}
                placeholder="Add a description"
                className="mt-1 w-full rounded border border-accent bg-bg px-1.5 py-0.5 text-xs text-text outline-none"
              />
            ) : (
              <button
                onClick={() => startEditingDescription(obj)}
                className="mt-1 block w-full text-left text-xs text-text-muted hover:text-text"
              >
                {obj.description || (
                  <span className="italic text-text-muted/70">+ Add description</span>
                )}
              </button>
            )}
            <button
              onClick={() => handleDelete(obj.id)}
              className="absolute right-2 top-2 hidden rounded-md bg-danger/90 px-2 py-1 text-xs text-white group-hover:block"
            >
              Delete
            </button>
          </div>
        ))}
      </div>

      {previewObject && (
        <ImagePreviewModal
          src={`${referenceImageUrl(previewObject.id)}${imgVersion[previewObject.id] ? `?v=${imgVersion[previewObject.id]}` : ''}`}
          alt={previewObject.name}
          onClose={() => setPreviewObject(null)}
        />
      )}

      {contextMenu &&
        (() => {
          const obj = objects.find((o) => o.id === contextMenu.objectId)
          if (!obj) return null
          return (
            <ContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              items={buildContextItems(obj)}
              onClose={() => setContextMenu(null)}
            />
          )
        })()}
    </div>
  )
}
