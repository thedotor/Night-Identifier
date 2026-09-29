import { useEffect, useState, type ReactElement } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMapEvents } from 'react-leaflet'
import { useMyPlaces } from '@renderer/lib/myPlaces'
import { readPageState, writePageState } from '@renderer/lib/pageState'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { api, MapImage, previewUrl } from '@renderer/lib/api'

const markerIcon = L.divIcon({
  className: '',
  html: `<div style="width:14px;height:14px;border-radius:50%;background:#63b3ed;border:2px solid white;box-shadow:0 0 4px rgba(0,0,0,0.6)"></div>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7]
})

const placeIcon = L.divIcon({
  className: '',
  html: `<div style="width:14px;height:14px;transform:rotate(45deg);background:#4dd8ff;border:2px solid white;box-shadow:0 0 4px rgba(0,0,0,0.6)"></div>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7]
})

interface NearestTown {
  town: { name: string; country: string; region: string; population: number; km: number } | null
}

/** The photo's popup: the picture, and the town it was taken near (GeoNames, looked up when the popup opens). */
function PhotoPopup({ img }: { img: MapImage }): ReactElement {
  const [near, setNear] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api
      .get<NearestTown>(`/deepspace/nearest-town?lat=${img.latitude}&lon=${img.longitude}&max_km=80`)
      .then((d) => {
        if (!live) return
        const t = d.town
        setNear(t ? `Near ${t.name}${t.region || t.country ? ` (${[t.region, t.country].filter(Boolean).join(', ')})` : ''}${t.km >= 1 ? `, ${t.km.toFixed(0)} km away` : ''}` : 'No town within 80 km')
      })
      .catch(() => live && setNear(null))
    return () => {
      live = false
    }
  }, [img.latitude, img.longitude])
  return (
    <div className="flex flex-col gap-1">
      <img src={previewUrl(img.id)} alt={img.filename} className="h-24 w-40 rounded object-cover" />
      <div className="text-xs font-medium">{img.filename}</div>
      {near && <div className="text-[11px] text-gray-700">{near}</div>}
      {img.captured_at && <div className="text-[11px] text-gray-500">{new Date(img.captured_at).toLocaleString()}</div>}
    </div>
  )
}

/** While "Add a place" is on, a click on the map puts one there. */
function AddPlaceOnClick({ on, onPick }: { on: boolean; onPick: (lat: number, lon: number) => void }): null {
  useMapEvents({
    click: (e) => {
      if (on) onPick(e.latlng.lat, e.latlng.lng)
    }
  })
  return null
}

/** Remembers where the map was looked at (centre and zoom), for next time. */
function RememberView(): null {
  useMapEvents({
    moveend: (e) => {
      const c = e.target.getCenter()
      writePageState('map', 'view', { lat: c.lat, lng: c.lng, zoom: e.target.getZoom() })
    }
  })
  return null
}

export function MapPage(): ReactElement {
  const { places, add: addPlace, remove: removePlace } = useMyPlaces()
  const [adding, setAdding] = useState(false)
  const [images, setImages] = useState<MapImage[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<MapImage[]>('/map/images')
      .then(setImages)
      .catch(() => setError('Could not load geotagged images.'))
  }, [])

  const [saved] = useState(() => {
    const v = readPageState<{ lat?: unknown; lng?: unknown; zoom?: unknown } | null>('map', 'view', null)
    return v && [v.lat, v.lng, v.zoom].every((n) => typeof n === 'number' && Number.isFinite(n)) ? { lat: v.lat as number, lng: v.lng as number, zoom: v.zoom as number } : null
  })
  const center: [number, number] = saved ? [saved.lat, saved.lng] : images.length > 0 ? [images[0].latitude, images[0].longitude] : [20, 0]

  return (
    <div className="flex h-full flex-col p-8">
      <h1 className="text-xl font-semibold text-text">Map</h1>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <p className="max-w-2xl text-sm text-text-muted">Images with GPS EXIF data, plotted by where they were taken, and your own named places.</p>
        <button
          onClick={() => setAdding((a) => !a)}
          className={adding ? 'rounded-md border border-accent bg-accent/20 px-3 py-1 text-xs text-text' : 'rounded-md border border-border px-3 py-1 text-xs text-text-muted hover:border-accent hover:text-text'}
          title="Then click the map where the place is. The same places show on the 3D Earth."
        >
          {adding ? 'Click the map…' : 'Add a place'}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {images.length === 0 && !error && (
        <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-2 text-sm text-text-muted">
          No images with GPS location data yet. Cameras/phones that embed GPS EXIF tags will show up here automatically after import.
        </div>
      )}
      <div className="mt-6 min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
          <MapContainer center={center} zoom={saved ? saved.zoom : images.length > 0 ? 8 : 2} className="h-full w-full">
            <RememberView />
            <AddPlaceOnClick
              on={adding}
              onPick={(lat, lon) => {
                const name = window.prompt('Name for this place')
                setAdding(false)
                if (name !== null) addPlace(name, lat, lon)
              }}
            />
            {places.map((pl) => (
              <Marker key={pl.id} position={[pl.lat, pl.lon]} icon={placeIcon}>
                <Popup>
                  <div className="flex flex-col gap-1">
                    <div className="text-xs font-semibold">{pl.name}</div>
                    <div className="text-[11px] text-gray-500">
                      {pl.lat.toFixed(4)}°, {pl.lon.toFixed(4)}° · one of my places
                    </div>
                    <button className="self-start rounded border border-gray-300 px-2 py-0.5 text-[11px] text-red-600" onClick={() => removePlace(pl.id)}>
                      Remove
                    </button>
                  </div>
                </Popup>
              </Marker>
            ))}
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {images.map((img) => (
              <Marker key={img.id} position={[img.latitude, img.longitude]} icon={markerIcon}>
                <Popup>
                  <PhotoPopup img={img} />
                </Popup>
              </Marker>
            ))}
          </MapContainer>
      </div>
    </div>
  )
}
