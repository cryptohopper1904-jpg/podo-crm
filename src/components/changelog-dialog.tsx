"use client";

import Link from "next/link";
import { Sparkles, X } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore, useTransition } from "react";
import type { ChangelogSelection } from "@/lib/changelog";
import { dismissChangelogAction } from "@/app/(app)/neuigkeiten/actions";
import { ChangelogEntryView } from "./changelog-entry";
import { Button } from "./ui";

/** ab md (Tablet/Desktop) gleich als Dialog; darunter (Handy) erst ein dezenter Hinweis-Chip */
const WIDE = "(min-width: 768px)";
function subscribeWide(cb: () => void) {
  const mq = matchMedia(WIDE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function openDialog(d: HTMLDialogElement | null, opener: { current: HTMLElement | null }) {
  if (!d || d.open) return;
  opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  d.showModal();
  // Hintergrund nicht mitscrollen (iPad/iPhone)
  document.documentElement.style.overflow = "hidden";
}

/**
 * „Neu in PodoHero“ nach der Anmeldung. Natives <dialog> mit showModal(): Fokus bleibt im Dialog
 * (Rest der Seite inert), Esc schließt, aria-modal, Fokus kehrt danach zurück.
 * Auf dem Handy verdeckt kein Dialog den Start: ein kleiner Chip über der unteren Leiste öffnet ihn auf Wunsch,
 * „×“ legt die Neuerung ab. „Bis zur nächsten Neuerung nicht mehr anzeigen“ ist vorausgewählt.
 */
export function ChangelogDialog({ selection }: { selection: ChangelogSelection }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const saved = useRef(false);
  const [mute, setMute] = useState(true);
  const [chipClosed, setChipClosed] = useState(false);
  const [, startTransition] = useTransition();
  const titleId = useId();
  const latestId = selection.entries[0]?.id;
  const wide = useSyncExternalStore(subscribeWide, () => matchMedia(WIDE).matches, () => null);

  const open = () => openDialog(ref.current, opener);

  // Tablet/Desktop: wie bisher gleich nach dem Laden öffnen
  const autoOpened = useRef(false);
  useEffect(() => {
    if (wide !== true || autoOpened.current) return;
    autoOpened.current = true;
    openDialog(ref.current, opener);
  }, [wide]);
  useEffect(
    () => () => {
      document.documentElement.style.overflow = "";
    },
    [],
  );

  const save = (muteNow: boolean) => {
    if (!latestId || saved.current) return;
    saved.current = true;
    startTransition(async () => {
      await dismissChangelogAction(latestId, muteNow).catch(() => undefined);
    });
  };

  const onClose = () => {
    document.documentElement.style.overflow = "";
    save(mute);
    setChipClosed(true);
    const back = opener.current;
    if (back && back.isConnected && back !== document.body) back.focus();
  };
  const close = () => ref.current?.close();

  if (!latestId) return null;
  const latest = selection.entries[0];
  return (
    <>
    {wide === false && !chipClosed ? (
      <div role="status" aria-label="Neu in PodoHero" className="no-print fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] left-[max(1rem,env(safe-area-inset-left))] z-30 flex justify-end md:hidden">
        <div className="flex max-w-full items-center rounded-full border border-border bg-surface pl-1 shadow-lg">
          <button type="button" onClick={open} className="inline-flex h-11 min-w-0 cursor-pointer items-center gap-2 rounded-full px-3 text-sm font-semibold">
            <Sparkles size={17} aria-hidden className="shrink-0 text-primary" />
            <span className="truncate">Neu: {latest.title}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              save(true);
              setChipClosed(true);
            }}
            aria-label="Neuigkeiten-Hinweis schließen"
            title="Bis zur nächsten Neuerung nicht mehr anzeigen"
            className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-surface-2"
          >
            <X size={17} aria-hidden />
          </button>
        </div>
      </div>
    ) : null}
    <dialog
      ref={ref}
      aria-modal="true"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        // Klick auf den abgedunkelten Hintergrund schließt
        if (e.target === e.currentTarget) close();
      }}
      className="fixed inset-0 m-auto hidden max-h-[min(88dvh,46rem)] w-[min(36rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface p-0 text-text shadow-2xl backdrop:bg-black/55 open:flex"
    >
      <header className="flex items-start gap-3 border-b border-border px-5 pb-4 pt-5">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-soft-text">
          <Sparkles size={20} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="font-display text-xl font-semibold">Neu in PodoHero</h2>
          <p className="text-sm text-muted">{selection.mode === "neu" ? "Das hat sich seit deinem letzten Besuch getan." : "Die letzte Neuerung zur Erinnerung."}</p>
        </div>
        <button type="button" onClick={close} aria-label="Schließen" className="-mr-2 -mt-1 inline-flex size-11 shrink-0 items-center justify-center rounded-xl hover:bg-surface-2">
          <X size={20} aria-hidden />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-5 py-5">
        {selection.entries.map((e) => (
          <ChangelogEntryView key={e.id} entry={e} onNavigate={close} />
        ))}
      </div>
      <footer className="flex flex-col gap-3 border-t border-border bg-surface-2 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:flex-row sm:items-center">
        <label className="flex min-h-11 flex-1 items-center gap-3 text-[15px]">
          <input type="checkbox" checked={mute} onChange={(e) => setMute(e.target.checked)} className="size-5 shrink-0 accent-[var(--primary)]" />
          <span>Bis zur nächsten Neuerung nicht mehr anzeigen</span>
        </label>
        <div className="flex items-center gap-2">
          <Link href="/neuigkeiten" onClick={close} className="inline-flex h-11 flex-1 items-center justify-center rounded-xl px-3 text-[15px] font-semibold text-primary hover:bg-surface sm:flex-none">
            Alle Neuigkeiten
          </Link>
          <Button type="button" onClick={close} autoFocus className="flex-1 sm:flex-none">
            Verstanden
          </Button>
        </div>
      </footer>
    </dialog>
    </>
  );
}
