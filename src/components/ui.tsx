import clsx from "clsx";
import Link from "next/link";
import { ArrowLeft, Search } from "lucide-react";
import { Children, cloneElement, isValidElement, useId, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { DateInput } from "./date-input";
import { FormError, FormSuccess } from "./form-error";
import { StepButton } from "./number-stepper";
import { ScrollArea } from "./scroll-area";

/*
 * Bausteine der Praxis-App (Design-System). Regeln, die hier zentral umgesetzt sind:
 *  - Farben nur über Theme-Tokens (globals.css) – hell und dunkel, Kontrast ≥ 4,5:1. Petrol (primary) = Hauptaktion,
 *    Koralle (accent) = Marketing-CTA bzw. Hinweis/Warnung, nie die Speichern-Aktion eines Formulars.
 *  - Schrift: Inhalte ≥ 13 px (Hinweise, Badges, Tabellenköpfe), 12 px nur für Metadaten; Eingaben 15 px (iOS: 16 px,
 *    siehe globals.css). Touch-Ziele ≥ 44 px (h-11 bzw. globale pointer:coarse-Regel).
 *  - Anrede: Praxis-App = du, Seiten für Patient:innen (/buchen, /p, /portal, /anamnese) = Sie.
 */

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

/**
 * Karte. `min-w-0`: in Grids/Flex-Zeilen darf die Karte schmaler werden als ihr Inhalt (breite Tabellen scrollen dann
 * in ihrer ScrollArea, statt die ganze Seite seitlich zu verschieben). Grids immer mit Basis-Spalte bauen
 * (`grid grid-cols-1 lg:grid-cols-3`), siehe globals.css.
 */
export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section className={cx("min-w-0 rounded-[var(--radius-card)] bg-surface border border-border p-5", className)} {...props} />;
}

export function CardTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <h2 className="min-w-0 font-display text-xl font-semibold wrap-break-word">{children}</h2>
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
    <span className={cx("inline-flex items-center rounded-full px-2.5 py-1 text-[13px] leading-4 font-semibold", tones[tone], className)}>
      {children}
    </span>
  );
}

/**
 * Kennzahl-Kachel. Der Wert passt sich der Kachelbreite an (Container Query: 15 % der Innenbreite, 18–30 px), damit
 * Beträge wie „54.962,60 €“ auch in schmalen Kacheln (4er-Reihe neben der Navigation auf dem iPad) nicht über den Rand
 * laufen; als letzte Rettung darf der Wert umbrechen statt überzulaufen.
 */
export function Stat({ label, value, sub, tone = "primary" }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div data-stat className={cx("@container min-w-0 rounded-[var(--radius-card)] p-5", tones[tone])}>
      <p className="text-sm font-medium">{label}</p>
      <p className="mt-2 font-display text-[clamp(1.125rem,15cqi,1.875rem)] leading-tight font-bold tabular-nums [overflow-wrap:anywhere]">{value}</p>
      {sub ? <p className="mt-1 text-[13px]">{sub}</p> : null}
    </div>
  );
}

const inputCls =
  "w-full rounded-xl border border-border bg-surface px-3.5 h-11 text-[15px] text-text placeholder:text-muted focus:border-primary focus:outline-none aria-invalid:border-danger disabled:cursor-not-allowed disabled:opacity-60";
/** Rahmen für Eingaben mit Einheit/Stepper (Rahmen + Fokusring am Rahmen, siehe globals.css .podo-affix) */
const affixCls =
  "podo-affix flex h-11 w-full min-w-0 items-center rounded-xl border border-border bg-surface text-[15px] text-text has-[input:focus]:border-primary has-[input[aria-invalid=true]]:border-danger has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-60";
/** Zahlenfeld ohne Browser-Pfeile (sie lagen über der Einheit) */
const noSpinCls = "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

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

/** Hinweistext unter Feldern (13 px; Mindestgröße für Inhalte) */
export const hintCls = "text-[13px] leading-5 text-muted";

