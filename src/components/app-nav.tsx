"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  CalendarDays,
  FileText,
  Gift,
  Home,
  Inbox,
  Newspaper,
  Settings,
  Star,
  Stethoscope,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cx } from "./ui";

export type NavKey =
  | "heute"
  | "kalender"
  | "kunden"
  | "doku"
  | "posteingang"
  | "rechnungen"
  | "gutscheine"
  | "bewertungen"
  | "news"
  | "auswertung"
  | "einstellungen";

const ITEMS: { key: NavKey; href: string; label: string; icon: LucideIcon; mobile?: boolean }[] = [
  { key: "heute", href: "/heute", label: "Heute", icon: Home, mobile: true },
  { key: "kalender", href: "/kalender", label: "Kalender", icon: CalendarDays, mobile: true },
  { key: "kunden", href: "/kunden", label: "Kunden", icon: Users, mobile: true },
  { key: "doku", href: "/doku", label: "Behandlung", icon: Stethoscope, mobile: true },
  { key: "posteingang", href: "/posteingang", label: "Posteingang", icon: Inbox, mobile: true },
  { key: "rechnungen", href: "/rechnungen", label: "Rechnungen", icon: FileText },
  { key: "gutscheine", href: "/gutscheine", label: "Gutscheine", icon: Gift },
  { key: "bewertungen", href: "/bewertungen", label: "Bewertungen", icon: Star },
  { key: "news", href: "/news", label: "News", icon: Newspaper },
  { key: "auswertung", href: "/auswertung", label: "Auswertung", icon: BarChart3 },
  { key: "einstellungen", href: "/einstellungen", label: "Einstellungen", icon: Settings },
];

export function SideNav({ allowed, badges }: { allowed: NavKey[]; badges?: Partial<Record<NavKey, number>> }) {
  const path = usePathname();
  return (
    <nav aria-label="Hauptnavigation" className="flex flex-col gap-1">
      {ITEMS.filter((i) => allowed.includes(i.key)).map((i) => {
        const active = path === i.href || path.startsWith(i.href + "/");
        const Icon = i.icon;
        return (
          <Link
            key={i.key}
            href={i.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "flex h-11 items-center gap-3 rounded-xl px-3 text-[15px] font-medium",
              active ? "bg-primary-soft text-primary-soft-text" : "text-text hover:bg-surface-2",
            )}
          >
            <Icon size={19} aria-hidden />
            <span className="flex-1">{i.label}</span>
            {badges?.[i.key] ? (
              <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-bold text-on-accent">{badges[i.key]}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function BottomNav({ allowed }: { allowed: NavKey[] }) {
  const path = usePathname();
  const items = ITEMS.filter((i) => i.mobile && allowed.includes(i.key));
  return (
    <nav
      aria-label="Schnellnavigation"
      className="no-print fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {items.map((i) => {
        const active = path === i.href || path.startsWith(i.href + "/");
        const Icon = i.icon;
        return (
          <Link
            key={i.key}
            href={i.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-semibold",
              active ? "text-primary" : "text-muted",
            )}
          >
            <Icon size={22} aria-hidden />
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
