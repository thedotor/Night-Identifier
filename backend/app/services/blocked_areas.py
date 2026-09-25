"""Areas of a photo the user has fenced off from detection (string lights, trees, buildings,
reflections ...). One list of polygons per image, shared by every detector: star detection for
the Constellations page and the Sky Overlay, and the trained models' detections.

A region is a polygon [[x, y], ...] with 3+ points, in full-resolution image pixels.
"""

Region = list[list[float]]


def point_in_polygon(x: float, y: float, polygon: Region) -> bool:
    """Ray casting: count crossings of a horizontal ray from (x, y) with the polygon's edges.
    Odd = inside. Works for any simple polygon, convex or concave."""
    inside = False
    n = len(polygon)
    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            x_at_y = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < x_at_y:
                inside = not inside
    return inside


def in_any_region(x: float, y: float, regions: list[Region] | None) -> bool:
    return any(len(r) >= 3 and point_in_polygon(x, y, r) for r in (regions or []))
