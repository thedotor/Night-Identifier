import { useEffect, useRef, type ReactElement } from 'react'

interface Star {
  /** Position as a fraction of the viewport, so the field refills the screen after a resize. */
  fx: number
  fy: number
  radius: number
  baseAlpha: number
  twinkleSpeed: number
  twinklePhase: number
}

interface ShootingStar {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
}

interface Satellite {
  x: number
  y: number
  vx: number
  vy: number
  blinkPhase: number
}

interface Galaxy {
  /** Position as a fraction of the viewport, so galaxies survive resizes. */
  fx: number
  fy: number
  radius: number
  sprite: HTMLCanvasElement
  orientation: number
  tilt: number
  rotation: number
  rotationSpeed: number
  alpha: number
}

interface GalaxyPalette {
  core: [number, number, number]
  inner: [number, number, number]
  outer: [number, number, number]
}

const PALETTES: GalaxyPalette[] = [
  { core: [255, 240, 210], inner: [170, 190, 255], outer: [110, 90, 220] },
  { core: [255, 235, 200], inner: [255, 170, 190], outer: [150, 90, 200] },
  { core: [235, 245, 255], inner: [120, 210, 255], outer: [70, 110, 230] }
]

const gaussian = (): number => {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * Pre-renders a face-on spiral galaxy (logarithmic arms of scattered stars, a
 * dusty halo and a bright core) so the animation loop only has to blit it.
 */
function renderGalaxySprite(radius: number, palette: GalaxyPalette, arms: number): HTMLCanvasElement {
  const size = Math.ceil(radius * 2)
  const sprite = document.createElement('canvas')
  sprite.width = size
  sprite.height = size
  const c = sprite.getContext('2d')
  if (!c) return sprite
  const mid = size / 2
  const rgb = (col: [number, number, number], a: number): string =>
    `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${a})`
  const mix = (a: number[], b: number[], t: number): [number, number, number] => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ]

  c.globalCompositeOperation = 'lighter'

  // Faint diffuse halo
  const halo = c.createRadialGradient(mid, mid, 0, mid, mid, radius)
  halo.addColorStop(0, rgb(palette.inner, 0.22))
  halo.addColorStop(0.5, rgb(palette.outer, 0.07))
  halo.addColorStop(1, rgb(palette.outer, 0))
  c.fillStyle = halo
  c.fillRect(0, 0, size, size)

  // Spiral arms: soft glow blobs first, then fine star points on top
  const wind = 3.2
  const armCount = arms
  const blobs = 260
  for (let i = 0; i < blobs; i++) {
    const t = Math.pow(Math.random(), 0.8)
    const arm = i % armCount
    const theta = t * wind + (arm * Math.PI * 2) / armCount
    const r = t * radius * 0.92
    const scatter = (0.02 + t * 0.06) * radius
    const x = mid + Math.cos(theta) * r + gaussian() * scatter
    const y = mid + Math.sin(theta) * r + gaussian() * scatter
    const br = radius * (0.05 + Math.random() * 0.07)
    const col = mix(palette.inner, palette.outer, t)
    const g = c.createRadialGradient(x, y, 0, x, y, br)
    g.addColorStop(0, rgb(col, 0.10 * (1 - t * 0.6)))
    g.addColorStop(1, rgb(col, 0))
    c.fillStyle = g
    c.fillRect(x - br, y - br, br * 2, br * 2)
  }

  const points = Math.floor(radius * 30)
  for (let i = 0; i < points; i++) {
    const t = Math.pow(Math.random(), 0.7)
    const arm = Math.floor(Math.random() * armCount)
    const theta = t * wind + (arm * Math.PI * 2) / armCount
    const r = t * radius * 0.95
    const scatter = (0.015 + t * 0.07) * radius
    const x = mid + Math.cos(theta) * r + gaussian() * scatter
    const y = mid + Math.sin(theta) * r + gaussian() * scatter
    const col = mix(palette.core, palette.outer, Math.min(1, t * 1.2))
    c.fillStyle = rgb(col, 0.25 + Math.random() * 0.6)
    c.fillRect(x, y, Math.random() < 0.1 ? 1.6 : 0.9, Math.random() < 0.1 ? 1.6 : 0.9)
  }

  // Dust lanes: darken along the inside edge of each arm
  c.globalCompositeOperation = 'source-over'
  for (let i = 0; i < 90; i++) {
    const t = 0.15 + Math.random() * 0.7
    const arm = i % armCount
    const theta = t * wind + (arm * Math.PI * 2) / armCount - 0.28
    const r = t * radius * 0.92
    const x = mid + Math.cos(theta) * r
    const y = mid + Math.sin(theta) * r
    const br = radius * (0.04 + Math.random() * 0.04)
    const g = c.createRadialGradient(x, y, 0, x, y, br)
    g.addColorStop(0, 'rgba(4, 5, 12, 0.10)')
    g.addColorStop(1, 'rgba(4, 5, 12, 0)')
    c.fillStyle = g
    c.fillRect(x - br, y - br, br * 2, br * 2)
  }

  // Bright core and bulge
  c.globalCompositeOperation = 'lighter'
  const bulge = c.createRadialGradient(mid, mid, 0, mid, mid, radius * 0.32)
  bulge.addColorStop(0, rgb(palette.core, 0.95))
  bulge.addColorStop(0.25, rgb(palette.core, 0.5))
  bulge.addColorStop(0.6, rgb(palette.inner, 0.16))
  bulge.addColorStop(1, rgb(palette.inner, 0))
  c.fillStyle = bulge
  c.fillRect(0, 0, size, size)

  return sprite
}

