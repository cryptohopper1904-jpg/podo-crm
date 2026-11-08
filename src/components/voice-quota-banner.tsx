import Link from "next/link";
import type { VoiceUsage } from "@/lib/voice-usage";

/** Fortschrittsbalken Minutenverbrauch (Server-Komponente). */
export function VoiceUsageBar({ usage }: { usage: VoiceUsage }) {
  const color = usage.exceeded ? "bg-danger" : usage.warn ? "bg-warn-soft-text" : "bg-primary";
  return (
    <div className="flex flex-col gap-1">
      <div
        className="h-3 w-full overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={usage.includedMinutes}
        aria-valuenow={Math.min(usage.usedMinutes, usage.includedMinutes)}
        aria-label="Verbrauchte Minuten KI-Telefon"
      >
        <div className={`h-full ${color}`} style={{ width: `${usage.percent}%` }} />
      </div>
      <p className="text-sm tabular-nums">
        {usage.usedMinutes} von {usage.includedMinutes} Minuten in diesem Monat
        {usage.exceeded ? " – Kontingent erschöpft" : ` – noch ${usage.remainingMinutes} Minuten`}
      </p>
    </div>
  );
}

/**
 * Hinweis für Inhaber:innen, wenn das Minutenkontingent erschöpft ist (oder fast).
 * Bei Erschöpfung bucht das KI-Telefon keine Termine mehr, sondern nimmt nur Rückrufbitten auf.
 */
export function VoiceQuotaBanner({ usage, link = true }: { usage: VoiceUsage; link?: boolean }) {
  if (!usage.exceeded && !usage.warn) return null;
  return (
    <p role="status" className={`rounded-xl p-4 text-sm ${usage.exceeded ? "bg-accent-soft text-accent-soft-text" : "bg-warn-soft text-warn-soft-text"}`}>
      {usage.exceeded ? (
        <>
          <strong>KI-Telefon: Minutenkontingent erschöpft</strong> ({usage.usedMinutes}/{usage.includedMinutes} Min.). Anrufende werden höflich vertröstet,
          es entstehen nur Rückrufbitten im Posteingang – keine Terminbuchungen. Ab dem 1. des nächsten Monats gilt wieder das volle Kontingent.
        </>
      ) : (
        <>
          <strong>KI-Telefon:</strong> {usage.percent} % der Minuten dieses Monats verbraucht ({usage.usedMinutes}/{usage.includedMinutes} Min.).
        </>
      )}{" "}
      {link ? <Link className="underline" href="/telefon">Zur Nutzung</Link> : null}
      {" · "}
      <Link className="underline" href="/einstellungen/abo">Tarif & Zusatzmodul</Link>
    </p>
  );
}
