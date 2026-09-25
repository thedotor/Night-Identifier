"""Well-known informal star patterns (asterisms) -- not official IAU
constellations, but often the actual shape people recognize and photograph.
Reuses the same Star/ConstellationDef shape as constellations.py so the
sky overlay can treat them identically.

Coordinates are pulled from the same stars already present in
constellations.py (several asterisms share stars with, or are subsets of,
a full constellation -- e.g. the Big Dipper is 7 of Ursa Major's 16 stars),
so there's a second reason for a dedicated entry beyond naming: matching
against the full 16-star Ursa Major caps confidence well below what a
partial classic-Dipper-only photo can ever reach, even for a geometrically
perfect match, simply by having more total reference stars to divide by.
A dedicated small asterism doesn't have that problem.
"""

from app.data.constellations import ConstellationDef, Star

ASTERISMS: list[ConstellationDef] = [
    ConstellationDef(
        abbr="BigDipper",
        name="Big Dipper (Ursa Major)",
        stars=[
            Star("Megrez", -176.1435, 57.0326, 3.32),
            Star("Dubhe", 165.932, 61.751, 1.81),
            Star("Merak", 165.4603, 56.3824, 2.34),
            Star("Phecda", 178.4577, 53.6948, 2.41),
            Star("Alioth", -166.4927, 55.9598, 1.76),
            Star("Mizar", -159.0186, 54.9254, 2.23),
            Star("Alkaid", -153.1148, 49.3133, 1.85),
        ],
        lines=[(0, 1), (1, 2), (2, 3), (3, 0), (0, 4), (4, 5), (5, 6)],
    ),
    ConstellationDef(
        abbr="WinterHexagon",
        name="Winter Hexagon",
        stars=[
            Star("Rigel", 78.6345, -8.2016, 0.18),
            Star("Aldebaran", 68.9802, 16.5093, 0.87),
            Star("Capella", 79.1723, 45.998, 0.08),
            Star("Pollux", 116.329, 28.0262, 1.16),
            Star("Procyon", 114.8255, 5.225, 0.4),
            Star("Sirius", 101.2872, -16.7161, -1.44),
        ],
        lines=[(0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 0)],
    ),
    ConstellationDef(
        abbr="Sickle",
        name="Sickle of Leo",
        stars=[
            Star("Regulus", 152.093, 11.9672, 1.36),
            Star("Al Jabhah", 151.8331, 16.7627, 3.48),
            Star("Algieba", 154.9931, 19.8415, 2.01),
            Star("Adhafera", 154.1726, 23.4173, 3.43),
            Star("Rasalas", 148.1909, 26.007, 3.88),
            Star("Algenubi", 146.4628, 23.7743, 2.97),
        ],
        lines=[(0, 1), (1, 2), (2, 3), (3, 4), (4, 5)],
    ),
    ConstellationDef(
        abbr="OrionHourglass",
        name="Orion (Hourglass)",
        stars=[
            Star("Betelgeuse", 88.7929, 7.4071, 0.45),
            Star("Bellatrix", 81.2828, 6.3497, 1.64),
            Star("Mintaka", 83.0017, -0.2991, 2.25),
            Star("Alnilam", 84.0534, -1.2019, 1.69),
            Star("Alnitak", 85.1897, -1.9426, 1.74),
            Star("Saiph", 86.9391, -9.6696, 2.07),
            Star("Rigel", 78.6345, -8.2016, 0.18),
        ],
        lines=[(0, 4), (1, 2), (2, 3), (3, 4), (4, 5), (2, 6)],
    ),
    ConstellationDef(
        abbr="SummerTriangle",
        name="Summer Triangle",
        stars=[
            Star("Vega", -80.7653, 38.7837, 0.03),
            Star("Deneb", -49.642, 45.2803, 1.25),
            Star("Altair", -62.3042, 8.8683, 0.76),
        ],
        lines=[(0, 1), (1, 2), (2, 0)],
    ),
]
