"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronsLeft, ChevronsRight, Sparkles } from "lucide-react";
import { SideNav, type NavKey } from "./app-nav";
import { Logo, LogoMark } from "./logo";
import { cx } from "./ui";

/** Cookie statt localStorage: der Server rendert die Leiste gleich in der richtigen Breite (kein Springen). */
export const NAV_COOKIE = "podo_nav";

/**
 * Linke Navigation (Desktop), einklappbar auf eine schmale Icon-Leiste. Eingeklappt zeigen die Einträge
 * ihren Namen als Tooltip; der Zustand bleibt pro Browser gespeichert (1 Jahr).
 */
export function Sidebar({
  initialCollapsed,
  allowed,
  badges,
  userName,
  userMeta,
}: {
  initialCollapsed: boolean;
  allowed: NavKey[];
  badges?: Partial<Record<NavKey, number>>;
  userName: string;
  userMeta: string;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
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
        "no-print sticky top-0 hidden h-screen shrink-0 flex-col gap-6 overflow-y-auto overflow-x-hidden border-r border-border bg-surface py-6 transition-[width] duration-200 lg:flex",
        collapsed ? "w-[76px] px-3" : "w-64 px-4",
      )}
    >
      <div className={cx("flex items-center", collapsed ? "flex-col gap-3" : "justify-between gap-2")}>
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
      <SideNav allowed={allowed} badges={badges} collapsed={collapsed} />
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
          <Link href="/neuigkeiten" className="mt-2 inline-flex min-h-8 items-center gap-1.5 font-semibold text-primary hover:underline">
            <Sparkles size={15} aria-hidden /> Neuigkeiten
          </Link>
        </div>
      )}
    </aside>
  );
}
