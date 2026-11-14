"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
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
  ChevronDown,
  LayoutGrid,
  Ellipsis,
  FileText,
  Gift,
  Home,
  Inbox,
  Newspaper,
  Package,
  Route,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Star,
  Stethoscope,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { cx } from "./ui";
import { bottomNavSplit, groupNav, type NavKey } from "@/lib/nav";
import { DEFAULT_VIEW_LEVEL, splitNav, VIEW_LEVEL_LABELS, type ViewLevel } from "@/lib/view-level";

export type { NavKey };

/** `short`: Beschriftung in der schmalen unteren Leiste (Handy) */
const ITEMS: { key: NavKey; href: string; label: string; short?: string; icon: LucideIcon }[] = [
  { key: "heute", href: "/heute", label: "Heute", icon: Home },
  { key: "kalender", href: "/kalender", label: "Kalender", icon: CalendarDays },
  { key: "touren", href: "/touren", label: "Touren", icon: Route },
  { key: "kunden", href: "/kunden", label: "Patienten", icon: Users },
  { key: "doku", href: "/doku", label: "Behandlung", short: "Doku", icon: Stethoscope },
  { key: "posteingang", href: "/posteingang", label: "Posteingang", short: "Nachrichten", icon: Inbox },
  { key: "verordnungen", href: "/verordnungen", label: "Verordnungen", icon: ClipboardList },
  { key: "pflegeheime", href: "/pflegeheime", label: "Pflegeheime", icon: Building2 },
  { key: "rechnungen", href: "/rechnungen", label: "Rechnungen", icon: FileText },
  { key: "kasse", href: "/kasse", label: "Kasse", icon: Banknote },
  { key: "produkte", href: "/produkte", label: "Produkte", icon: Package },
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

type NavItem = (typeof ITEMS)[number];
type Badges = Partial<Record<NavKey, number>>;

const itemsOf = (keys: readonly NavKey[]) => ITEMS.filter((i) => keys.includes(i.key));
const isActive = (path: string, href: string) => path === href || path.startsWith(href + "/");
const sumBadges = (items: NavItem[], badges?: Badges) => items.reduce((n, i) => n + (badges?.[i.key] ?? 0), 0);

/**
 * Rückmeldung beim Antippen, solange die Zielseite lädt (langsame Mobilverbindung): feste Größe, nur die Deckkraft
 * wechselt – kein Springen. Muss innerhalb eines <Link> stehen (useLinkStatus).
 */
function PendingHint({ className }: { className: string }) {
  const { pending } = useLinkStatus();
  return <span aria-hidden data-pending={pending || undefined} className={cx("pointer-events-none absolute rounded-full bg-primary opacity-0 transition-opacity data-[pending]:animate-pulse data-[pending]:opacity-100", className)} />;
}

function SideLink({ item, active, badge, collapsed }: { item: NavItem; active: boolean; badge?: number; collapsed: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      title={collapsed ? item.label : undefined}
      className={cx(
        "relative flex h-10 shrink-0 items-center rounded-xl text-[15px] font-medium",
        collapsed ? "justify-center px-0" : "gap-3 px-3",
        active ? "bg-primary-soft text-primary-soft-text" : "text-text hover:bg-surface-2",
      )}
    >
      <Icon size={19} aria-hidden />
      <span className={collapsed ? "sr-only" : "flex-1 truncate"}>{item.label}</span>
      <CountBadge n={badge} collapsed={collapsed} />
      <PendingHint className="inset-y-2 left-0 w-1" />
    </Link>
  );
}

function CountBadge({ n, collapsed }: { n?: number; collapsed: boolean }) {
  if (!n) return null;
  return collapsed ? (
    <span className="absolute right-1.5 top-1.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-bold leading-4 text-on-accent">{n}</span>
  ) : (
    <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-bold text-on-accent">{n}</span>
  );
}

/** Gruppe der linken Navigation: Zwischenüberschrift (eingeklappt: Trennlinie) + Einträge */
function SideGroup({ label, items, path, badges, collapsed, first }: { label: string; items: NavItem[]; path: string; badges?: Badges; collapsed: boolean; first: boolean }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-0.5">
      {collapsed ? (
        <>
          <span id={id} className="sr-only">{label}</span>
          {first ? null : <hr aria-hidden className="mx-2 my-1.5 border-border" />}
        </>
      ) : (
        <p id={id} className={cx("px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted", first ? "pt-0" : "pt-3")}>{label}</p>
      )}
      {items.map((i) => <SideLink key={i.key} item={i} active={isActive(path, i.href)} badge={badges?.[i.key]} collapsed={collapsed} />)}
    </div>
  );
}

