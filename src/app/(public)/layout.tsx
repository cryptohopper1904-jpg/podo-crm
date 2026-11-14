import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Menu } from "lucide-react";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { LinkButton } from "@/components/ui";
import { publicSiteMetadata } from "./_content/site";

/**
 * Öffentliche Website (ohne Anmeldung). Indexierung erst einschalten, wenn Impressum/AGB/AVV
 * ausgefüllt und anwaltlich geprüft sind: PUBLIC_SITE_INDEX=true (und PUBLIC_URL gesetzt).
 * Metadaten zur Laufzeit: PUBLIC_URL/PUBLIC_SITE_INDEX sind Server-Variablen, beim Docker-Build nicht gesetzt.
 */
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  return publicSiteMetadata();
}

const NAV = [
  ["/funktionen", "Funktionen"],
  ["/preise", "Preise"],
  ["/vergleich", "Vergleich"],
  ["/wissen", "Wissen"],
  ["/sicherheit", "Sicherheit"],
] as const;

const RESOURCES = [
  ["/wechseln", "Wechseln zu PodoHero"],
  ["/vergleich", "Podologie-Software im Vergleich"],
  ["/wissen", "Wissen für Podologie-Praxen"],
  ["/wissen/sammelrechnung-und-quittung-podologie", "Sammelrechnung & Quittung"],
  ["/wissen/hygieneplan-podologie-checkliste", "Hygieneplan-Checkliste"],
  ["/app", "PodoHero als App"],
] as const;

const LEGAL = [
  ["/impressum", "Impressum"],
  ["/datenschutz", "Datenschutz"],
  ["/agb", "AGB"],
  ["/avv", "AVV"],
  ["/unterauftragnehmer", "Unterauftragnehmer"],
] as const;

/** Seitenabstand inkl. Safe-Area (iPhone quer: Kamera-Aussparung links/rechts, viewport-fit=cover) */
const SAFE_X = "pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))]";

export default function PublicLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#inhalt" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2 focus:font-semibold">
        Zum Inhalt springen
      </a>
      <header className="sticky top-0 z-40 border-b border-border bg-bg/90 backdrop-blur">
        <div className={`mx-auto flex h-16 max-w-6xl items-center gap-4 ${SAFE_X}`}>
          <Link href="/" aria-label="PodoHero – Startseite" className="shrink-0 rounded-lg">
            <Logo />
          </Link>
          <nav aria-label="Hauptnavigation" className="ml-4 hidden items-center gap-0.5 lg:flex">
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} className="rounded-lg px-3 py-2 text-[15px] font-medium text-muted hover:bg-surface-2 hover:text-text">
                {label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <LinkButton href="/login" variant="ghost" className="max-sm:hidden">Anmelden</LinkButton>
            <LinkButton href="/einrichtung" variant="accent" className="max-sm:hidden">Kostenlos testen</LinkButton>
            {/* Mobiles Menü ohne JavaScript (details/summary ist per Tastatur bedienbar) */}
            <details className="group relative lg:hidden">
              <summary className="inline-flex size-11 cursor-pointer list-none items-center justify-center rounded-xl border border-border bg-surface [&::-webkit-details-marker]:hidden" aria-label="Menü">
                <Menu size={20} aria-hidden />
              </summary>
              <nav aria-label="Mobile Navigation" className="absolute right-0 top-13 flex w-60 flex-col gap-1 rounded-[var(--radius-card)] border border-border bg-surface p-2 shadow-lg">
                {NAV.map(([href, label]) => (
                  <Link key={href} href={href} className="rounded-lg px-3 py-2.5 font-medium hover:bg-surface-2">{label}</Link>
                ))}
                <Link href="/wechseln" className="rounded-lg px-3 py-2.5 font-medium hover:bg-surface-2">Wechseln zu PodoHero</Link>
                <hr className="my-1 border-border" />
                <Link href="/login" className="rounded-lg px-3 py-2.5 font-medium hover:bg-surface-2">Anmelden</Link>
                <LinkButton href="/einrichtung" variant="accent">Kostenlos testen</LinkButton>
              </nav>
            </details>
          </div>
        </div>
      </header>

      <main id="inhalt" className="flex-1">{children}</main>

      <footer className="border-t border-border bg-surface">
        <div className={`mx-auto grid max-w-6xl grid-cols-1 gap-8 py-10 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1.3fr_1fr] ${SAFE_X}`}>
          <div>
            <Logo />
            <p className="mt-3 max-w-sm text-sm text-muted">
              Praxissoftware, gebaut nur für Podologie. Entwickelt in Deutschland, die Cloud läuft bei Hetzner in Deutschland.
            </p>
          </div>
          <nav aria-label="Produkt" className="flex flex-col gap-2 text-sm">
            <p className="font-semibold">Produkt</p>
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} className="text-muted hover:text-text">{label}</Link>
            ))}
            <Link href="/einrichtung" className="text-muted hover:text-text">Kostenlos testen</Link>
            <Link href="/login" className="text-muted hover:text-text">Anmelden</Link>
          </nav>
          <nav aria-label="Ressourcen" className="flex flex-col gap-2 text-sm">
            <p className="font-semibold">Ressourcen</p>
            {RESOURCES.map(([href, label]) => (
              <Link key={href} href={href} className="text-muted hover:text-text">{label}</Link>
            ))}
          </nav>
          <nav aria-label="Rechtliches" className="flex flex-col gap-2 text-sm">
            <p className="font-semibold">Rechtliches</p>
            {LEGAL.map(([href, label]) => (
              <Link key={href} href={href} className="text-muted hover:text-text">{label}</Link>
            ))}
          </nav>
        </div>
        <p className={`mx-auto max-w-6xl pb-8 text-xs text-muted ${SAFE_X}`}>
          Alle Preise zzgl. USt., Preise vorläufig. Rechtstexte sind Entwürfe und werden vor dem Start anwaltlich geprüft.
        </p>
      </footer>
    </div>
  );
}
