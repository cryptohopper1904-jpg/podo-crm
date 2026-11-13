import clsx from "clsx";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export const cx = clsx;

type Variant = "primary" | "secondary" | "accent" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary: "bg-primary text-on-primary hover:bg-primary-hover",
  accent: "bg-accent text-on-accent hover:bg-accent-hover",
  secondary: "bg-surface text-text border border-border hover:bg-surface-2",
  ghost: "text-text hover:bg-surface-2",
  danger: "bg-surface text-danger border border-border hover:bg-accent-soft",
};
const base =
  "inline-flex items-center justify-center gap-2 rounded-xl px-4 h-11 text-[15px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap";

export function Button({ variant = "primary", className, ...props }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button className={cx(base, variants[variant], className)} {...props} />;
}

export function LinkButton({
  variant = "primary",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={cx(base, variants[variant], className)} {...props} />;
}

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section className={cx("rounded-[var(--radius-card)] bg-surface border border-border p-5", className)} {...props} />;
}

export function CardTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="font-display text-xl font-semibold">{children}</h2>
      {action}
    </div>
  );
}

/**
 * Titelblock in Seitenköpfen (Titel links, Aktionen rechts, umbrechend): Grundbreite 16rem statt `flex-1` (Basis 0).
 * Mit Basis 0 blieben die Aktionen in derselben Zeile, solange sie selbst hineinpassen, und quetschten den Titel
 * zusammen – lange Wörter liefen dann in die Buttons. So rutschen die Aktionen rechtzeitig in eine eigene Zeile.
 */
export const pageTitleBox = "min-w-0 flex-[1_1_16rem]";
/** Überschrift im Seitenkopf: sehr lange Wörter umbrechen statt überzulaufen */
export const pageTitleCls = "font-display text-3xl font-semibold tracking-tight wrap-break-word";

/** Ziel eines Zurück-Links (logische Elternseite, siehe src/lib/back-link.ts) */
export type Back = { href: string; label: string };

/**
 * Einheitlicher Zurück-Link oberhalb des Seitentitels („← Patienten“) – auf allen Detailseiten gleich gestaltet.
 * Die App läuft auf dem iPad als PWA ohne Browser-Zurück; 44 px Touch-Höhe, Fokusring global (:focus-visible).
 */
