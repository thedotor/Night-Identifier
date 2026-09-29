import { useState, type ReactElement } from 'react'
import { CREDIT_SECTIONS, LIBRARIES, METHODS, type Credit } from '@renderer/lib/credits'

function CreditRow({ c }: { c: Credit }): ReactElement {
  return (
    <li className="py-2">
      <div className="text-sm text-text">{c.what}</div>
      <div className="mt-0.5 text-xs text-text-muted">
        {c.url ? (
          <a href={c.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            {c.source}
          </a>
        ) : (
          c.source
        )}
        {c.licence && <span> · {c.licence}</span>}
      </div>
    </li>
  )
}

export function About(): ReactElement {
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <div className="flex h-full flex-col overflow-y-auto p-8">
      <h1 className="text-xl font-semibold text-text">About</h1>
      <p className="mt-2 max-w-2xl text-sm text-text-muted">
        Night Identifier finds and names what is in your night-sky photographs, and shows what the sky, the Sun and the Earth are doing right now. It stands on the
        work of many observatories, agencies, volunteers and open-source projects. This page credits each one, section by section.
      </p>
      <p className="mt-2 max-w-2xl text-xs text-text-muted">
        Live data is fetched from these providers while the app is open. The app is not affiliated with or endorsed by any of them, and any errors are the app&apos;s
        own, not theirs.
      </p>

      <section className="mt-8 max-w-3xl">
        <h2 className="text-sm font-semibold text-text">Credits by section</h2>
        <div className="mt-3 space-y-2">
          {CREDIT_SECTIONS.map((s) => {
            const open = openId === s.id
            return (
              <div key={s.id} className="rounded-lg border border-border bg-surface">
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : s.id)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-text">{s.title}</div>
                    <div className="text-xs text-text-muted">{s.summary}</div>
                  </div>
                  <span className="text-[11px] text-text-muted">{s.credits.length}</span>
                  <span className="w-3 text-center text-xs text-text-muted">{open ? '▾' : '▸'}</span>
                </button>
                {open && (
                  <ul className="divide-y divide-border border-t border-border px-4">
                    {s.credits.map((c) => (
                      <CreditRow key={c.what + c.source} c={c} />
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      </section>

      <section className="mt-8 max-w-3xl">
        <h2 className="text-sm font-semibold text-text">Methods and models</h2>
        <p className="mt-1 text-xs text-text-muted">Worked out in the app from published papers and references.</p>
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface px-4">
          {METHODS.map((m) => (
            <li key={m.what} className="py-2">
              <div className="text-sm text-text">{m.what}</div>
              <div className="mt-0.5 text-xs text-text-muted">{m.ref}</div>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8 max-w-3xl">
        <h2 className="text-sm font-semibold text-text">Built with</h2>
        <ul className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
          {LIBRARIES.map((l) => (
            <li key={l.name} className="rounded-lg border border-border bg-surface px-4 py-2">
              <a href={l.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-accent hover:underline">
                {l.name}
              </a>
              <div className="text-xs text-text-muted">
                {l.what} · {l.licence}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-4 mt-8 max-w-3xl">
        <h2 className="text-sm font-semibold text-text">Good to know</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-text-muted">
          <li>Sentinel-2 close-up imagery (CC BY-NC-SA) and Blitzortung lightning data are for non-commercial use.</li>
          <li>Every photograph in the object browser shows its author and licence next to it.</li>
          <li>The Milky Way&apos;s spiral arms are a schematic model, not a survey.</li>
        </ul>
      </section>
    </div>
  )
}
