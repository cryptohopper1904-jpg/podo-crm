import type { ReactNode } from "react";
import { Bot, CalendarCheck, Camera, Check, Footprints, Lock, PhoneCall, Receipt, Send } from "lucide-react";
import { FOOT_POINTS } from "@/lib/foot-points";

/**
 * Stilisierte App-Collage für den Startseiten-Hero (nur Darstellung, keine echten Daten).
 * Desktop/Tablet: Karten frei um das iPad angeordnet. Mobil: iPad + Karten untereinander.
 * Animationen nur mit `motion-safe:` – bei „Bewegung reduzieren“ steht alles still.
 */

const FOOT_PATH =
  "M30 40 C 25 15, 50 8, 52 28 C 55 10, 70 10, 70 26 C 74 14, 86 18, 85 32 C 90 24, 100 30, 96 42 C 104 38, 110 48, 104 58 C 112 90, 106 130, 100 160 C 96 190, 90 222, 62 222 C 34 222, 30 196, 30 170 C 30 140, 22 110, 24 80 C 25 62, 26 50, 30 40 Z";
const MARKED = new Set(["N1", "MT1"]);

/** Einblenden mit Verzögerung; optional sanftes Schweben (getrennte Elemente, damit sich die Transforms nicht stören). */
function Float({ delay, bob = false, className = "", children }: { delay: number; bob?: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={`motion-safe:animate-rise ${className}`} style={{ animationDelay: `${delay}ms` }}>
      <div className={bob ? "motion-safe:animate-bob" : undefined} style={bob ? { animationDelay: `${delay + 700}ms` } : undefined}>
        {children}
      </div>
    </div>
  );
}

