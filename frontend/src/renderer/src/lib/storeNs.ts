/**
 * Is this one of the extra windows (the second-monitor dashboard at #/monitor, or a single pop-out card at #/card/<id>)?
 * They share this browser profile with the main window, so their own view settings (which layers are on, which
 * boxes are folded, the wind height…) get keys of their own, and changing the Earth view there does not change the main Deep Space page.
 * Things that should be the same in both (the theme, your saved location) do not go through here.
 */
export const isPopout = (): boolean => window.location.hash.startsWith('#/monitor') || window.location.hash.startsWith('#/card/')

export const nsKey = (key: string): string => (isPopout() ? `monitor:${key}` : key)
