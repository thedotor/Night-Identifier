import { useEffect, useState, type ReactElement } from 'react'
import { errorText, live, type LiveCamera, type MotionSettings } from '@renderer/lib/liveApi'
import { btn, btnActive } from './ui'

export function MonitorPanel({ camera, onChanged }: { camera: LiveCamera; onChanged: () => void }): ReactElement {
  // Sliders edit a local copy and save when released, so dragging does not restart the detector each step.
  const [m, setM] = useState<MotionSettings>(camera.motion)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setM(camera.motion), [camera.motion])

  const patch = async (changes: Partial<MotionSettings>): Promise<void> => {
    setError(null)
    try {
      await live.patch(camera.id, { motion: changes })
      onChanged()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div className="space-y-4">
      <label className="flex items-start gap-2 text-xs text-text">
        <input type="checkbox" className="mt-0.5" checked={m.enabled} onChange={(e) => void patch({ enabled: e.target.checked })} />
        <span>
          Watch this camera for {m.mode === 'meteor' ? 'meteors and streaks' : 'motion'}
          <span className="block text-[11px] text-text-muted">
            The camera keeps running and watching even when you leave Live View. You get a notification, plus a saved picture{m.save_clip ? ' and a short clip' : ''}.
          </span>
        </span>
      </label>

      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">What to look for</div>
        <div className="flex gap-1">
          <button className={m.mode === 'motion' ? btnActive : btn} onClick={() => void patch({ mode: 'motion' })}>
            Motion
          </button>
          <button className={m.mode === 'meteor' ? btnActive : btn} onClick={() => void patch({ mode: 'meteor' })}>
            Meteor / streak
          </button>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-text-muted">
          {m.mode === 'meteor'
            ? 'Only bright straight lines count (meteors, satellites, planes). Twinkling stars, cloud and sudden brightness changes are ignored. Works best on a fixed all-sky or wide-field camera.'
            : 'Anything that moves in the picture counts. Good for security cameras and wildlife.'}
        </p>
      </div>

      <label className="block text-xs text-text-muted">
        <span className="flex justify-between">
          Sensitivity <span className="tabular-nums text-text">{m.sensitivity}</span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={m.sensitivity}
          className="w-full accent-[rgb(var(--color-accent))]"
          onChange={(e) => setM({ ...m, sensitivity: Number(e.target.value) })}
          onPointerUp={() => void patch({ sensitivity: m.sensitivity })}
          onKeyUp={() => void patch({ sensitivity: m.sensitivity })}
        />
        <span className="text-[11px]">Higher catches fainter events but may give false alarms.</span>
      </label>

      {m.mode === 'motion' && (
        <label className="block text-xs text-text-muted">
          <span className="flex justify-between">
            Smallest change <span className="tabular-nums text-text">{m.min_area_pct}% of the picture</span>
          </span>
          <input
            type="range"
            min={0.01}
            max={5}
            step={0.01}
            value={m.min_area_pct}
            className="w-full accent-[rgb(var(--color-accent))]"
            onChange={(e) => setM({ ...m, min_area_pct: Number(e.target.value) })}
            onPointerUp={() => void patch({ min_area_pct: m.min_area_pct })}
            onKeyUp={() => void patch({ min_area_pct: m.min_area_pct })}
          />
        </label>
      )}

      <label className="block text-xs text-text-muted">
        <span className="flex justify-between">
          Quiet time between alerts <span className="tabular-nums text-text">{m.cooldown_s} s</span>
        </span>
        <input
          type="range"
          min={1}
          max={120}
          value={m.cooldown_s}
          className="w-full accent-[rgb(var(--color-accent))]"
          onChange={(e) => setM({ ...m, cooldown_s: Number(e.target.value) })}
          onPointerUp={() => void patch({ cooldown_s: m.cooldown_s })}
          onKeyUp={() => void patch({ cooldown_s: m.cooldown_s })}
        />
      </label>

      <div className="space-y-1.5 text-xs text-text">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={m.save_frame} onChange={(e) => void patch({ save_frame: e.target.checked })} />
          Save a picture of each event
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={m.save_clip} onChange={(e) => void patch({ save_clip: e.target.checked })} />
          Save a short clip (a few seconds before and after)
        </label>
      </div>
      <p className="text-[11px] leading-snug text-text-muted">Events are saved in the camera's Live folder, in an "events" sub-folder, and appear in Notifications.</p>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}
