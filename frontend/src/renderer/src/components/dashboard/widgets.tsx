import type { ReactElement } from 'react'
import type { DashboardStats, HealthStatus, ImageStats, TrainingStatusOut } from '@renderer/lib/api'
import { fmtGB, type DriveInfo } from '@renderer/notifications/alertLogic'
import type { Place } from '@renderer/lib/skyTonight'
import { IssCard } from './IssCard'
import { EarthGlobeCard } from './EarthGlobeCard'
import { EarthOnlyCard } from './EarthOnlyCard'
import { RecentQuakesCard, VolcanoActivityCard } from './HazardCards'
import { AuroraCard, SpaceWeatherCard } from './AuroraCards'
import { LightningCard } from './LightningCard'
import { TrafficCard } from './TrafficCard'
import { SunActivityCard, SunCard } from './SunCards'
import { FieldWindCard, WindForecastCard } from './FieldWindCards'
import { EventsTonightCard, EventsUpcomingCard, EventsWeekCard } from './EventCards'
import { CamerasCard, PlanetsCard, TonightCard, WeatherCard } from './SkyCards'

/** How many of the four columns a widget takes (on a narrow window anything above 2 takes the full width). */
export type Span = 1 | 2 | 3 | 4

/** Everything the widgets can show, gathered once by the dashboard page. */
export interface DashData {
  health: HealthStatus | null
  imageStats: ImageStats | null
  training: TrainingStatusOut | null
  stats: DashboardStats | null
  error: string | null
  place: Place | null
  /** free space on the drive(s) the app saves to */
  drives: DriveInfo[]
}

export interface WidgetDef {
  id: string
  title: string
  group: string
  hint: string
  defaultSpan: Span
  render: (d: DashData) => ReactElement
  /** a section title, drawn without a card */
  heading?: boolean
}

