import type { ReactNode } from "react";
import { Logo } from "./logo";

/**
 * Gemeinsames Gerüst der Fehler- und 404-Seiten (src/app/not-found.tsx, error.tsx, global-error.tsx): Logo, Code,
 * Überschrift, Text, Aktionen (≥ 44 px, auf dem Handy volle Breite), Hinweis. Nur Theme-Tokens → hell und dunkel.
 * Keine Hooks – auch in global-error (eigenes Dokument) verwendbar.
 */
export function ErrorScreen({ code, title, children, actions, hint }: { code: string; title: string; children: ReactNode; actions?: ReactNode; hint?: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col bg-bg pt-[env(safe-area-inset-top)] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] text-text">
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 py-10">
        <Logo />
        <section aria-labelledby="fehler-titel" className="rounded-[var(--radius-card)] border border-border bg-surface p-6 sm:p-8">
          <p className="font-display text-sm font-semibold tracking-wide text-primary">{code}</p>
          <h1 id="fehler-titel" className="mt-1 font-display text-2xl font-semibold tracking-tight wrap-break-word sm:text-3xl">
            {title}
          </h1>
          <div className="mt-3 flex flex-col gap-2 text-[15px] leading-relaxed text-muted">{children}</div>
          {actions ? <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">{actions}</div> : null}
        </section>
        {hint ? <div className="px-1 text-[13px] leading-5 text-muted">{hint}</div> : null}
      </div>
    </main>
  );
}

/** Seiten, die Patient:innen sehen (Buchung, Praxis-Website, Portal, Anamnese-Link …) – dort Sie-Form, kein Weg in die Praxis-App */
const PATIENT = ["/buchen", "/p", "/portal", "/anamnese", "/aktion", "/abmelden"];
/** Öffentliche Website und Anmeldung (ohne Sitzung erreichbar) */
const PUBLIC = ["/login", "/einrichtung", "/kein-zugriff", "/agb", "/avv", "/datenschutz", "/impressum", "/preise", "/funktionen", "/sicherheit", "/unterauftragnehmer", "/vergleich", "/wechseln", "/wissen", "/app", "/offline"];

const under = (path: string, prefixes: string[]) => prefixes.some((p) => path === p || path.startsWith(p + "/"));

/** Wer sieht die Fehlerseite? Bestimmt Anrede und Rückwege. */
export function errorContext(path: string | null | undefined): "patient" | "public" | "app" {
  const p = (path ?? "").split(/[?#]/)[0] || "/";
  if (under(p, PATIENT)) return "patient";
  if (p === "/" || under(p, PUBLIC)) return "public";
  return "app";
}

export const errorBtnPrimary =
  "inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-[15px] font-semibold text-on-primary hover:bg-primary-hover cursor-pointer";
export const errorBtnSecondary =
  "inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-5 text-[15px] font-semibold text-text hover:bg-surface-2 cursor-pointer";