/**
 * Hauptnavigation (Desktop, links). `allowed` ist bereits nach Rechten/Tarif gefiltert; `level` (Ansicht,
 * src/lib/view-level.ts) blendet zusätzlich Punkte aus – diese stehen unter „Mehr“ (klappt von selbst auf, wenn man
 * gerade dort ist). Gruppiert in Praxis / Abrechnung / Verwaltung (src/lib/nav.ts); „Einstellungen“ steht unten fest
 * (SettingsLink in der Sidebar).
 */
export function SideNav({ allowed, badges, collapsed = false, level = DEFAULT_VIEW_LEVEL }: { allowed: NavKey[]; badges?: Badges; collapsed?: boolean; level?: ViewLevel }) {
  const path = usePathname();
  // null = automatisch (offen, wenn die aktive Seite unter „Mehr“ liegt); sonst ausdrücklich auf-/zugeklappt
  const [moreOpen, setMoreOpen] = useState<boolean | null>(null);
  const keys = allowed.filter((k) => k !== "einstellungen");
  const split = splitNav(keys, level);
  const groups = groupNav(split.visible);
  const more = itemsOf(split.more);
  const activeInMore = more.some((i) => isActive(path, i.href));
  const showMore = moreOpen ?? activeInMore;
  const moreBadge = sumBadges(more, badges);
  return (
    <nav aria-label="Hauptnavigation" className="flex flex-col gap-1">
      {groups.map((g, n) => (
        <SideGroup key={g.id} label={g.label} items={itemsOf(g.keys)} path={path} badges={badges} collapsed={collapsed} first={n === 0} />
      ))}
      {more.length ? (
        <>
          <button
            type="button"
            onClick={() => setMoreOpen(!showMore)}
            aria-expanded={showMore}
            aria-controls="nav-mehr"
            title={collapsed ? (showMore ? "Weniger anzeigen" : "Mehr Bereiche") : undefined}
            className={cx(
              "relative mt-2 flex h-10 items-center rounded-xl text-[15px] font-medium text-muted hover:bg-surface-2 hover:text-text",
              collapsed ? "justify-center px-0" : "gap-3 px-3",
            )}
          >
            <Ellipsis size={19} aria-hidden />
            <span className={collapsed ? "sr-only" : "flex-1 truncate text-left"}>{showMore ? "Weniger" : "Mehr"}</span>
            {showMore ? null : <CountBadge n={moreBadge} collapsed={collapsed} />}
            {collapsed ? null : <ChevronDown size={16} aria-hidden className={cx("transition-transform", showMore && "rotate-180")} />}
          </button>
          {showMore ? (
            <div id="nav-mehr" className="flex flex-col gap-0.5">
              {more.map((i) => <SideLink key={i.key} item={i} active={isActive(path, i.href)} badge={badges?.[i.key]} collapsed={collapsed} />)}
              <Link
                href="/bereiche"
                title={collapsed ? "Alle Bereiche" : undefined}
                aria-current={path === "/bereiche" ? "page" : undefined}
                className={cx("flex h-9 items-center rounded-xl text-sm font-semibold text-primary hover:bg-surface-2", collapsed ? "justify-center px-0" : "gap-3 px-3")}
              >
                <LayoutGrid size={17} aria-hidden />
                <span className={collapsed ? "sr-only" : "truncate"}>Alle Bereiche</span>
              </Link>
            </div>
          ) : null}
        </>
      ) : null}
    </nav>
  );
}

/**
 * „Einstellungen“ unten fest in der Sidebar (immer sichtbar, auch wenn die Liste darüber scrollt). Für alle Rollen:
 * ohne Praxis-Einstellungsrecht öffnet /einstellungen die persönlichen Seiten (Ansicht, Sicherheit, App).
 */
export function SettingsLink({ collapsed }: { collapsed: boolean }) {
  const path = usePathname();
  const item = ITEMS.find((i) => i.key === "einstellungen")!;
  return <SideLink item={item} active={isActive(path, item.href)} collapsed={collapsed} />;
}

// ── Handy/Tablet hochkant ────────────────────────────────────────────────────────────────────────────────────────