/**
 * Feld = Beschriftung · Eingabe · optionaler Hinweis darunter.
 * Ist das Kind eine einzelne Eingabe (<Input>, <Select>, <Textarea>, <SearchInput> oder ein natives Element), steht
 * nur die Beschriftung im <label> (htmlFor); Hinweis und Fehler sind Geschwister und per `aria-describedby` an der
 * Eingabe verknüpft – so werden sie als Beschreibung vorgelesen, nicht als Teil des Namens. Ohne `id` erzeugt Field
 * eine (useId). `error` setzt zusätzlich `aria-invalid`.
 * Andere Kinder (eigene Komponenten, mehrere Elemente): wie bisher alles in einem umschließenden <label>.
 */
export function Field({ label, hint, error, id, children, className }: { label: string; hint?: ReactNode; error?: string | null; id?: string; children: ReactNode; className?: string }) {
  const autoId = useId();
  const only = Children.count(children) === 1 && isValidElement(children) ? (children as ReactElement<Record<string, unknown>>) : null;
  const direct = !!only && FIELD_CONTROLS.has(only.type);
  if (!direct) {
    return (
      <label className={cx(fieldCls, className)}>
        <span className={fieldLabelCls}>{label}</span>
        <span className="flex min-w-0 flex-col gap-1.5">
          {children}
          {error ? <span className="text-[13px] leading-5 font-medium text-danger">{error}</span> : null}
          {hint ? <span className={hintCls}>{hint}</span> : null}
        </span>
      </label>
    );
  }
  const controlId = (only.props.id as string | undefined) ?? id ?? autoId;
  const errId = error ? `${controlId}-fehler` : undefined;
  const hintId = hint ? `${controlId}-hinweis` : undefined;
  const describedBy = [only.props["aria-describedby"], errId, hintId].filter(Boolean).join(" ") || undefined;
  const control = cloneElement(only, { id: controlId, ...(error ? { "aria-invalid": true } : {}), ...(describedBy ? { "aria-describedby": describedBy } : {}) });
  return (
    <div className={cx(fieldCls, className)}>
      <label htmlFor={controlId} className={fieldLabelCls}>
        {label}
      </label>
      <div className="flex min-w-0 flex-col gap-1.5">
        {control}
        {error ? (
          <span id={errId} className="text-[13px] leading-5 font-medium text-danger">
            {error}
          </span>
        ) : null}
        {hint ? (
          <span id={hintId} className={hintCls}>
            {hint}
          </span>
        ) : null}
      </div>
    </div>
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

const DATE_TYPES = new Set(["date", "time", "datetime-local", "month", "week"]);

/**
 * Tastatur für Zahlenfelder: ganze Zahlen → „numeric“ (Ziffernblock ohne Komma), sonst „decimal“.
 * Ein ausdrücklich gesetztes inputMode gewinnt.
 */
export function numberInputMode(step: ComponentProps<"input">["step"], explicit?: ComponentProps<"input">["inputMode"]): ComponentProps<"input">["inputMode"] {
  if (explicit) return explicit;
  if (step == null || step === "") return "numeric";
  if (step === "any") return "decimal";
  return Number.isInteger(Number(step)) ? "numeric" : "decimal";
}

/**
 * Eingabe.
 * - `suffix` zeigt eine Einheit rechts im Feld (z. B. „Wochen“, „€“) – so bleibt die Beschriftung kurz. Die Einheit
 *   steht neben der Eingabe (nicht darüber gelegt): lange Einheiten und Werte überlappen nie. Zahlenfelder mit
 *   Einheit zeigen keine Browser-Pfeile (sie lagen auf der Einheit) und öffnen auf Touch-Geräten den Ziffernblock.
 *   Screenreader lesen die Einheit ausgeschrieben mit (`suffixSpoken`, Standard aus UNIT_SPOKEN bzw. die Einheit).
 * - `stepper` (nur type="number"): −/+-Knöpfe (44 px) links/rechts, z. B. für „Alle [n] Wochen“ mit kleinem Bereich.
 * - Datum/Uhrzeit: leere Felder zeigen deutlich „leer“ (statt eines Platzhalter-Datums, das wie ein Wert aussieht),
 *   `placeholder` ersetzt den Text (z. B. „ohne Ende“); `clearable` zeigt einen ×-Knopf zum Leeren. Siehe date-input.tsx.
 */
export function Input({
  className,
  suffix,
  suffixSpoken,
  stepper,
  clearable,
  ...props
}: ComponentProps<"input"> & { suffix?: string; suffixSpoken?: string; stepper?: boolean; clearable?: boolean }) {
  const isNumber = props.type === "number";
  if (props.type && DATE_TYPES.has(props.type) && suffix == null) return <DateInput className={cx(inputCls, className)} clearable={clearable} {...props} />;
  if (suffix == null && !(stepper && isNumber)) return <input className={cx(inputCls, className)} {...props} />;
  const inputMode = isNumber ? numberInputMode(props.step, props.inputMode) : props.inputMode;
  const unit = suffix ? (suffixSpoken ?? UNIT_SPOKEN[suffix] ?? suffix) : "";
  const withStepper = !!stepper && isNumber;
  return (
    <span className={affixCls}>
      {withStepper ? <StepButton dir={-1} label={`Weniger${unit ? ` ${unit}` : ""}`} disabled={props.disabled} /> : null}
      <input
        className={cx(
          "touch-compact h-full min-w-0 flex-1 rounded-xl bg-transparent text-text placeholder:text-muted focus:outline-none disabled:cursor-not-allowed",
          withStepper ? "px-1 text-center" : "pl-3.5",
          suffix ? "pr-1.5" : withStepper ? "" : "pr-3.5",
          isNumber && noSpinCls,
          className,
        )}
        {...props}
        inputMode={inputMode}
      />
      {suffix ? (
        <span aria-hidden className={cx("shrink-0 text-sm text-muted select-none", withStepper ? "pr-1" : "pr-3.5")}>
          {suffix}
        </span>
      ) : null}
      {suffix ? <span className="sr-only">{` in ${unit}`}</span> : null}
      {withStepper ? <StepButton dir={1} label={`Mehr${unit ? ` ${unit}` : ""}`} disabled={props.disabled} /> : null}
    </span>
  );
}

/**
 * Suchfeld mit Lupe (44 px, Tastatur „Suchen“). `label` ist der zugängliche Name, falls keine sichtbare Beschriftung
 * (<Field>) daneben steht.
 */
export function SearchInput({ className, label, ...props }: Omit<ComponentProps<"input">, "type"> & { label?: string }) {
  return (
    <span className="relative block w-full min-w-0">
      <Search size={18} aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted" />
      <input type="search" enterKeyHint="search" autoComplete="off" aria-label={label} className={cx(inputCls, "pl-10", className)} {...props} />
    </span>
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cx(inputCls, "pr-8", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cx(inputCls, "h-auto min-h-24 py-2.5", className)} {...props} />;
}

/**
 * Kontrollkästchen mit Beschriftung: Kästchen fest 20 px (schrumpft nicht bei langen Texten), oben an der ersten Zeile
 * ausgerichtet; die ganze Beschriftung ist Trefffläche (≥ 44 px hoch).
 */
export function Checkbox({ label, className, ...props }: ComponentProps<"input"> & { label: ReactNode }) {
  return (
    <label className={cx("flex min-h-11 cursor-pointer items-start gap-3 py-2.5 text-[15px] leading-6", className)}>
      <input type="checkbox" className="mt-0.5 size-5 shrink-0 cursor-pointer accent-[var(--primary)]" {...props} />
      <span className="min-w-0">{label}</span>
    </label>
  );
}

/** Leerer Zustand; `action` zeigt den nächsten Schritt (z. B. „+ Termin“, „Alle anzeigen“). */
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-border-strong p-8 text-center">
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-2 text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

/**
 * Tabelle in einem seitlich scrollbaren Bereich (ScrollArea): wird sie breiter als der Platz, ist der Bereich per
 * Tastatur erreichbar (Tab, Pfeiltasten), hat einen Namen (`label`, z. B. „Rechnungen“) und zeigt am Rand einen
 * Schatten als Scroll-Hinweis. `minWidth` (Standard 640 px) ist die Breite, unter der gescrollt wird.
 */
export function Table({ children, label, minWidth = 640 }: { children: ReactNode; label?: string; minWidth?: number }) {
  return (
    <ScrollArea label={label} className="rounded-[var(--radius-card)] border border-border bg-surface">
      <table
        style={{ minWidth }}
        className="w-full border-collapse text-left text-[15px] [&_td]:border-t [&_td]:border-border [&_td]:px-4 [&_td]:py-3 [&_th]:bg-surface-2 [&_th]:px-4 [&_th]:py-2.5 [&_th]:text-[13px] [&_th]:leading-5 [&_th]:font-semibold [&_th]:text-muted"
      >
        {children}
      </table>
    </ScrollArea>
  );
}

/**
 * Aktionsleiste am Formularende (Speichern, Abbrechen …). `sticky` (Standard): bleibt bei langen Formularen am
 * unteren Rand sichtbar – über der Bottom-Navigation und der Home-Leiste (Abstand --podo-sticky-bottom, globals.css).
 * `error`: Kurzfassung der Fehlermeldung direkt neben dem Knopf (die ausführliche Meldung steht oben im Formular und
 * wird beim Absenden angesprungen; hier aria-hidden, damit Screenreader sie nicht doppelt hören).
 * Primär-Knopf zuerst, dann sekundäre Aktionen.
 */
export function FormActions({ children, error, sticky = true, className }: { children: ReactNode; error?: string | null; sticky?: boolean; className?: string }) {
  return (
    <div
      data-form-actions
      className={cx(
        "flex flex-wrap items-center gap-x-3 gap-y-2",
        sticky && "podo-form-actions sticky bottom-[var(--podo-sticky-bottom)] z-20 rounded-2xl border border-border bg-surface p-2 shadow-[0_6px_24px_-6px_color-mix(in_srgb,var(--text)_28%,transparent)]",
        className,
      )}
    >
      {children}
      {error ? (
        <p aria-hidden className="line-clamp-2 min-w-0 flex-[1_1_12rem] text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Umschalter für Ansichten/Filter (Tag · Woche · Monat, Offen · Bezahlt …) als Links – überall gleich: 40 px hoch,
 * auf Touch-Geräten 44 px, aktiver Eintrag mit Fläche und `aria-current`. Für eigene Umschalter in Client-Komponenten
 * (Knöpfe) `segmentGroupCls`/`segmentItemCls` verwenden.
 */
export const segmentGroupCls = "inline-flex max-w-full flex-wrap gap-1 rounded-xl border border-border bg-surface-2 p-1";
export function segmentItemCls(active: boolean) {
  return cx(
    "inline-flex h-10 min-w-11 items-center justify-center gap-1.5 rounded-lg px-3.5 text-sm font-semibold whitespace-nowrap transition-colors",
    active ? "bg-surface text-text shadow-sm ring-1 ring-border" : "text-muted hover:bg-surface hover:text-text",
  );
}
export function SegmentedControl({
  label,
  items,
  className,
}: {
  /** zugänglicher Name der Gruppe, z. B. „Ansicht“ */
  label: string;
  items: { href: ComponentProps<typeof Link>["href"]; label: ReactNode; active?: boolean; title?: string }[];
  className?: string;
}) {
  return (
    <nav aria-label={label} className={cx(segmentGroupCls, className)}>
      {items.map((it, i) => (
        <Link key={i} href={it.href} title={it.title} aria-current={it.active ? "page" : undefined} className={segmentItemCls(!!it.active)}>
          {it.label}
        </Link>
      ))}
    </nav>
  );
}

export { FormError, FormSuccess };

/** Kinder, denen Field id/aria-* direkt geben kann (die Props landen am <input>/<select>/<textarea>) */
const FIELD_CONTROLS = new Set<unknown>(["input", "select", "textarea", Input, Select, Textarea, SearchInput]);
