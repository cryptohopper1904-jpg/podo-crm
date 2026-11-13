import Link from "next/link";
import type { CSSProperties } from "react";
import { Ban } from "lucide-react";
import { blockTime, describeBlock, type BlockOccurrence } from "@/lib/calendar-blocks";
import { layoutLanes, SLOT_MIN, toHhmm } from "@/lib/calendar-grid";

/**
 * Darstellung der Kalender-Sperrzeiten (Pause, Schulung, früher Feierabend, Wartung, Reinigung …).
 * Eigene Komponente, damit die Kalenderansicht (full-calendar.tsx) nur an wenigen Stellen eingreift.
 * Nur Anzeige – die Verfügbarkeit (Buchung, freie Zeiten, Konfliktprüfung) gilt unabhängig von der Anzeige-Option.
 */

type Team = readonly { id: string; name: string }[];
type Board = { team: Team; blocks: readonly BlockOccurrence[] };

/** 16 px je 15 Minuten – wie in full-calendar.tsx */
const PX_PER_MIN = 16 / SLOT_MIN;
const px = (min: number) => `${Math.round(min * PX_PER_MIN)}px`;

export const BLOCK_HATCH: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(45deg, color-mix(in srgb, var(--muted) 30%, transparent) 0 3px, transparent 3px 8px)",
};

/** Link zur Sperrzeit (Ansicht/Bearbeiten) mit dem Datum des Vorkommens */
export const blockHref = (o: Pick<BlockOccurrence, "blockId" | "dateIso">) => `/kalender/sperrzeit/${o.blockId}?datum=${o.dateIso}`;

/** „Pause 12:00–12:30 · Anna (Serie)“ */
function blockTitle(o: BlockOccurrence, team: Team) {
  const who = o.userId ? (team.find((t) => t.id === o.userId)?.name ?? "Person") : "ganze Praxis";
  return `Sperrzeit: ${describeBlock(o)} · ${who}${o.series ? " · Serie" : ""} – nicht verfügbar`;
}

/**
 * Welche Sperrzeiten in einer Spalte erscheinen: Behandler:in-Spalte → eigene + ganze Praxis;
 * Wochenspalte ohne feste Person („all“) → alle des Tages; „none“ (z. B. „Ohne Zuordnung“) → keine.
 */
export function columnBlocks(board: Board, target: string | "all" | "none", dateIso: string): BlockOccurrence[] {
  if (target === "none") return [];
  return board.blocks.filter((o) => o.dateIso === dateIso && (target === "all" || o.userId === null || o.userId === target));
}

/**
 * Sperrzeiten als schraffierte Blöcke in einer Spalte der Zeitachse (Tag/Woche). Die Fläche lässt Zeiger durch
 * (Termine ziehen/ablegen, Klick auf die Zeit → neuer Termin mit Konflikthinweis); nur die Beschriftung öffnet die Sperrzeit.
 */
export function BlockOverlays({
  board,
  target,
  dateIso,
  range,
  showPerson,
}: {
  board: Board;
  target: string | "all" | "none";
  dateIso: string;
  range: { startMin: number; endMin: number };
  /** Vorname der Person anzeigen (Woche mit mehreren Behandler:innen) */
  showPerson: boolean;
}) {
  const items = columnBlocks(board, target, dateIso)
    .map((o) => ({ o, startMin: Math.max(o.startMin, range.startMin), endMin: Math.min(o.endMin, range.endMin) }))
    .filter((x) => x.endMin > x.startMin);
  if (!items.length) return null;
  // Praxisweite Sperrzeiten über die volle Breite, personenbezogene nebeneinander (wie Termine)
  const whole = items.filter((x) => x.o.userId === null || !showPerson).map((x) => ({ ...x, lane: 0, lanes: 1 }));
  const perPerson = layoutLanes(items.filter((x) => x.o.userId !== null && showPerson));
  return (
    <>
      {[...whole, ...perPerson].map(({ o, startMin, endMin, lane, lanes }) => {
        const h = (endMin - startMin) * PX_PER_MIN;
        const person = o.userId ? board.team.find((t) => t.id === o.userId)?.name.split(" ")[0] : null;
        return (
          <Link
            key={`${o.blockId}-${o.dateIso}-${o.userId ?? "p"}`}
            href={blockHref(o)}
            title={blockTitle(o, board.team)}
            aria-label={blockTitle(o, board.team)}
            data-testid="sperrzeit"
            className="pointer-events-none absolute z-[1] flex flex-col overflow-hidden rounded-md border border-dashed border-border-strong bg-surface-2/85 p-0.5 text-[11px] leading-tight text-muted outline-offset-1 focus-visible:z-[4]"
            style={{
              ...BLOCK_HATCH,
              top: px(startMin - range.startMin),
              height: `${Math.max(12, Math.round(h) - 1)}px`,
              left: `calc(${(lane / lanes) * 100}% + 2px)`,
              width: `calc(${100 / lanes}% - 4px)`,
            }}
          >
            <span className="pointer-events-auto flex min-w-0 max-w-full cursor-pointer flex-col self-start rounded bg-surface/90 px-1 py-px hover:ring-1 hover:ring-border-strong">
              <span className="flex min-w-0 items-center gap-1 font-semibold text-text">
                <Ban size={11} className="shrink-0 text-muted" aria-hidden />
                <span className="truncate">{o.label}</span>
              </span>
              {h >= 28 ? <span className="truncate tabular-nums">{blockTime(o)}{showPerson ? ` · ${person ?? "alle"}` : ""}</span> : null}
            </span>
          </Link>
        );
      })}
    </>
  );
}

