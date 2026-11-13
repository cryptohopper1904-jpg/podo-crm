import type { Metadata } from "next";
import { WifiOff } from "lucide-react";
import { Logo } from "@/components/logo";
import { RetryButton } from "./retry-button";

export const metadata: Metadata = { title: "Keine Verbindung", robots: { index: false, follow: false } };

/** Für alle gleich, ohne Sitzung – der Service Worker speichert genau diese Seite vorab (src/lib/pwa/service-worker.ts). */
export const dynamic = "force-static";

/**
 * Ersatzseite, wenn eine Seite der installierten App ohne Internetverbindung aufgerufen wird. Der Service Worker
 * liefert sie unter der aufgerufenen Adresse aus; „Erneut versuchen“ lädt also die gewünschte Seite neu.
 * Bewusst ohne Praxis- oder Patientendaten: Diese werden auf dem Gerät nicht offline gespeichert.
 */
export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-[max(1rem,env(safe-area-inset-left))] py-[max(2.5rem,env(safe-area-inset-top))]">
      <div className="w-full max-w-md text-center">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-6 sm:p-8">
          <span className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-warn-soft text-warn-soft-text">
            <WifiOff size={26} aria-hidden />
          </span>
          <h1 className="font-display text-2xl font-semibold">Keine Internetverbindung</h1>
          <p className="mt-3 text-[15px] text-muted">
            PodoHero lädt Termine und Akten immer frisch vom Server. Aus Datenschutzgründen werden Praxis- und Patientendaten
            nicht auf diesem Gerät gespeichert – deshalb ist ohne Verbindung keine Ansicht möglich.
          </p>
          <p className="mt-3 text-[15px] text-muted">Sobald die Verbindung wieder steht, geht es automatisch weiter.</p>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <RetryButton />
            {/* bewusst <a>: volles Neuladen statt Client-Navigation */}
            <a
              href="/heute"
              className="inline-flex h-11 items-center justify-center rounded-xl border border-border bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2"
            >
              Zur Tagesübersicht
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
