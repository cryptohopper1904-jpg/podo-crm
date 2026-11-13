import Link from "next/link";

/** Aufklappbare FAQ ohne JavaScript (details/summary) – passend zu /preise. */
export function FaqList({ items, id = "faq", title = "Häufige Fragen" }: { items: readonly (readonly [string, string])[]; id?: string; title?: string }) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="font-display text-2xl font-semibold">{title}</h2>
      <div className="mt-4 flex flex-col gap-3">
        {items.map(([q, a]) => (
          <details key={q} className="group rounded-[var(--radius-card)] border border-border bg-surface p-5">
            <summary className="cursor-pointer list-none font-semibold [&::-webkit-details-marker]:hidden">
              <span className="mr-2 inline-block text-primary transition-transform group-open:rotate-90" aria-hidden>›</span>
              {q}
            </summary>
            <p className="mt-3 text-[15px] text-muted">{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

/** Brotkrumen-Navigation (sichtbar) – das JSON-LD dazu liefert breadcrumbLd(). */
export function Breadcrumbs({ trail }: { trail: readonly { name: string; path: string }[] }) {
  return (
    <nav aria-label="Brotkrumen" className="text-sm text-muted">
      <ol className="flex flex-wrap items-center gap-1.5">
        <li><Link href="/" className="hover:text-text hover:underline">Startseite</Link></li>
        {trail.map((t, i) => (
          <li key={t.path} className="flex items-center gap-1.5">
            <span aria-hidden>›</span>
            {i === trail.length - 1 ? <span aria-current="page" className="text-text">{t.name}</span> : <Link href={t.path} className="hover:text-text hover:underline">{t.name}</Link>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
