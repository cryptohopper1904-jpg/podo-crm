"use client";

import Link from "next/link";
import { Sparkles, X } from "lucide-react";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import type { ChangelogSelection } from "@/lib/changelog";
import { dismissChangelogAction } from "@/app/(app)/neuigkeiten/actions";
import { ChangelogEntryView } from "./changelog-entry";
import { Button } from "./ui";

/**
 * „Neu in PodoHero“ nach der Anmeldung. Natives <dialog> mit showModal(): Fokus bleibt im Dialog
 * (Rest der Seite inert), Esc schließt, aria-modal, Fokus kehrt danach zurück.
 */
export function ChangelogDialog({ selection }: { selection: ChangelogSelection }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const saved = useRef(false);
  const [mute, setMute] = useState(false);
  const [, startTransition] = useTransition();
  const titleId = useId();
  const latestId = selection.entries[0]?.id;

  useEffect(() => {
    const d = ref.current;
    if (!d || d.open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    d.showModal();
    // Hintergrund nicht mitscrollen (iPad/iPhone)
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = "";
    };
  }, []);

  const onClose = () => {
    document.documentElement.style.overflow = "";
    if (latestId && !saved.current) {
      saved.current = true;
      startTransition(async () => {
        await dismissChangelogAction(latestId, mute).catch(() => undefined);
      });
    }
    const back = opener.current;
    if (back && back.isConnected && back !== document.body) back.focus();
  };
  const close = () => ref.current?.close();

  if (!latestId) return null;
  return (
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
          <p className="text-sm text-muted">{selection.mode === "neu" ? "Das hat sich seit Ihrem letzten Besuch getan." : "Die letzte Neuerung zur Erinnerung."}</p>
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
  );
}
