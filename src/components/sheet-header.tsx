import { PracticeLogo } from "./practice-logo";

/**
 * Kopf für Bögen und Ausdrucke (Anamnese, Doku, Akte): Titel, Praxisname, vorausgefüllte Kopfdaten
 * (Datum, Patient, Nummer …) und – falls hinterlegt – dezent das kompakte Praxis-Logo oben rechts.
 */
export function SheetHeader({ organizationId, practiceName, title, fields }: { organizationId: string; practiceName: string; title: string; fields: [string, string | null | undefined][] }) {
  const shown = fields.filter((f): f is [string, string] => !!f[1]);
  return (
    <header className="mb-6 border-b border-border pb-4 print:mb-4">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted">{practiceName}</p>
          <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        </div>
        <PracticeLogo organizationId={organizationId} kind="compact" alt={practiceName} className="h-12 w-auto max-w-24 opacity-80 print:h-10" />
      </div>
      {shown.length ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          {shown.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{k}</dt>
              <dd className="truncate text-lg font-semibold tabular-nums print:text-base">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </header>
  );
}