/** Ein Eingabefeld hat den Fokus → auf Touch-Geräten ist die Bildschirmtastatur offen */
function keyboardOpenNow(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !matchMedia("(pointer: coarse)").matches) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) return !el.readOnly && !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "hidden", "image"].includes(el.type);
  return false;
}
function subscribeFocus(cb: () => void) {
  document.addEventListener("focusin", cb);
  document.addEventListener("focusout", cb);
  return () => {
    document.removeEventListener("focusin", cb);
    document.removeEventListener("focusout", cb);
  };
}
/**
 * true, solange die Bildschirmtastatur (vermutlich) offen ist. Setzt zusätzlich `data-keyboard` am <html>, damit z. B.
 * klebende Aktionsleisten ihren Abstand zur (dann ausgeblendeten) unteren Leiste anpassen können.
 */
function useKeyboardOpen(): boolean {
  const open = useSyncExternalStore(subscribeFocus, keyboardOpenNow, () => false);
  useEffect(() => {
    const root = document.documentElement;
    if (open) root.dataset.keyboard = "open";
    else delete root.dataset.keyboard;
    return () => {
      delete root.dataset.keyboard;
    };
  }, [open]);
  return open;
}

const barItemCls = (active: boolean) =>
  cx(
    "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-xs font-semibold",
    active ? "text-primary" : "text-muted",
  );

function MoreBadge({ n }: { n: number }) {
  return n ? <span className="absolute right-[calc(50%-22px)] top-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-bold leading-4 text-on-accent">{n}</span> : null;
}

/**
 * Untere Leiste (Handy/Tablet hochkant, < lg): bis zu 4 Kernbereiche + „Mehr“. „Mehr“ öffnet ein Blatt mit ALLEN
 * übrigen erlaubten Bereichen – in jeder Ansicht (auch „Komplex“), dazu Einstellungen und Neuigkeiten. So ist auf jeder
 * Breite jeder erlaubte Bereich erreichbar (Aufteilung: bottomNavSplit in src/lib/nav.ts).
 * Bei offener Bildschirmtastatur ausgeblendet (mehr Platz fürs Formular).
 */
