// The image you last picked, shared by every page with an image list (Annotate, Sky Overlay,
// Star Classifier) so moving between pages keeps you on the same photo.
// Only an explicit click updates it: a page that falls back to its first image (because the
// remembered one isn't in its list) must not overwrite the memory.

const KEY = 'last-image-id'

export function getLastImageId(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY))
    return Number.isInteger(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

export function rememberImage(id: number): void {
  try {
    localStorage.setItem(KEY, String(id))
  } catch {
    /* it just won't survive a restart */
  }
}

/** The remembered image if this page's list has it, otherwise the first one. */
export function initialImageId(images: { id: number }[]): number | null {
  const last = getLastImageId()
  return images.find((i) => i.id === last)?.id ?? images[0]?.id ?? null
}
