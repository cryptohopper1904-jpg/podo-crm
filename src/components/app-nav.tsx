"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Banknote,
  Phone,
  BarChart3,
  Building2,
  ClipboardList,
  ShieldCheck,
  ShieldAlert,
  UsersRound,
  CalendarDays,
  FileText,
  Gift,
  Home,
  Inbox,
  Newspaper,
  Route,
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
  | "touren"
  | "kunden"
  | "doku"
  | "posteingang"
  | "rechnungen"
  | "gutscheine"
  | "bewertungen"
  | "news"
  | "auswertung"
  | "einstellungen"
  | "verordnungen"
  | "pflegeheime"
  | "hygiene"
  | "team"
  | "kasse"
  | "telefon"
  | "plattform";

const ITEMS: { key: NavKey; href: string; label: string; icon: LucideIcon; mobile?: boolean }[] = [
  { key: "heute", href: "/heute", label: "Heute", icon: Home, mobile: true },
  { key: "kalender", href: "/kalender", label: "Kalender", icon: CalendarDays, mobile: true },
  { key: "touren", href: "/touren", label: "Touren", icon: Route },
  { key: "kunden", href: "/kunden", label: "Patienten", icon: Users, mobile: true },
  { key: "doku", href: "/doku", label: "Behandlung", icon: Stethoscope, mobile: true },
  { key: "posteingang", href: "/posteingang", label: "Posteingang", icon: Inbox, mobile: true },
  { key: "verordnungen", href: "/verordnungen", label: "Verordnungen", icon: ClipboardList },
  { key: "pflegeheime", href: "/pflegeheime", label: "Pflegeheime", icon: Building2 },
  { key: "rechnungen", href: "/rechnungen", label: "Rechnungen", icon: FileText },
  { key: "kasse", href: "/kasse", label: "Kasse", icon: Banknote },
  { key: "gutscheine", href: "/gutscheine", label: "Gutscheine", icon: Gift },
  { key: "telefon", href: "/telefon", label: "Telefon", icon: Phone },
  { key: "bewertungen", href: "/bewertungen", label: "Bewertungen", icon: Star },
  { key: "news", href: "/news", label: "News", icon: Newspaper },
  { key: "hygiene", href: "/hygiene", label: "Hygiene & Geräte", icon: ShieldCheck },
  { key: "team", href: "/team", label: "Team-Planung", icon: UsersRound },
  { key: "auswertung", href: "/auswertung", label: "Auswertung", icon: BarChart3 },
  { key: "einstellungen", href: "/einstellungen", label: "Einstellungen", icon: Settings },
  { key: "plattform", href: "/plattform", label: "Plattform", icon: ShieldAlert },
];

export function SideNav({ allowed, badges, collapsed = false }: { allowed: NavKey[]; badges?: Partial<Record<NavKey, number>>; collapsed?: boolean }) {
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
            title={collapsed ? i.label : undefined}
            className={cx(
              "relative flex h-11 items-center rounded-xl text-[15px] font-medium",
              collapsed ? "justify-center px-0" : "gap-3 px-3",
              active ? "bg-primary-soft text-primary-soft-text" : "text-text hover:bg-surface-2",
            )}
          >
            <Icon size={19} aria-hidden />
            <span className={collapsed ? "sr-only" : "flex-1 truncate"}>{i.label}</span>
            {badges?.[i.key] ? (
              collapsed ? (
                <span className="absolute right-1.5 top-1.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-bold leading-4 text-on-accent">{badges[i.key]}</span>
              ) : (
                <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-bold text-on-accent">{badges[i.key]}</span>
              )
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