export function BackLink({ href, label, className }: Back & { className?: string }) {
  return (
    <Link
      href={href}
      className={cx("no-print -ml-2 inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-muted hover:bg-surface-2 hover:text-primary", className)}
    >
      <ArrowLeft size={16} aria-hidden className="shrink-0" />
      <span className="sr-only">Zurück zu </span>
      <span className="truncate">{label}</span>
    </Link>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: string; subtitle?: ReactNode; actions?: ReactNode; back?: Back }) {
  return (
    <header className="mb-6 flex flex-wrap items-end gap-4">
      <div className={pageTitleBox}>
        {back ? <BackLink {...back} /> : null}
        {subtitle ? <p className="text-sm text-muted">{subtitle}</p> : null}
        <h1 className={pageTitleCls}>{title}</h1>
      </div>
      {actions ? <div className="flex min-w-0 max-w-full flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

type Tone = "primary" | "accent" | "info" | "warn" | "neutral";
const tones: Record<Tone, string> = {
  primary: "bg-primary-soft text-primary-soft-text",
  accent: "bg-accent-soft text-accent-soft-text",
  info: "bg-info-soft text-info-soft-text",
  warn: "bg-warn-soft text-warn-soft-text",
  neutral: "bg-surface-2 text-muted",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold", tones[tone], className)}>
      {children}
    </span>
  );
}

export function Stat({ label, value, sub, tone = "primary" }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className={cx("rounded-[var(--radius-card)] p-5", tones[tone])}>
      <p className="text-sm font-medium">{label}</p>
      <p className="mt-2 font-display text-3xl font-bold tabular-nums">{value}</p>
      {sub ? <p className="mt-1 text-[13px]">{sub}</p> : null}
    </div>
  );
}

const inputCls =
  "w-full rounded-xl border border-border bg-surface px-3.5 h-11 text-[15px] text-text placeholder:text-muted focus:border-primary focus:outline-none";

/**
 * Beschriftung über Eingabefeldern: darf umbrechen (nichts wird abgeschnitten), sitzt unten an der Eingabe.
 * Für eigene Beschriftungen außerhalb von <Field> dieselbe Klasse verwenden (Gruppen mit `fieldCls`).
 */
export const fieldLabelCls = "block min-h-5 self-end text-sm font-medium leading-5";

/**
 * Formularfeld-Rahmen: im Eltern-Grid ein Subgrid über zwei Zeilen (1. Beschriftung, 2. Eingabe + Hinweis). Alle Felder
 * einer Reihe teilen sich so die Höhe der Beschriftungszeile – bricht eine Beschriftung um, rutschen die Eingaben aller
 * Felder gemeinsam, bleiben also auf einer Linie; Hinweise stehen unter der Eingabe und verschieben nichts.
 * Außerhalb eines Grids (Flex, Block) ist es ein einfacher Stapel. Siehe globals.css (.podo-field).
 */
export const fieldCls = "podo-field grid min-w-0 row-span-2 grid-rows-subgrid content-start gap-y-1.5";

/** Feld = Beschriftung · Eingabe · optionaler Hinweis darunter */
export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx(fieldCls, className)}>
      <span className={fieldLabelCls}>{label}</span>
      <span className="flex min-w-0 flex-col gap-1.5">
        {children}
        {hint ? <span className="text-xs text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/**
 * Platz neben Feldern für Buttons oder Werte (z. B. Zeilensumme, Löschen, Checkbox): belegt die Beschriftungszeile leer
 * und steht darunter in Eingabehöhe – auf derselben Linie wie die Eingaben der Nachbarfelder.
 * `spacer`: Leerraum nur ab dieser Breite (einspaltig auf dem Handy nicht nötig), z. B. "hidden md:block".
 */
export function FieldSlot({ children, className, spacer = "block" }: { children: ReactNode; className?: string; spacer?: string }) {
  return (
    <div className={cx(fieldCls, className)}>
      <span aria-hidden className={cx("min-h-5", spacer)} />
      <div className="flex min-h-11 flex-wrap items-center gap-2 self-start">{children}</div>
    </div>
  );
}

/** Gesprochene Form gängiger Einheiten (für Screenreader) */
const UNIT_SPOKEN: Record<string, string> = { "€": "Euro", Min: "Minuten", Tage: "Tagen", km: "Kilometer", "%": "Prozent" };

/**
 * Eingabe; `suffix` zeigt eine Einheit im Feld rechts (z. B. „Tage“, „€“) – so bleibt die Beschriftung kurz.
 * Screenreader lesen die Einheit ausgeschrieben mit (`suffixSpoken`, Standard aus UNIT_SPOKEN bzw. der Einheit selbst).
 */
export function Input({ className, suffix, suffixSpoken, ...props }: ComponentProps<"input"> & { suffix?: string; suffixSpoken?: string }) {
  if (suffix == null) return <input className={cx(inputCls, className)} {...props} />;
  return (
    <span className="relative block w-full">
      <input className={cx(inputCls, "pr-14", className)} {...props} />
      <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-sm text-muted">
        {suffix}
      </span>
      <span className="sr-only">{` in ${suffixSpoken ?? UNIT_SPOKEN[suffix] ?? suffix}`}</span>
    </span>
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cx(inputCls, "pr-8", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cx(inputCls, "h-auto min-h-24 py-2.5", className)} {...props} />;
}

export function Checkbox({ label, ...props }: ComponentProps<"input"> & { label: ReactNode }) {
  return (
    <label className="flex min-h-11 items-center gap-3 text-[15px]">
      <input type="checkbox" className="size-5 accent-[var(--primary)]" {...props} />
      <span>{label}</span>
    </label>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-border-strong p-8 text-center">
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-2 text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
      <table className="w-full min-w-[640px] border-collapse text-left text-[15px] [&_td]:border-t [&_td]:border-border [&_td]:px-4 [&_td]:py-3 [&_th]:bg-surface-2 [&_th]:px-4 [&_th]:py-2.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted">
        {children}
      </table>
    </div>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-xl bg-accent-soft px-4 py-3 text-sm font-medium text-accent-soft-text">
      {message}
    </p>
  );
}

export function FormSuccess({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="status" className="rounded-xl bg-primary-soft px-4 py-3 text-sm font-medium text-primary-soft-text">
      {message}
    </p>
  );
}
