// What to ask the user for when adding a camera by address, per camera type.

export interface FormField {
  key: string
  label: string
  placeholder?: string
  secret?: boolean
  number?: boolean
  optional?: boolean
}

export interface KindForm {
  kind: string
  label: string
  help: string
  fields: FormField[]
  /** ask the server at this address which cameras it offers, instead of typing a device by hand */
  probe?: boolean
  /** ask the camera itself (ONVIF) for its stream addresses */
  onvif?: boolean
}

export const KIND_FORMS: KindForm[] = [
  {
    kind: 'rtsp',
    label: 'IP / security camera (RTSP)',
    help: 'Most IP cameras (Reolink, Hikvision, Dahua, Amcrest, TP-Link...). The address looks like rtsp://192.168.1.20:554/stream1. Check the camera\'s manual for its stream path.',
    fields: [
      { key: 'url', label: 'Stream address', placeholder: 'rtsp://192.168.1.20:554/stream1' },
      { key: 'username', label: 'Username', optional: true },
      { key: 'password', label: 'Password', secret: true, optional: true }
    ]
  },
  {
    kind: 'mjpeg',
    label: 'Network camera (MJPEG stream)',
    help: 'A web camera that streams motion-JPEG over HTTP, e.g. http://192.168.1.30:8080/video (Raspberry Pi cameras, many all-sky cameras).',
    fields: [
      { key: 'url', label: 'Stream address', placeholder: 'http://192.168.1.30:8080/video' },
      { key: 'username', label: 'Username', optional: true },
      { key: 'password', label: 'Password', secret: true, optional: true }
    ]
  },
  {
    kind: 'snapshot',
    label: 'Network camera (JPEG snapshot URL)',
    help: 'A web address that returns the latest picture each time it is opened. The app fetches it every few seconds.',
    fields: [
      { key: 'url', label: 'Image address', placeholder: 'http://allsky.local/image.jpg' },
      { key: 'interval_s', label: 'Refresh every (seconds)', placeholder: '2', number: true, optional: true },
      { key: 'username', label: 'Username', optional: true },
      { key: 'password', label: 'Password', secret: true, optional: true }
    ]
  }
]

KIND_FORMS.splice(0, 0, {
  kind: 'onvif',
  label: 'IP / security camera: find the stream for me (ONVIF)',
  help: "Enter the camera's IP address and login and the app asks the camera for its video streams. Easiest way to add most modern IP cameras. Some cameras need ONVIF switched on, or a separate ONVIF user, in their settings.",
  onvif: true,
  fields: [
    { key: 'host', label: 'Camera address', placeholder: '192.168.1.20' },
    { key: 'port', label: 'ONVIF port', placeholder: '80', number: true, optional: true },
    { key: 'username', label: 'Username', optional: true },
    { key: 'password', label: 'Password', secret: true, optional: true }
  ]
})

KIND_FORMS.push(
  {
    kind: 'alpaca',
    label: 'Astro camera on the network (ASCOM Alpaca)',
    help: "For an Alpaca server: NINA or ASCOM Remote on another PC, a vendor's Alpaca app, or the ASCOM simulators. Enter its address (the port is usually 11111) and press 'Find cameras'.",
    probe: true,
    fields: [
      { key: 'host', label: 'Server address', placeholder: '192.168.1.40' },
      { key: 'port', label: 'Port', placeholder: '11111', number: true, optional: true }
    ]
  },
  {
    kind: 'indi',
    label: 'Astro camera on the network (INDI)',
    help: "For an INDI server such as StellarMate or a Raspberry Pi running indiserver. Enter its address (port 7624) and press 'Find cameras'. ZWO's ASIAir uses a private protocol and cannot be used this way.",
    probe: true,
    fields: [
      { key: 'host', label: 'Server address', placeholder: 'stellarmate.local' },
      { key: 'port', label: 'Port', placeholder: '7624', number: true, optional: true }
    ]
  }
)

export function formFor(kind: string): KindForm | undefined {
  return KIND_FORMS.find((f) => f.kind === kind)
}
