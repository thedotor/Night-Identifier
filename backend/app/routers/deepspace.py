"""Deep Space: object detail (facts, description, credited imagery) and survey cut-outs.
All remote content is fetched and cached by app.services.deepspace."""

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from app.services import deepspace, galaxy, moons, orbits
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
