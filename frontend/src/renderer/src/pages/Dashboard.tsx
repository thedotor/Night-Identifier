import { useState, type ReactElement } from 'react'
import { usePageState } from '@renderer/lib/pageState'
import { AddWidgetTray, DashboardGrid } from '@renderer/components/dashboard/DashboardGrid'
import { PlaceBar } from '@renderer/components/dashboard/SkyCards'
import { useDashboardLayout } from '@renderer/components/dashboard/useDashboardLayout'
import { usePlace } from '@renderer/components/dashboard/usePlace'
import { useDashData } from '@renderer/components/dashboard/useDashData'

const btn = 'rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-muted hover:border-accent hover:text-text'

export function Dashboard(): ReactElement {
  const { place, raw, save } = usePlace()
  const layout = useDashboardLayout()
  const [editing, setEditing] = usePageState('dashboard', 'editing', false, (v) => (typeof v === 'boolean' ? v : undefined))
  const [confirmReset, setConfirmReset] = useState(false)

  const data = useDashData(place)
  const error = data.error

  return (
    <div className="flex h-full flex-col overflow-y-auto p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Dashboard</h1>
          <p className="mt-2 text-sm text-text-muted">
            {editing ? 'Drag widgets to rearrange them, pick a width (1 to 4 columns), or remove them. Changes are saved as you go.' : 'Status across scanning, training and the sky.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className={btn} onClick={() => void window.api.monitor.open()} title="Open a second window of live monitoring cards (weather, aurora, ISS, lightning, a live globe…) to put on another monitor">
            Pop out to a second monitor
          </button>
          {editing && (
            <button
              className={btn}
              onClick={() => {
                if (!confirmReset) return setConfirmReset(true)
                layout.reset()
                setConfirmReset(false)
              }}
              onBlur={() => setConfirmReset(false)}
              title="Put every widget back where it started"
            >
              {confirmReset ? 'Click again to reset' : 'Reset layout'}
            </button>
          )}
          <button
            className={editing ? 'rounded-md border border-accent bg-accent/20 px-3 py-1.5 text-xs font-medium text-text' : btn}
            onClick={() => {
              setEditing((e) => !e)
              setConfirmReset(false)
            }}
          >
            {editing ? 'Done' : 'Customize'}
          </button>
        </div>
      </div>

      <div className="mt-4">
        <PlaceBar raw={raw} place={place} save={save} />
      </div>

      {editing && (
        <div className="mt-4">
          <AddWidgetTray hidden={layout.hidden} onAdd={layout.add} />
        </div>
      )}

      <div className="mt-6">
        <DashboardGrid layout={layout} data={data} editing={editing} />
      </div>

      {error && (
        <div className="mt-6 rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Could not reach the local backend at http://127.0.0.1:8765. Make sure it's running.
        </div>
      )}
    </div>
  )
}
