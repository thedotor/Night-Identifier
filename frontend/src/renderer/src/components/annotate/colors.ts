/** Deterministic, visually-distinct color per object type id (for shape strokes/labels). */
export function colorForObjectType(objectTypeId: number): string {
  const hue = (objectTypeId * 137.508) % 360 // golden-angle spacing
  return `hsl(${hue.toFixed(0)}, 85%, 62%)`
}
