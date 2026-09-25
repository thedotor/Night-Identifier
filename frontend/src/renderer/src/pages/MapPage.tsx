import { useEffect, useState, type ReactElement } from 'react'
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { api, MapImage, previewUrl } from '@renderer/lib/api'

const markerIcon = L.divIcon({
  className: '',
  html: `<div style="width:14px;height:14px;border-radius:50%;background:#63b3ed;border:2px solid white;box-shadow:0 0 4px rgba(0,0,0,0.6)"></div>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7]
})

export function MapPage(): ReactElement {
  const [images, setImages] = useState<MapImage[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<MapImage[]>('/map/images')
      .then(setImages)
      .catch(() => setError('Could not load geotagged images.'))
  }, [])

  const center: [number, number] =
    images.length > 0 ? [images[0].latitude, images[0].longitude] : [20, 0]

  return (
    <div className="flex h-full flex-col p-8">
      <h1 className="text-xl font-semibold text-text">Map</h1>
      <p className="mt-2 max-w-2xl text-sm text-text-muted">
        Images with GPS EXIF data, plotted by where they were taken.
      </p>

      {error && (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {images.length === 0 && !error ? (
        <div className="mt-6 flex flex-1 items-center justify-center rounded-lg border border-dashed border-border text-sm text-text-muted">
          No images with GPS location data yet. Cameras/phones that embed GPS EXIF tags will show
          up here automatically after import.
        </div>
      ) : (
        <div className="mt-6 min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
          <MapContainer center={center} zoom={images.length > 0 ? 8 : 2} className="h-full w-full">
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {images.map((img) => (
              <Marker key={img.id} position={[img.latitude, img.longitude]} icon={markerIcon}>
                <Popup>
                  <div className="flex flex-col gap-1">
                    <img
                      src={previewUrl(img.id)}
                      alt={img.filename}
                      className="h-24 w-40 rounded object-cover"
                    />
                    <div className="text-xs font-medium">{img.filename}</div>
                    {img.captured_at && (
                      <div className="text-[11px] text-gray-500">
                        {new Date(img.captured_at).toLocaleString()}
                      </div>
                    )}
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
      )}
    </div>
  )
}