export function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }): ReactElement {
  return (
    <div className="h-full min-h-[6.75rem] rounded-lg border border-border bg-surface p-4">
      <div className="text-xs uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-text">{value}</div>
      {hint && <div className="mt-1 text-xs text-text-muted">{hint}</div>}
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

const num = (v: number | undefined): string => (v === undefined ? '-' : v.toLocaleString())

// Check is_running first: has_model can stay true from an older completed run while a newer run is
// in progress, so it alone can't tell us which run's id is actually behind the active model file.
const modelValue = (t: TrainingStatusOut | null): string => (t?.is_running ? 'Training...' : t?.has_model ? 'Trained' : 'No model trained')

function map50Of(t: TrainingStatusOut | null): number | undefined {
  const key = Object.keys(t?.latest_run?.metrics ?? {}).find((k) => k.includes('mAP50(B)'))
  return key ? t?.latest_run?.metrics[key] : undefined
}

/** A section title: a small caption and a rule, so the cards under it read as a group. */
function Heading({ text }: { text: string }): ReactElement {
  return (
    <div className="flex items-center gap-3 pt-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{text}</h2>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

const heading = (id: string, text: string): WidgetDef => ({ id, title: `Heading: ${text}`, group: 'Layout', hint: 'A title for a group of cards', defaultSpan: 4, heading: true, render: () => <Heading text={text} /> })

/** Every widget the dashboard can show. Order here is only the order of the "Add widget" list. */
export const WIDGETS: WidgetDef[] = [
  heading('h-status', 'Status'),
  heading('h-sky', 'Tonight’s sky'),
  heading('h-events', 'Sky calendar'),
  heading('h-space', 'Live feeds'),
  heading('h-aurora', 'Aurora and space weather'),
  heading('h-sun', 'The Sun'),
  heading('h-library', 'Cameras and library'),
  heading('h-training', 'Training'),
  {
    id: 'backend',
    title: 'Backend status',
    group: 'Status',
    hint: 'Is the local backend running',
    defaultSpan: 1,
    render: (d) => <StatCard label="Backend" value={d.error ? 'Offline' : d.health ? 'Online' : 'Checking...'} />
  },
  {
    id: 'gpu',
    title: 'GPU',
    group: 'Status',
    hint: 'Whether a GPU is available for training and detection',
    defaultSpan: 1,
    render: (d) => <StatCard label="GPU" value={d.health?.gpu_available ? 'Available' : d.health ? 'CPU only' : '-'} hint={d.health?.gpu_name ?? undefined} />
  },
  {
    id: 'model',
    title: 'Model version',
    group: 'Status',
    hint: 'Whether a detector model is trained',
    defaultSpan: 1,
    render: (d) => <StatCard label="Model version" value={modelValue(d.training)} />
  },
  {
    id: 'pending',
    title: 'Pending images',
    group: 'Status',
    hint: 'Images waiting to be scanned',
    defaultSpan: 1,
    render: (d) => <StatCard label="Pending images" value={d.imageStats ? String(d.imageStats.pending) : '-'} hint={d.imageStats ? `${d.imageStats.total} total in library` : undefined} />
  },
  {
    id: 'iss',
    title: 'ISS tracker',
    group: 'Live feeds',
    hint: 'Where the International Space Station is, and your next passes',
    defaultSpan: 2,
    render: (d) => <IssCard place={d.place} />
  },
  {
    id: 'earth-globe',
    title: 'Live Earth and solar system',
    group: 'Earth & hazards',
    hint: 'The 3D Deep Space view: a live Earth (clouds, wind, currents, planes, ships, lightning, aurora) and the whole solar system, the Sun and its activity, the magnetic field and solar wind, planet names, each switched on or off',
    defaultSpan: 4,
    render: () => <EarthGlobeCard />
  },
  {
    id: 'earth-only',
    title: 'Live Earth (just the globe)',
    group: 'Earth & hazards',
    hint: 'Only the Earth: the Deep Space view with the same menus and switches (weather, hazards, the Sun and CMEs, magnetic field and solar wind, traffic, info boxes) but no stars or galaxies',
    defaultSpan: 4,
    render: () => <EarthOnlyCard />
  },
  {
    id: 'quakes-list',
    title: 'Recent earthquakes',
    group: 'Earth & hazards',
    hint: 'A live list of the newest or biggest earthquakes (USGS), with a size and age filter; click one to see it on the Earth',
    defaultSpan: 2,
    render: () => <RecentQuakesCard />
  },
  {
    id: 'volcano-list',
    title: 'Volcano activity',
    group: 'Earth & hazards',
    hint: 'Volcanoes erupting, in unrest or on alert now, from the Smithsonian / USGS weekly report and USGS alert levels; click one to see it on the Earth',
    defaultSpan: 2,
    render: () => <VolcanoActivityCard />
  },
  {
    id: 'tonight',
    title: 'Tonight',
    group: 'Sky tonight',
    hint: 'Sunset, darkness, Moon phase and rise / set',
    defaultSpan: 1,
    render: (d) => <TonightCard place={d.place} />
  },
  {
    id: 'planets',
    title: 'Planets now',
    group: 'Sky tonight',
    hint: 'Which planets are up, and where',
    defaultSpan: 1,
    render: (d) => <PlanetsCard place={d.place} />
  },
  {
    id: 'weather',
    title: 'Weather',
    group: 'Sky tonight',
    hint: 'Conditions and cloud cover for the next 12 hours',
    defaultSpan: 2,
    render: (d) => <WeatherCard place={d.place} />
  },
  {
    id: 'aurora',
    title: 'Aurora',
    group: 'Space weather & Sun',
    hint: 'Live aurora forecast: your chance, and maps of the north and south ovals',
    defaultSpan: 2,
    render: (d) => <AuroraCard place={d.place} />
  },
  {
    id: 'space-weather',
    title: 'Space weather',
    group: 'Space weather & Sun',
    hint: 'Kp index now and forecast, and the solar wind and Bz that drive the aurora',
    defaultSpan: 2,
    render: () => <SpaceWeatherCard />
  },
  {
    id: 'events-tonight',
    title: "Tonight's sky (events)",
    group: 'Sky tonight',
    hint: 'How good tonight is for looking up (darkness, Moon, cloud) and the events on it',
    defaultSpan: 2,
    render: (d) => <EventsTonightCard place={d.place} />
  },
  {
    id: 'events-upcoming',
    title: 'Coming up (events)',
    group: 'Sky tonight',
    hint: 'The most interesting sky events in the next months: showers, eclipses, planets, comets',
    defaultSpan: 2,
    render: (d) => <EventsUpcomingCard place={d.place} />
  },
  {
    id: 'events-week',
    title: "This week's nights",
    group: 'Sky tonight',
    hint: 'The next seven nights: Moon, darkness, cloud and a rating for each',
    defaultSpan: 4,
    render: (d) => <EventsWeekCard place={d.place} />
  },
  {
    id: 'field-wind',
    title: 'Magnetic field and solar wind',
    group: 'Space weather & Sun',
    hint: 'The wind at L1, Bz, the size of the magnetosphere, Dst and live ground magnetometers',
    defaultSpan: 2,
    render: () => <FieldWindCard />
  },
  {
    id: 'wind-forecast',
    title: 'Solar wind forecast',
    group: 'Space weather & Sun',
    hint: "NOAA's WSA-Enlil model: wind at Earth for the coming week, and what is on its way",
    defaultSpan: 2,
    render: () => <WindForecastCard />
  },
  {
    id: 'sun',
    title: 'The Sun now',
    group: 'Space weather & Sun',
    hint: 'A live picture of the Sun, the X-ray level and the strongest recent flare',
    defaultSpan: 2,
    render: () => <SunCard />
  },
  {
    id: 'sun-activity',
    title: 'Solar storms and sunspots',
    group: 'Space weather & Sun',
    hint: 'Coronal mass ejections (with the arrival time of any heading for Earth) and the numbered sunspot groups',
    defaultSpan: 2,
    render: () => <SunActivityCard />
  },
  {
    id: 'lightning',
    title: 'Lightning',
    group: 'Live feeds',
    hint: 'Live lightning worldwide: strikes per minute, the storm nearest you and a map of the last 15 minutes',
    defaultSpan: 2,
    render: (d) => <LightningCard place={d.place} />
  },
  {
    id: 'traffic',
    title: 'Your web traffic',
    group: 'Live feeds',
    hint: 'Where this PC’s internet connections go right now: top countries and programs, with a 7-day history. Off until you turn it on.',
    defaultSpan: 2,
    render: () => <TrafficCard />
  },
  {
    id: 'cameras',
    title: 'Cameras',
    group: 'Library & cameras',
    hint: 'Live View cameras and whether they are running',
    defaultSpan: 2,
    render: () => <CamerasCard />
  },
  {
    id: 'library-images',
    title: 'Library images',
    group: 'Library & cameras',
    hint: 'Images in the library',
    defaultSpan: 1,
    render: (d) => <StatCard label="Library images" value={num(d.stats?.library_images)} />
  },
  {
    id: 'processed',
    title: 'Processed images',
    group: 'Library & cameras',
    hint: 'Images scanned, and the detections found',
    defaultSpan: 1,
    render: (d) => <StatCard label="Processed" value={num(d.stats?.processed_images)} hint={d.stats ? `${d.stats.detections.toLocaleString()} detections` : undefined} />
  },
  {
    id: 'geotagged',
    title: 'Geotagged images',
    group: 'Library & cameras',
    hint: 'Images with a location, shown on the Map',
    defaultSpan: 1,
    render: (d) => <StatCard label="Geotagged" value={num(d.stats?.geotagged_images)} hint="Shown on the Map" />
  },
  {
    id: 'storage',
    title: 'Storage used',
    group: 'Library & cameras',
    hint: 'Disk space used by the library, and how much is free on the drive',
    defaultSpan: 2,
    render: (d) => (
      <StatCard
        label="Storage used"
        value={d.stats ? formatBytes(d.stats.storage_bytes) : '-'}
        hint={d.drives[0] ? `${fmtGB(d.drives[0].free_bytes)} free of ${fmtGB(d.drives[0].total_bytes)} on ${d.drives[0].drive}` : undefined}
      />
    )
  },
  {
    id: 'training-images',
    title: 'Training images',
    group: 'Training',
    hint: 'Images in the training set',
    defaultSpan: 1,
    render: (d) => <StatCard label="Training images" value={num(d.stats?.training_images)} />
  },
  {
    id: 'object-types',
    title: 'Object types',
    group: 'Training',
    hint: 'Kinds of object the detector knows',
    defaultSpan: 1,
    render: (d) => <StatCard label="Object types" value={num(d.stats?.object_types)} />
  },
  {
    id: 'annotations',
    title: 'Manual annotations',
    group: 'Training',
    hint: 'Boxes you have drawn by hand',
    defaultSpan: 1,
    render: (d) => <StatCard label="Manual annotations" value={num(d.stats?.manual_annotations)} />
  },
  {
    id: 'training-runs',
    title: 'Training runs',
    group: 'Training',
    hint: 'How many times the detector was trained',
    defaultSpan: 1,
    render: (d) => <StatCard label="Training runs" value={num(d.stats?.training_runs)} hint={d.stats ? `${d.stats.completed_training_runs} completed` : undefined} />
  },
  {
    id: 'map50',
    title: 'Latest mAP50',
    group: 'Training',
    hint: 'Accuracy of the latest training run',
    defaultSpan: 1,
    render: (d) => {
      const m = map50Of(d.training)
      return <StatCard label="Latest mAP50" value={m !== undefined ? m.toFixed(3) : '-'} hint={d.training?.latest_run ? `Run #${d.training.latest_run.id}` : undefined} />
    }
  }
]

export const WIDGET_BY_ID = new Map(WIDGETS.map((w) => [w.id, w]))

/**
 * The layout a fresh install starts with: five sections, each row adding up to four columns.
 * (What earlier versions started with is remembered in useDashboardLayout, to move people who never changed it to this one.)
 */
const LAYOUT_ROWS: [string, Span][] = [
  ['h-status', 4], ['backend', 1], ['gpu', 1], ['model', 1], ['pending', 1],
  ['h-sky', 4], ['tonight', 1], ['planets', 1], ['weather', 2],
  ['h-events', 4], ['events-tonight', 2], ['events-upcoming', 2], ['events-week', 4],
  ['h-space', 4], ['iss', 2], ['lightning', 2], ['traffic', 2],
  ['h-aurora', 4], ['aurora', 2], ['space-weather', 2], ['field-wind', 2], ['wind-forecast', 2],
  ['h-sun', 4], ['sun', 2], ['sun-activity', 2],
  ['h-library', 4], ['cameras', 2], ['library-images', 1], ['processed', 1], ['geotagged', 1], ['storage', 2],
  ['h-training', 4], ['training-images', 1], ['object-types', 1], ['annotations', 1], ['training-runs', 1], ['map50', 1]
]
export const DEFAULT_LAYOUT: { id: string; span: Span }[] = LAYOUT_ROWS.map(([id, span]) => ({ id, span }))

/** What the second-monitor window starts with: the live globe first, then the things worth watching. */
export const MONITOR_LAYOUT: { id: string; span: Span; h?: number }[] = [
  { id: 'earth-globe', span: 4, h: 720 },
  { id: 'iss', span: 2 },
  { id: 'lightning', span: 2 },
  { id: 'weather', span: 2 },
  { id: 'aurora', span: 2 },
  { id: 'space-weather', span: 2 },
  { id: 'sun-activity', span: 2 },
  { id: 'field-wind', span: 2 },
  { id: 'tonight', span: 1 },
  { id: 'planets', span: 1 },
  { id: 'wind-forecast', span: 2 }
]