interface Moon {
  radius: number
  orbitRadius: number
  angle: number
  speed: number
  color: string
}

interface Planet {
  fx: number
  fy: number
  radius: number
  color: string
  bands: string[] | null
  atmosphere: string | null
  ring: { tilt: number; inner: number; outer: number; color: [number, number, number] } | null
  moons: Moon[]
}

interface BlackHole {
  fx: number
  fy: number
  radius: number
  disk: HTMLCanvasElement
  orientation: number
  tilt: number
  spin: number
  spinSpeed: number
}

/** Draws a lit sphere with the light coming from the upper left. */
function drawSphere(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  bands: string[] | null
): void {
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.clip()
  ctx.fillStyle = color
  ctx.fillRect(x - r, y - r, r * 2, r * 2)
  if (bands) {
    const h = (r * 2) / bands.length
    bands.forEach((b, i) => {
      ctx.fillStyle = b
      ctx.fillRect(x - r, y - r + i * h, r * 2, h)
    })
  }
  const lx = x - r * 0.45
  const ly = y - r * 0.45
  const shade = ctx.createRadialGradient(lx, ly, r * 0.1, lx, ly, r * 1.7)
  shade.addColorStop(0, 'rgba(255, 255, 255, 0.18)')
  shade.addColorStop(0.35, 'rgba(0, 0, 8, 0)')
  shade.addColorStop(0.75, 'rgba(0, 0, 8, 0.6)')
  shade.addColorStop(1, 'rgba(0, 0, 8, 0.92)')
  ctx.fillStyle = shade
  ctx.fillRect(x - r, y - r, r * 2, r * 2)
  ctx.restore()
}

