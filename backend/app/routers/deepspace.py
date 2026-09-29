"""Deep Space: object detail (facts, description, credited imagery) and survey cut-outs.
All remote content is fetched and cached by app.services.deepspace."""

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from app.services import deepspace, earthmaps, galaxy, moons, orbits, places
from app.services.deepspace import FetchError

router = APIRouter(prefix="/deepspace", tags=["deepspace"])

_CACHE_HEADERS = {"Cache-Control": "public, max-age=86400"}


@router.get("/object")
def get_object(kind: Literal["dso", "star", "body"], key: str) -> dict[str, Any]:
    info = deepspace.object_info(kind, key)
    if info is None:
        raise HTTPException(status_code=404, detail="Unknown object")
    return info


@router.get("/media")
def get_media(url: str) -> FileResponse:
    """A cached copy of an image from one of the allowed archives."""
    try:
        path = deepspace.media_path(url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FetchError as e:
        raise HTTPException(status_code=502, detail=f"Image unavailable: {e}")
    return FileResponse(path, media_type=deepspace.media_type(path), headers=_CACHE_HEADERS)


@router.get("/cutout")
def get_cutout(
    ra: float = Query(ge=0, le=360),
    dec: float = Query(ge=-90, le=90),
    fov: float = Query(gt=0.005, le=30, description="field width in degrees"),
    w: int = Query(default=1024, ge=64, le=1600),
    h: int = Query(default=1024, ge=64, le=1600),
    survey: Literal["dss2", "panstarrs", "2mass"] = "dss2",
) -> FileResponse:
    """North-up survey image centred on (ra, dec), J2000."""
    try:
        path = deepspace.cutout_path(ra, dec, fov, w, h, survey)
    except FetchError as e:
        raise HTTPException(status_code=502, detail=f"Survey image unavailable: {e}")
    return FileResponse(path, media_type=deepspace.media_type(path), headers=_CACHE_HEADERS)


@router.get("/orbits")
def get_orbits() -> dict[str, Any]:
    """Orbital elements of dwarf planets, notable asteroids and comets, plus sample clouds of the
    main belt, Jupiter's Trojans and the Kuiper belt."""
    return orbits.orbit_data()


@router.get("/moons")
def get_moons() -> dict[str, Any]:
    """Orbital element tables for the moons of Saturn, Uranus, Neptune and Pluto (JPL Horizons)."""
    return moons.moon_elements()


@router.get("/stars3d")
def get_stars3d() -> dict[str, Any]:
    """Hipparcos stars with parallaxes: rows of [ra, dec, parallax_mas, vmag, b-v, catalogue_index]."""
    return galaxy.stars()


@router.get("/hosts")
def get_hosts() -> dict[str, Any]:
    """Stars with confirmed planets: rows of [ra, dec, distance_pc, planets, vmag, name]."""
    return galaxy.hosts()


@router.get("/systems")
def get_systems() -> dict[str, Any]:
    """Known planets per host star: {host: {star: [radius_sun, mass_sun, teff], planets: [[name, a_au, e, period_d, radius_earth, mass_earth, year, method]...]}}."""
    return galaxy.systems()


@router.get("/distances")
def get_distances() -> dict[str, Any]:
    """Distance (median of SIMBAD's measurements) for each catalogue deep-sky object that has one."""
    return galaxy.distances()


@router.get("/localgroup")
def get_local_group() -> dict[str, Any]:
    """Galaxies in and around the Local Group with distances."""
    return galaxy.local_group()


@router.get("/galaxies3d")
def get_galaxies3d() -> dict[str, Any]:
    """About 44,000 galaxies beyond the Local Group (2MASS Redshift Survey): rows of [ra, dec, cz_km_s, k_mag, log10_radius_arcsec, b/a, T, bar]."""
    return galaxy.galaxies3d()


@router.get("/galaxytypes")
def get_galaxy_types() -> dict[str, Any]:
    """Morphological type (SIMBAD) of each catalogue galaxy that has one, by catalogue id."""
    return galaxy.galaxy_types()


@router.get("/textures")
def get_textures() -> dict[str, Any]:
    """Backend-relative URLs of the planet maps, and the credit they must be shown with."""
    return {"urls": deepspace.texture_urls(), "credit": deepspace.TEXTURE_CREDIT}


@router.get("/pack")
def pack_status() -> dict[str, Any]:
    return deepspace.pack_status()


@router.post("/pack")
def start_pack() -> dict[str, Any]:
    deepspace.start_pack()
    return deepspace.pack_status()


@router.delete("/cache")
def clear_cache() -> dict[str, Any]:
    if deepspace.pack_status()["running"]:
        raise HTTPException(status_code=409, detail="Wait for the download to finish")
    deepspace.clear_cache()
    return deepspace.pack_status()


# ---------- the Earth: high-resolution maps and cities ----------


@router.get("/earth-map/{kind}/{level}")
async def get_earth_map(kind: Literal["day", "night"], level: int) -> FileResponse:
    """The whole-Earth picture (equirectangular): level 3 is 5120x2560, level 4 is 10240x5120. Stitched from NASA tiles on first use (about 10-30 s)."""
    if level not in earthmaps.LEVELS:
        raise HTTPException(status_code=404, detail="Unknown level")
    try:
        path = await run_in_threadpool(earthmaps.build_map, kind, level)
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return FileResponse(path, media_type="image/jpeg", headers=_CACHE_HEADERS)


@router.get("/science-map/{kind}")
async def get_science_map(kind: Literal["ozone"]) -> FileResponse:
    """A coarse global science layer (equirectangular), stitched from NASA GIBS and refreshed every few hours."""
    try:
        path = await run_in_threadpool(earthmaps.build_science_map, kind)
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=1800"})


@router.get("/earth-tile/{z}/{x}/{y}")
async def get_earth_tile(z: int, x: int, y: int) -> FileResponse:
    """A sharp close-up imagery tile of the Earth (256 px, web-map numbering, zoom 0-14), cached on disk."""
    try:
        path = await run_in_threadpool(earthmaps.tile, z, x, y)
    except LookupError as e:
        raise HTTPException(status_code=404, detail="No such tile") from e
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return FileResponse(path, media_type="image/jpeg", headers=_CACHE_HEADERS)


@router.get("/towns")
async def get_towns() -> FileResponse:
    """Every town and village of 1,000 people or more (GeoNames), biggest first, as one cached JSON file."""
    try:
        path = await run_in_threadpool(places.towns_file)
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return FileResponse(path, media_type="application/json", headers=_CACHE_HEADERS)


@router.get("/nearest-town")
async def get_nearest_town(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=360), max_km: float = Query(60, gt=0, le=500)) -> dict[str, Any]:
    try:
        town = await run_in_threadpool(places.nearest, lat, lon, max_km)
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"town": town, "credit": places.CREDIT}


@router.get("/cities")
async def get_cities() -> dict[str, Any]:
    try:
        return await run_in_threadpool(earthmaps.cities)
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