/** Monatsansicht: ein kleiner Hinweis je Tag („⦸ 12:00 Pause +1“), Details im Tooltip bzw. in der Tagesansicht. */
export function MonthBlockHints({ board, dateIso, dayHref }: { board: Board; dateIso: string; dayHref: string }) {
  const items = columnBlocks(board, "all", dateIso);
  if (!items.length) return null;
  const first = items[0];
  return (
    <Link
      href={items.length === 1 ? blockHref(first) : dayHref}
      title={items.map((o) => blockTitle(o, board.team)).join("\n")}
      data-testid="sperrzeit-hinweis"
      className="pointer-events-auto flex min-w-0 items-center gap-1 rounded px-0.5 text-[10px] leading-4 text-muted hover:text-text hover:underline"
    >
      <Ban size={10} className="shrink-0" aria-hidden />
      <span className="truncate">{first.allDay ? first.label : `${toHhmm(first.startMin)} ${first.label}`}</span>
      {items.length > 1 ? <span className="shrink-0 font-semibold">+{items.length - 1}</span> : null}
    </Link>
  );
}

/**
 * Umschalter „Termin“ / „Sperrzeit“ über den Formularen für neue Einträge (Klick auf freie Zeit im Kalender
 * führt zum Terminformular – von dort mit derselben Vorbelegung zur Sperrzeit und zurück).
 */
export function NewEntrySwitch({ active, prefill }: { active: "termin" | "sperrzeit"; prefill: { datum?: string; zeit?: string; behandler?: string } }) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(prefill)) if (v) p.set(k, v);
  const q = p.size ? `?${p}` : "";
  const cls = (on: boolean) => `inline-flex h-11 items-center gap-2 rounded-lg px-4 text-sm font-semibold ${on ? "bg-primary text-on-primary" : "hover:bg-surface-2"}`;
  return (
    <nav className="mb-6 inline-flex rounded-xl border border-border bg-surface p-1" aria-label="Art des Eintrags">
      <Link href={`/kalender/neu${q}`} className={cls(active === "termin")} aria-current={active === "termin" ? "page" : undefined}>Termin</Link>
      <Link href={`/kalender/sperrzeit/neu${q}`} className={cls(active === "sperrzeit")} aria-current={active === "sperrzeit" ? "page" : undefined}>
        <Ban size={16} aria-hidden /> Sperrzeit
      </Link>
    </nav>
  );
}

/** Einfache Ansicht: Zeile „Sperrzeiten: Pause 12:00–12:30 (alle), Schulung 14:00–16:00 (Anna)“ */
export function DayBlockLine({ board, dateIso }: { board: Board; dateIso: string }) {
  const items = columnBlocks(board, "all", dateIso);
  if (!items.length) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      <span className="font-semibold">Sperrzeiten:</span>
      {items.map((o) => (
        <Link key={`${o.blockId}-${o.userId ?? "p"}`} href={blockHref(o)} className="inline-flex items-center gap-1 rounded border border-dashed border-border-strong bg-surface-2 px-1.5 py-0.5 hover:text-text" title={blockTitle(o, board.team)}>
          <Ban size={11} className="shrink-0" aria-hidden />
          {describeBlock(o)} ({o.userId ? (board.team.find((t) => t.id === o.userId)?.name.split(" ")[0] ?? "Person") : "alle"})
        </Link>
      ))}
    </span>
  );
}