function drawRingHalf(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  planet: Planet,
  front: boolean
): void {
  const ring = planet.ring
  if (!ring) return
  const [cr, cg, cb] = ring.color
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(ring.tilt)
  const steps = 7
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1)
    const rr = planet.radius * (ring.inner + (ring.outer - ring.inner) * t)
    const a = (i % 3 === 1 ? 0.25 : 0.5) * (1 - t * 0.4)
    ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${a})`
    ctx.lineWidth = (planet.radius * (ring.outer - ring.inner)) / steps + 0.4
    ctx.beginPath()
    ctx.ellipse(0, 0, rr, rr * 0.28, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

function drawPlanet(ctx: CanvasRenderingContext2D, p: Planet, x: number, y: number): void {
  if (p.atmosphere) {
    const glow = ctx.createRadialGradient(x, y, p.radius * 0.9, x, y, p.radius * 1.5)
    glow.addColorStop(0, p.atmosphere)
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(x, y, p.radius * 1.5, 0, Math.PI * 2)
    ctx.fill()
  }
  const moonPos = (m: Moon): { mx: number; my: number; front: boolean } => ({
    mx: x + Math.cos(m.angle) * m.orbitRadius,
    my: y + Math.sin(m.angle) * m.orbitRadius * 0.3,
    front: Math.sin(m.angle) > 0
  })
  // Behind the planet: moons on the far side of their orbit, then the back of the ring
  for (const m of p.moons) {
    const { mx, my, front } = moonPos(m)
    if (!front) drawSphere(ctx, mx, my, m.radius, m.color, null)
  }
  drawRingHalf(ctx, x, y, p, false)
  drawSphere(ctx, x, y, p.radius, p.color, p.bands)
  drawRingHalf(ctx, x, y, p, true)
  for (const m of p.moons) {
    const { mx, my, front } = moonPos(m)
    if (front) drawSphere(ctx, mx, my, m.radius, m.color, null)
  }
}

/** Pre-renders a glowing, swirling accretion disk (face-on). */
function renderDiskSprite(radius: number): HTMLCanvasElement {
  const size = Math.ceil(radius * 2)
  const sprite = document.createElement('canvas')
  sprite.width = size
  sprite.height = size
  const c = sprite.getContext('2d')
  if (!c) return sprite
  const mid = size / 2
  c.globalCompositeOperation = 'lighter'
  const glow = c.createRadialGradient(mid, mid, radius * 0.25, mid, mid, radius)
  glow.addColorStop(0, 'rgba(255, 200, 120, 0.55)')
  glow.addColorStop(0.35, 'rgba(255, 120, 40, 0.28)')
  glow.addColorStop(1, 'rgba(160, 40, 20, 0)')
  c.fillStyle = glow
  c.fillRect(0, 0, size, size)
  for (let i = 0; i < 1400; i++) {
    const t = Math.pow(Math.random(), 1.6)
    const r = radius * (0.3 + t * 0.7)
    const a0 = Math.random() * Math.PI * 2
    // Short arcs read as motion streaks around the hole
    const len = 0.05 + Math.random() * 0.25
    const heat = 1 - t
    c.strokeStyle = `rgba(255, ${Math.round(150 + heat * 100)}, ${Math.round(60 + heat * 150)}, ${(0.15 + Math.random() * 0.4).toFixed(2)})`
    c.lineWidth = 0.6 + Math.random() * 1.1
    c.beginPath()
    c.arc(mid, mid, r, a0, a0 + len)
    c.stroke()
  }
  return sprite
}

function drawBlackHole(ctx: CanvasRenderingContext2D, b: BlackHole, x: number, y: number): void {
  const r = b.radius
  const diskR = r * 3.4
  const drawDisk = (frontOnly: boolean): void => {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(b.orientation)
    ctx.scale(1, b.tilt)
    if (frontOnly) {
      ctx.beginPath()
      ctx.rect(-diskR, 0, diskR * 2, diskR)
      ctx.clip()
    }
    ctx.rotate(b.spin)
    ctx.drawImage(b.disk, -diskR, -diskR, diskR * 2, diskR * 2)
    ctx.restore()
  }

  drawDisk(false)

  // Event horizon
  ctx.fillStyle = '#000'
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()

  // Photon ring: light bent around the hole
  ctx.save()
  ctx.translate(x, y)
  for (const [w, a] of [
    [5, 0.18],
    [2, 0.75]
  ] as const) {
    ctx.strokeStyle = `rgba(255, 190, 110, ${a})`
    ctx.lineWidth = w
    ctx.beginPath()
    ctx.arc(0, 0, r * 1.12, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()

  // Near half of the disk passes in front of the hole
  drawDisk(true)
}

/**
 * Full-screen animated splash: starfield, drifting satellites, occasional
 * shooting stars, slowly-rotating galaxies, planets with orbiting moons, and a
 * black hole. Stays mounted for exactly as
 * long as the caller keeps it mounted (App unmounts it once startup finishes).
 */
export function SplashScreen(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let width = 0
    let height = 0
    let dpr = Math.min(window.devicePixelRatio || 1, 2)

    const resize = (): void => {
      width = window.innerWidth
      height = window.innerHeight
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const stars: Star[] = Array.from({ length: 220 }, () => ({
      fx: Math.random(),
      fy: Math.random(),
      radius: Math.random() * 1.4 + 0.3,
      baseAlpha: Math.random() * 0.6 + 0.3,
      twinkleSpeed: Math.random() * 1.5 + 0.4,
      twinklePhase: Math.random() * Math.PI * 2
    }))

    // Spread across the edges so they frame (rather than sit behind) the title
    const slots = [
      { fx: 0.16, fy: 0.24 },
      { fx: 0.84, fy: 0.72 },
      { fx: 0.8, fy: 0.16 }
    ]
    const galaxies: Galaxy[] = slots.map((slot, i) => {
      const radius = i === 0 ? 170 : i === 1 ? 150 : 100
      return {
        fx: slot.fx,
        fy: slot.fy,
        radius,
        sprite: renderGalaxySprite(radius, PALETTES[i % PALETTES.length], i === 2 ? 3 : 2),
        orientation: Math.random() * Math.PI,
        tilt: 0.35 + Math.random() * 0.3,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() < 0.5 ? -1 : 1) * (0.03 + Math.random() * 0.03),
        alpha: i === 2 ? 0.6 : 0.85
      }
    })

    const planets: Planet[] = [
      {
        // Blue-green world with two moons
        fx: 0.13,
        fy: 0.74,
        radius: 44,
        color: '#2d6a8f',
        bands: [
          'rgba(60, 150, 110, 0.35)',
          'rgba(230, 240, 250, 0.22)',
          'rgba(40, 110, 160, 0.1)',
          'rgba(70, 160, 120, 0.3)',
          'rgba(230, 240, 250, 0.18)'
        ],
        atmosphere: 'rgba(110, 190, 255, 0.28)',
        ring: null,
        moons: [
          { radius: 8, orbitRadius: 82, angle: 0.8, speed: 0.35, color: '#b8b8c0' },
          { radius: 4.5, orbitRadius: 112, angle: 3.9, speed: -0.22, color: '#8f8a84' }
        ]
      },
      {
        // Ringed gas giant
        fx: 0.6,
        fy: 0.14,
        radius: 26,
        color: '#c9a06a',
        bands: [
          'rgba(150, 100, 60, 0.4)',
          'rgba(240, 215, 170, 0.35)',
          'rgba(160, 110, 70, 0.4)',
          'rgba(235, 205, 160, 0.3)',
          'rgba(140, 95, 60, 0.4)',
          'rgba(220, 190, 150, 0.25)'
        ],
        atmosphere: 'rgba(230, 180, 110, 0.14)',
        ring: { tilt: -0.3, inner: 1.4, outer: 2.1, color: [225, 205, 170] },
        moons: [{ radius: 3.5, orbitRadius: 74, angle: 2.2, speed: 0.5, color: '#a7a19a' }]
      },
      {
        // Small rusty world
        fx: 0.9,
        fy: 0.46,
        radius: 15,
        color: '#a8492f',
        bands: ['rgba(120, 50, 30, 0.35)', 'rgba(210, 130, 90, 0.2)', 'rgba(110, 45, 30, 0.3)'],
        atmosphere: 'rgba(230, 120, 80, 0.16)',
        ring: null,
        moons: [{ radius: 3, orbitRadius: 36, angle: 5.1, speed: 0.7, color: '#b3aca5' }]
      }
    ]

    const blackHole: BlackHole = {
      fx: 0.36,
      fy: 0.9,
      radius: 20,
      disk: renderDiskSprite(20 * 3.4),
      orientation: -0.2,
      tilt: 0.28,
      spin: 0,
      spinSpeed: 0.6
    }

    const satellites: Satellite[] = Array.from({ length: 3 }, () => {
      const edge = Math.floor(Math.random() * 4)
      const speed = Math.random() * 20 + 15
      const start =
        edge === 0
          ? { x: -20, y: Math.random() * height }
          : edge === 1
            ? { x: width + 20, y: Math.random() * height }
            : edge === 2
              ? { x: Math.random() * width, y: -20 }
              : { x: Math.random() * width, y: height + 20 }
      const angle = Math.atan2(height / 2 - start.y, width / 2 - start.x) + (Math.random() - 0.5)
      return {
        x: start.x,
        y: start.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        blinkPhase: Math.random() * Math.PI * 2
      }
    })

    let shootingStars: ShootingStar[] = []
    let shootingStarCooldown = Math.random() * 2 + 1.5

    let raf = 0
    let last = performance.now()

    const draw = (now: number): void => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now

      ctx.clearRect(0, 0, width, height)
      const grad = ctx.createLinearGradient(0, 0, 0, height)
      grad.addColorStop(0, '#04050a')
      grad.addColorStop(1, '#0b0e1c')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, width, height)

      // Galaxies
      for (const g of galaxies) {
        g.rotation += g.rotationSpeed * dt
        ctx.save()
        ctx.translate(g.fx * width, g.fy * height)
        ctx.rotate(g.orientation)
        ctx.scale(1, g.tilt)
        ctx.rotate(g.rotation)
        ctx.globalAlpha = g.alpha
        ctx.drawImage(g.sprite, -g.radius, -g.radius)
        ctx.restore()
      }

      // Stars
      for (const s of stars) {
        s.twinklePhase += s.twinkleSpeed * dt
        const alpha = s.baseAlpha * (0.6 + 0.4 * Math.sin(s.twinklePhase))
        ctx.beginPath()
        ctx.fillStyle = `rgba(226, 232, 240, ${alpha.toFixed(3)})`
        ctx.arc(s.fx * width, s.fy * height, s.radius, 0, Math.PI * 2)
        ctx.fill()
      }

      // Planets and moons
      for (const p of planets) {
        for (const m of p.moons) m.angle += m.speed * dt
        drawPlanet(ctx, p, p.fx * width, p.fy * height)
      }

      // Black hole
      blackHole.spin += blackHole.spinSpeed * dt
      drawBlackHole(ctx, blackHole, blackHole.fx * width, blackHole.fy * height)

      // Satellites
      for (const sat of satellites) {
        sat.x += sat.vx * dt
        sat.y += sat.vy * dt
        sat.blinkPhase += dt * 4
        if (sat.x < -30 || sat.x > width + 30 || sat.y < -30 || sat.y > height + 30) {
          sat.x = Math.random() * width
          sat.y = -20
        }
        const blink = (Math.sin(sat.blinkPhase) + 1) / 2
        ctx.beginPath()
        ctx.fillStyle = `rgba(255, 255, 255, ${(0.4 + 0.6 * blink).toFixed(3)})`
        ctx.arc(sat.x, sat.y, 1.6, 0, Math.PI * 2)
        ctx.fill()
      }

      // Shooting stars
      shootingStarCooldown -= dt
      if (shootingStarCooldown <= 0) {
        shootingStarCooldown = Math.random() * 4 + 2.5
        const startX = Math.random() * width * 0.6
        const startY = Math.random() * height * 0.4
        const speed = Math.random() * 500 + 400
        const angle = Math.PI / 4 + (Math.random() - 0.5) * 0.3
        shootingStars.push({
          x: startX,
          y: startY,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0,
          maxLife: Math.random() * 0.4 + 0.4
        })
      }
      shootingStars = shootingStars.filter((sh) => sh.life < sh.maxLife)
      for (const sh of shootingStars) {
        sh.life += dt
        sh.x += sh.vx * dt
        sh.y += sh.vy * dt
        const tailX = sh.x - sh.vx * 0.05
        const tailY = sh.y - sh.vy * 0.05
        const fade = 1 - sh.life / sh.maxLife
        const grad2 = ctx.createLinearGradient(sh.x, sh.y, tailX, tailY)
        grad2.addColorStop(0, `rgba(255, 255, 255, ${fade})`)
        grad2.addColorStop(1, 'rgba(255, 255, 255, 0)')
        ctx.strokeStyle = grad2
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(sh.x, sh.y)
        ctx.lineTo(tailX, tailY)
        ctx.stroke()
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#04050a]">
      <canvas ref={canvasRef} className="absolute inset-0" />
      <div className="relative flex flex-col items-center gap-3">
        <div className="text-2xl font-semibold tracking-[0.2em] text-slate-100">
          NIGHT IDENTIFIER
        </div>
        <div className="text-xs tracking-[0.3em] text-slate-400">STARTING UP</div>
        <div className="mt-2 h-0.5 w-40 overflow-hidden rounded-full bg-white/10">
          <div className="h-full w-1/3 animate-[splash-loading_1.2s_ease-in-out_infinite] bg-sky-400" />
        </div>
      </div>
      <style>{`
        @keyframes splash-loading {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  )
}
