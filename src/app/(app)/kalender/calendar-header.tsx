import Link from "next/link";
import type { ReactNode } from "react";
import { Ban, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { LinkButton, SegmentedControl } from "@/components/ui";
import { DateJump, MoreMenu } from "./calendar-header-parts";

const navBtn = "inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-text hover:bg-surface-2";

/**
 * Kopf des Kalenders (Einfach und Vollständig).
 *
 * Handy (< sm) – höchstens zwei Zeilen, damit der Kalender früh beginnt:
 *   1. ‹ [Datum ▾] › Heute   (Datum öffnet den Datumswähler)
 *   2. [Tag | Woche | Monat] ⋯   (⋯ = Einfach/Vollständig, Anzeige, Sperrzeit)
 *   „+ Termin“ schwebt unten rechts über der Bottom-Navigation.
 * Ab sm: Titel links, ‹ Heute › · Sperrzeit · + Termin rechts; darunter Zeitraum, Einfach/Vollständig und Anzeige.
 */
export function CalendarHeader({
  title,
  shortTitle,
  dateValue,
  datePattern,
  prevHref,
  nextHref,
  todayHref,
  prevLabel,
  nextLabel,
  tabs,
  modeSwitch,
  panel,
  blockHref,
  newHref,
}: {
  title: string;
  shortTitle: string;
  /** JJJJ-MM-TT für den Datumswähler */
  dateValue: string;
  /** Link mit Platzhalter DATE_SLOT für den gewählten Tag */
  datePattern: string;
  prevHref: string;
  nextHref: string;
  todayHref: string;
  prevLabel: string;
  nextLabel: string;
  tabs: { href: string; label: string; active: boolean }[];
  /** Einfach/Vollständig – wird für Handy (Menü) und breite Bildschirme je einmal gerendert */
  modeSwitch: (place: "menu" | "bar") => ReactNode;
  panel: (place: "menu" | "bar") => ReactNode;
  blockHref: string | null;
  newHref: string | null;
}) {
  const prev = (cls: string) => (
    <Link href={prevHref} aria-label={prevLabel} title={prevLabel} className={`${navBtn} ${cls}`}>
      <ChevronLeft size={20} aria-hidden />
    </Link>
  );
  const next = (cls: string) => (
    <Link href={nextHref} aria-label={nextLabel} title={nextLabel} className={`${navBtn} ${cls}`}>
      <ChevronRight size={20} aria-hidden />
    </Link>
  );
  return (
    <>
      <header className="mb-4 flex flex-col gap-2 sm:mb-6 sm:gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-[1_1_16rem] items-center gap-1">
            {prev("sm:hidden")}
            <div className="min-w-0 flex-1 max-sm:flex max-sm:justify-center">
              <p className="text-sm text-muted max-sm:hidden">Kalender</p>
              <h1 className="max-w-full font-display text-xl font-semibold tracking-tight sm:text-3xl">
                <DateJump value={dateValue} label={title} shortLabel={shortTitle} hrefPattern={datePattern} />
              </h1>
            </div>
            {next("sm:hidden")}
            <LinkButton variant="ghost" href={todayHref} className="shrink-0 px-3 sm:hidden">
              Heute
            </LinkButton>
          </div>
          <div className="flex flex-wrap items-center gap-2 max-sm:hidden">
            <div className="flex items-center gap-1" role="group" aria-label="Zeitraum wechseln">
              {prev("")}
              <LinkButton variant="secondary" href={todayHref}>
                Heute
              </LinkButton>
              {next("")}
            </div>
            {blockHref ? (
              <LinkButton variant="secondary" href={blockHref} title="Sperrzeit eintragen: Pause, Schulung, früher Feierabend, Wartung, Reinigung …">
                <Ban size={18} aria-hidden />
                <span className="max-lg:sr-only">Sperrzeit</span>
                <span className="sr-only lg:hidden"> eintragen</span>
              </LinkButton>
            ) : null}
            {newHref ? (
              <LinkButton href={newHref}>
                <Plus size={18} aria-hidden /> Termin
              </LinkButton>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl label="Ansicht" items={tabs} className="max-sm:flex-1 max-sm:flex-nowrap max-sm:[&>a]:flex-1" />
          <div className="flex flex-wrap items-center gap-2 max-sm:hidden">
            {modeSwitch("bar")}
            {panel("bar")}
          </div>
          <div className="sm:hidden">
            <MoreMenu>
              {modeSwitch("menu")}
              {panel("menu")}
              {blockHref ? (
                <LinkButton variant="secondary" href={blockHref} className="w-full justify-start">
                  <Ban size={18} aria-hidden /> Sperrzeit eintragen
                </LinkButton>
              ) : null}
            </MoreMenu>
          </div>
        </div>
      </header>
      {newHref ? (
        <Link
          href={newHref}
          className="no-print fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[calc(var(--podo-sticky-bottom)+0.25rem)] z-30 inline-flex h-14 items-center gap-2 rounded-full bg-primary pr-5 pl-4 text-[15px] font-semibold text-on-primary shadow-lg hover:bg-primary-hover sm:hidden"
        >
          <Plus size={22} aria-hidden /> Termin
        </Link>
      ) : null}
    </>
  );
}