export function BottomNav({ allowed, level = DEFAULT_VIEW_LEVEL, badges }: { allowed: NavKey[]; level?: ViewLevel; badges?: Badges }) {
  const path = usePathname();
  const dialog = useRef<HTMLDialogElement>(null);
  const sheetId = useId();
  const [sheetOpen, setSheetOpen] = useState(false);
  const keyboard = useKeyboardOpen();
  const { visible } = splitNav(allowed, level);
  const split = bottomNavSplit(allowed, visible);
  const bar = itemsOf(split.bar);
  const inView = itemsOf(split.inView);
  const hidden = itemsOf(split.hidden);
  const moreBadge = sumBadges([...inView, ...hidden], badges);
  const activeInMore = [...inView, ...hidden].some((i) => isActive(path, i.href)) || ["/bereiche", "/einstellungen", "/neuigkeiten"].some((h) => isActive(path, h));

  const open = () => {
    const d = dialog.current;
    if (!d || d.open) return;
    d.showModal();
    setSheetOpen(true);
  };
  const close = () => dialog.current?.close();

  return (
    <>
      <nav
        aria-label="Schnellnavigation"
        data-keyboard={keyboard || undefined}
        className="no-print fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-surface pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] data-[keyboard]:hidden lg:hidden"
      >
        {bar.map((i) => {
          const active = isActive(path, i.href);
          const Icon = i.icon;
          return (
            <Link key={i.key} href={i.href} aria-current={active ? "page" : undefined} title={i.short ? i.label : undefined} className={barItemCls(active)}>
              <PendingHint className="inset-x-4 top-0 h-0.5" />
              <Icon size={22} aria-hidden />
              <span className="max-w-full truncate">{i.short ?? i.label}</span>
              {i.key === "posteingang" ? <MoreBadge n={badges?.posteingang ?? 0} /> : null}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={open}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          aria-controls={sheetId}
          aria-label={moreBadge ? `Mehr – alle Bereiche, ${moreBadge} neu` : "Mehr – alle Bereiche"}
          className={cx(barItemCls(activeInMore), "cursor-pointer")}
        >
          <Ellipsis size={22} aria-hidden />
          <span className="max-w-full truncate">Mehr</span>
          <MoreBadge n={moreBadge} />
        </button>
      </nav>
      <dialog
        ref={dialog}
        id={sheetId}
        aria-labelledby={`${sheetId}-title`}
        onClose={() => setSheetOpen(false)}
        onClick={(e) => {
          // Klick auf den abgedunkelten Hintergrund schließt
          if (e.target === e.currentTarget) close();
        }}
        className="no-print fixed inset-x-0 bottom-0 top-auto mx-auto mb-0 mt-auto hidden max-h-[min(85dvh,44rem)] w-full max-w-2xl flex-col overflow-hidden rounded-t-[var(--radius-card)] border border-b-0 border-border bg-surface p-0 text-text shadow-2xl backdrop:bg-black/45 open:flex"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
          <h2 id={`${sheetId}-title`} className="flex-1 font-display text-lg font-semibold">Alle Bereiche</h2>
          <button type="button" onClick={close} aria-label="Schließen" className="-mr-2 inline-flex size-11 cursor-pointer items-center justify-center rounded-xl hover:bg-surface-2">
            <X size={20} aria-hidden />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {[
            { title: hidden.length ? `In deiner Ansicht (${VIEW_LEVEL_LABELS[level]})` : "Bereiche", items: inView },
            { title: "Weitere Bereiche", items: hidden },
          ]
            .filter((g) => g.items.length)
            .map((g) => (
              <section key={g.title} aria-label={g.title}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{g.title}</h3>
                <ul className="grid grid-cols-2 gap-2 min-[360px]:grid-cols-3 sm:grid-cols-4">
                  {g.items.map((i) => (
                    <li key={i.key} className="min-w-0">
                      <SheetTile href={i.href} label={i.label} icon={i.icon} badge={badges?.[i.key]} active={isActive(path, i.href)} onNavigate={close} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          <section aria-label="Konto" className="border-t border-border pt-4">
            <ul className="grid grid-cols-2 gap-2 min-[360px]:grid-cols-3 sm:grid-cols-4">
              <li className="min-w-0"><SheetTile href="/einstellungen" label="Einstellungen" icon={Settings} active={isActive(path, "/einstellungen")} onNavigate={close} /></li>
              <li className="min-w-0"><SheetTile href="/neuigkeiten" label="Neuigkeiten" icon={Sparkles} active={isActive(path, "/neuigkeiten")} onNavigate={close} /></li>
              <li className="min-w-0"><SheetTile href="/einstellungen/ansicht" label="Ansicht ändern" icon={SlidersHorizontal} active={false} onNavigate={close} /></li>
            </ul>
          </section>
        </div>
      </dialog>
    </>
  );
}

function SheetTile({ href, label, icon: Icon, badge, active, onNavigate }: { href: string; label: string; icon: LucideIcon; badge?: number; active: boolean; onNavigate: () => void }) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cx(
        "relative flex min-h-[4.75rem] flex-col items-center justify-center gap-1.5 rounded-xl border px-1.5 py-2 text-center text-[13px] font-semibold leading-tight break-words hyphens-auto",
        active ? "border-primary bg-primary-soft text-primary-soft-text" : "border-border bg-bg hover:bg-surface-2",
      )}
    >
      <Icon size={22} aria-hidden className={active ? undefined : "text-primary"} />
      <span>{label}</span>
      {badge ? <span className="absolute right-1.5 top-1.5 min-w-5 rounded-full bg-accent px-1.5 text-center text-[11px] font-bold leading-5 text-on-accent">{badge}</span> : null}
    </Link>
  );
}

/** Übersicht aller erlaubten Bereiche (/bereiche) – auch die, die die Ansicht in der Navigation ausblendet. */
export function AreaOverview({ allowed, level, badges }: { allowed: NavKey[]; level: ViewLevel; badges?: Badges }) {
  const split = splitNav(allowed.filter((k) => k !== "einstellungen"), level);
  const groups = [
    { title: "In deiner Navigation", items: itemsOf(split.visible) },
    { title: "Weitere Bereiche", items: itemsOf(split.more) },
    // persönliche Einstellungen gibt es für alle Rollen (ohne Praxis-Recht: Ansicht, Sicherheit, App)
    { title: "Konto", items: [ITEMS.find((i) => i.key === "einstellungen")!] },
  ].filter((g) => g.items.length);
  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <section key={g.title} aria-label={g.title}>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{g.title}</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {g.items.map((i) => {
              const Icon = i.icon;
              return (
                <li key={i.key}>
                  <Link href={i.href} className="flex min-h-14 items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-[15px] font-semibold hover:bg-surface-2">
                    <Icon size={20} aria-hidden className="text-primary" />
                    <span className="flex-1 truncate">{i.label}</span>
                    <CountBadge n={badges?.[i.key]} collapsed={false} />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
