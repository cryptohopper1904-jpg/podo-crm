import Link from "next/link";
import { saveCalendarOptionsAction } from "./actions";

/**
 * Hinweis „x Termine durch den Anzeige-Filter ausgeblendet“ mit Knopf „alle einblenden“ (einfache und vollständige
 * Ansicht). Setzt nur den Anzeige-Filter zurück (alle Behandler:innen des Teams und Hausbesuche wieder anzeigen) –
 * gemerkt wie im Anzeige-Panel; im Support-Modus nur über die Adresse (dort gibt es keinen Behandler:innen-Filter).
 */
export function FilterHint({
  hidden,
  reasons,
  persist,
  mode,
  nav,
  teamIds,
  supportHref,
}: {
  hidden: number;
  reasons: string;
  persist: boolean;
  mode: "simple" | "full";
  /** Rücksprung (datum, ansicht, ggf. modus) */
  nav: Record<string, string>;
  teamIds: readonly string[];
  /** Support-Modus: Adresse mit Hausbesuchen eingeblendet */
  supportHref: string;
}) {
  if (!hidden) return null;
  // Tippfläche 44 px hoch (Handy)
  const button = "inline-flex min-h-11 cursor-pointer items-center font-semibold text-text underline";
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted" data-testid="anzeige-filter-hinweis">
      <span>
        {hidden} Termin{hidden === 1 ? " ist" : "e sind"} durch den Anzeige-Filter ausgeblendet{reasons ? ` (${reasons})` : ""}.
      </span>
      {persist ? (
        <form action={saveCalendarOptionsAction} className="inline">
          {Object.entries(nav).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <input type="hidden" name="mode" value={mode} />
          <input type="hidden" name="hb" value="1" />
          {teamIds.map((id) => (
            <span key={id}>
              <input type="hidden" name="beh_alle" value={id} />
              <input type="hidden" name="beh" value={id} />
            </span>
          ))}
          <button type="submit" className={button}>
            Alle einblenden
          </button>
        </form>
      ) : (
        <Link href={supportHref} className={button}>
          Alle einblenden
        </Link>
      )}
    </div>
  );
}
