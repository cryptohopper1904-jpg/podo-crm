"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition } from "react";
import { ChevronsLeft, ChevronsRight, Sparkles } from "lucide-react";
import { SettingsLink, SideNav, type NavKey } from "./app-nav";
import { Logo, LogoMark } from "./logo";
import { cx } from "./ui";
import { NAV_COOKIE } from "@/lib/nav";
import { VIEW_LEVEL_LABELS, VIEW_LEVELS, type ViewLevel } from "@/lib/view-level";
import { setViewLevelAction } from "@/app/(app)/einstellungen/ansicht/actions";


/**
 * Linke Navigation (Desktop), einklappbar auf eine schmale Icon-Leiste. Eingeklappt zeigen die Einträge
 * ihren Namen als Tooltip; der Zustand bleibt pro Browser gespeichert (1 Jahr) – als Cookie statt localStorage,
 * damit der Server die Leiste gleich in der richtigen Breite rendert (kein Springen).
 */
export function Sidebar({
  initialCollapsed,
  allowed,
  badges,
  userName,
  userMeta,
  level,
  canChangeView,
}: {
  initialCollapsed: boolean;
  allowed: NavKey[];
  badges?: Partial<Record<NavKey, number>>;
  userName: string;
  userMeta: string;
  /** Ansicht der Person (src/lib/view-level.ts) */
  level: ViewLevel;
  /** Schnellumschalter zeigen (nicht im Support-Modus) */
  canChangeView: boolean;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [shownLevel, setShownLevel] = useOptimistic(level);
  const [, startTransition] = useTransition();
  const [levelError, setLevelError] = useState<string | null>(null);
  const chooseLevel = (l: ViewLevel) =>
    startTransition(async () => {
      setShownLevel(l);
      setLevelError(null);
      const res = await setViewLevelAction(l);
      if (res && "error" in res && res.error) setLevelError(res.error);
    });
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${NAV_COOKIE}=${next ? "collapsed" : "open"}; path=/; max-age=31536000; samesite=lax`;
  };
  const initials = userName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");

  return (
    <aside
      data-collapsed={collapsed || undefined}
      className={cx(
        "no-print sticky top-0 hidden h-dvh shrink-0 flex-col overflow-hidden border-r border-border bg-surface transition-[width] duration-200 lg:flex",
        collapsed ? "w-[76px]" : "w-64",
      )}
    >
      {/* Kopf (Logo + Einklapp-Knopf) bleibt stehen; nur der Bereich darunter scrollt bei wenig Bildschirmhöhe */}
      <div className={cx("flex shrink-0 items-center pb-4 pt-6", collapsed ? "flex-col gap-3 px-3" : "justify-between gap-2 px-4")}>
        <Link href="/heute" className={collapsed ? "" : "px-2"} aria-label="PodoHero – Heute">
          {collapsed ? <LogoMark size={34} /> : <Logo />}
        </Link>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Navigation ausklappen" : "Navigation einklappen"}
          title={collapsed ? "Navigation ausklappen" : "Navigation einklappen"}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
        >
          {collapsed ? <ChevronsRight size={18} aria-hidden /> : <ChevronsLeft size={18} aria-hidden />}
        </button>
      </div>
      <div
        data-sidebar-scroll
        className={cx(
          "flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overflow-x-hidden overscroll-contain pb-4 pt-1",
          // eingeklappt kein sichtbarer Scrollbalken (er würde die 44-px-Icons in der 76-px-Leiste beschneiden); Scrollen per Rad/Touch/Tab bleibt
          collapsed ? "px-3 [scrollbar-width:none]" : "px-4 [scrollbar-width:thin]",
        )}
      >
        <SideNav allowed={allowed} badges={badges} collapsed={collapsed} level={shownLevel} />
        {collapsed ? (
          <div className="mt-auto flex flex-col items-center gap-2">
            <Link
              href="/neuigkeiten"
              aria-label="Neuigkeiten"
              title="Neuigkeiten"
              className="inline-flex size-11 items-center justify-center rounded-xl text-primary hover:bg-surface-2"
            >
              <Sparkles size={19} aria-hidden />
            </Link>
            <span
              title={`${userName} · ${userMeta}`}
              className="inline-flex size-10 items-center justify-center rounded-full bg-surface-2 text-sm font-semibold"
            >
              {initials || "?"}
            </span>
          </div>
        ) : (
          <div className="mt-auto rounded-xl bg-surface-2 p-3 text-sm">
            <p className="font-semibold">{userName}</p>
            <p className="text-muted">{userMeta}</p>
            {canChangeView ? (
              <div role="group" aria-label="Ansicht" className="mt-2 flex rounded-lg border border-border bg-surface p-0.5">
                {VIEW_LEVELS.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => chooseLevel(l)}
                    aria-pressed={shownLevel === l}
                    title={`Ansicht „${VIEW_LEVEL_LABELS[l]}“`}
                    className={cx(
                      "min-h-8 flex-1 rounded-md px-1 text-xs font-semibold",
                      shownLevel === l ? "bg-primary text-on-primary" : "text-muted hover:bg-surface-2 hover:text-text",
                    )}
                  >
                    {VIEW_LEVEL_LABELS[l]}
                  </button>
                ))}
              </div>
            ) : null}
            {levelError ? <p role="alert" className="mt-1 text-xs font-medium text-danger">{levelError}</p> : null}
            <Link href="/neuigkeiten" className="mt-2 inline-flex min-h-8 items-center gap-1.5 font-semibold text-primary hover:underline">
              <Sparkles size={15} aria-hidden /> Neuigkeiten
            </Link>
          </div>
        )}
      </div>
      {/* „Einstellungen“ unten fest – bleibt bei wenig Bildschirmhöhe sichtbar, während die Liste darüber scrollt */}
      <div className={cx("shrink-0 border-t border-border py-2", collapsed ? "px-3" : "px-4")}>
        <SettingsLink collapsed={collapsed} />
      </div>
    </aside>
  );
}