function CardShell({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-border bg-surface p-3.5 shadow-[0_12px_32px_-12px_rgb(15_42_46/0.28)] ${className}`}>{children}</div>;
}

function IconDot({ children, tone }: { children: ReactNode; tone: "primary" | "accent" | "info" | "warn" }) {
  const cls = {
    primary: "bg-primary-soft text-primary-soft-text",
    accent: "bg-accent-soft text-accent-soft-text",
    info: "bg-info-soft text-info-soft-text",
    warn: "bg-warn-soft text-warn-soft-text",
  }[tone];
  return <span className={`inline-flex size-9 shrink-0 items-center justify-center rounded-xl ${cls}`}>{children}</span>;
}

function TabletDoc() {
  return (
    <div className="rounded-[26px] bg-[#10272b] p-2.5 dark:bg-[#2a4549] shadow-[0_24px_60px_-20px_rgb(15_42_46/0.45)] ring-1 ring-border-strong/40 sm:p-3">
      <div className="overflow-hidden rounded-[18px] bg-bg">
        {/* Kopfzeile der Akte */}
        <div className="flex items-center gap-2.5 border-b border-border bg-surface px-3.5 py-2.5">
          <span className="inline-flex size-8 items-center justify-center rounded-full bg-primary-soft text-xs font-bold text-primary-soft-text">MK</span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold leading-tight">Marta K. · Behandlung</p>
            <p className="text-[11px] leading-tight text-muted">Heute, 9:00 · Komplexbehandlung</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 px-3.5 pt-2.5">
          <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] font-semibold text-accent-soft-text">Diabetes</span>
          <span className="rounded-full bg-warn-soft px-2.5 py-0.5 text-[11px] font-semibold text-warn-soft-text">Blutverdünner</span>
          <span className="rounded-full bg-info-soft px-2.5 py-0.5 text-[11px] font-semibold text-info-soft-text">IWGDF 2</span>
        </div>
        <div className="grid grid-cols-[1.15fr_0.85fr] gap-3 p-3.5">
          {/* Leistungen + Pflichtfoto-Checkliste */}
          <div className="flex flex-col gap-1.5">
            <div className="grid grid-cols-3 gap-1.5">
              {["PK", "ON", "TB"].map((c, i) => (
                <span
                  key={c}
                  className={`rounded-lg border py-1.5 text-center text-xs font-semibold ${i === 0 ? "border-primary bg-primary-soft text-primary-soft-text" : "border-border bg-surface"}`}
                >
                  {c}
                </span>
              ))}
            </div>
            {[
              { icon: Camera, label: "Foto vorher" },
              { icon: Camera, label: "Foto nachher" },
              { icon: Lock, label: "Charge 2411-07" },
            ].map(({ icon: Icon, label }, i) => (
              <div key={label} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs">
                <Icon size={14} className="shrink-0 text-primary" />
                <span className="truncate">{label}</span>
                <Check
                  size={14}
                  strokeWidth={3}
                  className="ml-auto shrink-0 text-primary motion-safe:animate-rise"
                  style={{ animationDelay: `${900 + i * 250}ms` }}
                />
              </div>
            ))}
            <div className="mt-auto rounded-lg bg-primary py-1.5 text-center text-xs font-semibold text-on-primary">Abschließen</div>
          </div>
          {/* Fuß mit Markierungen */}
          <div className="relative flex items-center justify-center rounded-xl border border-border bg-surface pb-2 pt-8">
            <span className="absolute left-2 top-2 inline-flex rounded-lg border border-border p-0.5 text-[11px] font-semibold">
              <span className="rounded-md px-1.5 py-0.5 text-muted">2D</span>
              <span className="rounded-md bg-primary px-1.5 py-0.5 text-on-primary">3D</span>
            </span>
            <svg viewBox="0 0 130 230" className="h-36 w-auto sm:h-44">
              <path d={FOOT_PATH} fill="var(--foot-skin)" stroke="var(--border-strong)" strokeWidth="2" />
              {FOOT_POINTS.map((p) =>
                MARKED.has(p.id) ? (
                  <g key={p.id}>
                    <circle cx={p.x} cy={p.y} r={9} className="origin-center fill-accent/40 motion-safe:animate-ping-soft [transform-box:fill-box]" />
                    <circle cx={p.x} cy={p.y} r={8} fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
                  </g>
                ) : (
                  <circle key={p.id} cx={p.x} cy={p.y} r={5} fill="var(--surface)" stroke="var(--primary)" strokeWidth="1.5" opacity={0.75} />
                ),
              )}
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

function PhoneCallCard() {
  return (
    <div className="rounded-2xl border border-border bg-surface p-3.5 shadow-[0_12px_32px_-12px_rgb(15_42_46/0.28)] sm:rounded-[30px] sm:border-[7px] sm:border-[#10272b] sm:p-3 sm:pt-4 dark:sm:border-[#2a4549]">
      <div className="hidden justify-center sm:flex">
        <span className="-mt-2 mb-2 h-1.5 w-14 rounded-full bg-[#10272b] dark:bg-[#2a4549]" />
      </div>
      <div className="flex items-center gap-2.5">
        <span className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary">
          <span className="absolute inset-0 rounded-full bg-primary motion-safe:animate-ping-soft" />
          <PhoneCall size={16} className="relative" />
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold leading-tight">KI-Assistent</p>
          <p className="text-[11px] leading-tight text-muted">Anruf angenommen</p>
        </div>
      </div>
      <p className="mt-2.5 rounded-xl rounded-tl-sm bg-surface-2 px-2.5 py-1.5 text-xs">„Haben Sie Freitag vormittags noch etwas frei?“</p>
      <p className="mt-1.5 ml-4 flex items-start gap-1.5 rounded-xl rounded-tr-sm bg-primary-soft px-2.5 py-1.5 text-xs text-primary-soft-text">
        <Bot size={14} className="mt-px shrink-0" /> „Ja, um 10:30 Uhr. Ich trage den Wunsch ein.“
      </p>
      <div className="mt-2.5 rounded-xl border border-border p-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Terminwunsch</p>
        <p className="text-[13px] font-semibold">Fr 10:30 · Fußpflege</p>
        <div className="mt-2 flex gap-1.5">
          <span className="flex-1 rounded-lg bg-primary py-1 text-center text-xs font-semibold text-on-primary">Bestätigen</span>
          <span className="rounded-lg border border-border px-2 py-1 text-xs">Rückruf</span>
        </div>
      </div>
    </div>
  );
}

function BookingCard() {
  return (
    <CardShell>
      <div className="flex items-start gap-2.5">
        <IconDot tone="info"><CalendarCheck size={18} /></IconDot>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold leading-tight">Online gebucht</p>
          <p className="text-[11px] leading-tight text-muted">über das Patientenportal</p>
        </div>
      </div>
      <div className="mt-2.5 rounded-xl bg-surface-2 px-2.5 py-2 text-xs">
        <p className="font-semibold">Di 9:00 · Spangenkontrolle</p>
        <p className="mt-0.5 flex items-center gap-1 text-muted">
          <Footprints size={12} /> Nachrücker von der Warteliste
        </p>
      </div>
    </CardShell>
  );
}

function CashCard() {
  const bars = [
    { label: "Bar", w: "w-[42%]", cls: "bg-primary" },
    { label: "Karte", w: "w-[78%]", cls: "bg-accent" },
    { label: "Gutschein", w: "w-[18%]", cls: "bg-border-strong" },
  ];
  return (
    <CardShell>
      <div className="flex items-start gap-2.5">
        <IconDot tone="accent"><Receipt size={18} /></IconDot>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold leading-tight">Tagesabschluss</p>
          <p className="text-[11px] leading-tight text-muted">Z-Bon · TSE-signiert</p>
        </div>
      </div>
      <ul className="mt-2.5 flex flex-col gap-1.5">
        {bars.map((b) => (
          <li key={b.label} className="grid grid-cols-[4.2rem_1fr] items-center gap-2 text-[11px] text-muted">
            {b.label}
            <span className="h-2 rounded-full bg-surface-2">
              <span className={`block h-2 rounded-full ${b.w} ${b.cls}`} />
            </span>
          </li>
        ))}
      </ul>
    </CardShell>
  );
}

function ReminderChip() {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface py-1.5 pl-1.5 pr-3.5 text-xs font-semibold shadow-[0_8px_24px_-12px_rgb(15_42_46/0.3)]">
      <span className="inline-flex size-6 items-center justify-center rounded-full bg-primary-soft text-primary-soft-text">
        <Send size={12} />
      </span>
      Erinnerung für morgen verschickt
    </div>
  );
}

export function HeroCollage() {
  return (
    <div aria-hidden className="relative mx-auto w-full max-w-[560px] sm:h-[600px]">
      {/* Hintergrundflächen */}
      <div className="absolute -right-6 top-24 hidden size-72 rounded-full bg-primary-soft sm:block" />
      <div className="absolute bottom-24 left-24 hidden size-40 rounded-full bg-accent-soft sm:block" />

      <Float delay={0} className="relative sm:absolute sm:left-0 sm:top-16 sm:w-[74%]">
        <TabletDoc />
      </Float>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:contents">
        <Float delay={250} bob className="col-span-2 sm:absolute sm:bottom-0 sm:right-0 sm:w-[204px]">
          <PhoneCallCard />
        </Float>
        <Float delay={450} bob className="sm:absolute sm:right-0 sm:top-0 sm:w-[228px]">
          <BookingCard />
        </Float>
        <Float delay={650} bob className="sm:absolute sm:bottom-6 sm:left-6 sm:w-[228px]">
          <CashCard />
        </Float>
        <Float delay={850} className="hidden sm:absolute sm:left-0 sm:top-3 sm:block">
          <ReminderChip />
        </Float>
      </div>
    </div>
  );
}
