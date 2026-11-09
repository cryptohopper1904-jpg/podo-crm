import Link from "next/link";
import { Mail, Phone } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { telHref } from "@/lib/website";
import type { PublicSite } from "@/server/website";

/**
 * Hülle der Praxis-Website: flaches Design über die Design-Tokens (hell/dunkel), ohne Cookies,
 * ohne Tracking und ohne eingebettete Drittanbieter-Inhalte (Karte nur als Link).
 */
export function SiteShell({ site, children }: { site: PublicSite; children: React.ReactNode }) {
  const tel = telHref(site.phone);
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#inhalt" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2 focus:font-semibold">
        Zum Inhalt springen
      </a>
      <header className="sticky top-0 z-30 border-b border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center gap-3 px-4 sm:px-6">
          <Link href={`/p/${site.slug}`} className="min-w-0 truncate font-display text-lg font-semibold">{site.name}</Link>
          <nav aria-label="Kontakt" className="ml-auto flex items-center gap-2">
            {tel ? (
              <a href={tel} className="hidden items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold hover:bg-surface-2 sm:inline-flex">
                <Phone size={16} aria-hidden /> {site.phone}
              </a>
            ) : null}
            {site.onlineBooking ? (
              <a href={`/buchen/${site.slug}`} className="inline-flex h-11 items-center rounded-xl bg-accent px-4 text-[15px] font-semibold text-on-accent hover:bg-accent-hover">
                Termin buchen
              </a>
            ) : null}
            <ThemeToggle />
          </nav>
        </div>
      </header>
      <main id="inhalt" className="flex-1">{children}</main>
      <footer className="border-t border-border bg-surface">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-8 text-sm sm:flex-row sm:items-center sm:px-6">
          <div className="flex flex-col gap-1">
            <p className="font-semibold">{site.name}</p>
            {site.street ? <p className="text-muted">{site.street}, {site.zip} {site.city}</p> : null}
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-muted">
              {tel ? <a href={tel} className="inline-flex items-center gap-1 hover:text-text"><Phone size={14} aria-hidden /> {site.phone}</a> : null}
              {site.email ? <a href={`mailto:${site.email}`} className="inline-flex items-center gap-1 hover:text-text"><Mail size={14} aria-hidden /> {site.email}</a> : null}
            </p>
          </div>
          <nav aria-label="Rechtliches" className="flex gap-4 sm:ml-auto">
            <Link href={`/p/${site.slug}/impressum`} className="font-medium hover:text-primary">Impressum</Link>
            <Link href={`/p/${site.slug}/datenschutz`} className="font-medium hover:text-primary">Datenschutz</Link>
          </nav>
        </div>
        <p className="pb-6 text-center text-xs text-muted">Diese Seite verwendet keine Cookies und kein Tracking.</p>
      </footer>
    </div>
  );
}

export const SITE_ROBOTS = { index: true, follow: true } as const;
