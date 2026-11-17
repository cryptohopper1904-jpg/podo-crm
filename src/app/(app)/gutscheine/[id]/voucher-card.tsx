import { Gift } from "lucide-react";
import { PracticeLogo } from "@/components/practice-logo";
import { dateDe, money } from "@/lib/format";

/**
 * Gutschein-Motive zum Ausdrucken (Wunsch aus der Praxis: mehrere Vorlagen nach Geschmack oder Anlass, mit Praxislogo).
 * Feste Farben statt Theme-Tokens, damit der Druck in Hell- und Dunkelmodus gleich aussieht.
 */
export const VOUCHER_MOTIFS = [
  { id: "klassisch", label: "Klassisch" },
  { id: "elegant", label: "Elegant" },
  { id: "natur", label: "Wohlfühlen" },
  { id: "geburtstag", label: "Geburtstag" },
  { id: "weihnachten", label: "Weihnachten" },
] as const;
export type VoucherMotif = (typeof VOUCHER_MOTIFS)[number]["id"];

export const parseMotif = (v: unknown): VoucherMotif =>
  VOUCHER_MOTIFS.some((m) => m.id === v) ? (v as VoucherMotif) : "klassisch";

export type VoucherCardData = {
  code: string;
  amountCents: number;
  issuedAt: Date | string;
  validUntil: Date | string;
  single: boolean;
};
export type VoucherOrg = { id: string; name: string; street?: string | null; zip?: string | null; city?: string | null; phone?: string | null; email?: string | null } | null | undefined;

const SERIF = { fontFamily: "Georgia, 'Times New Roman', serif" } as const;

function Contact({ org, align = "right" }: { org: VoucherOrg; align?: "left" | "right" | "center" }) {
  if (!org) return null;
  const a = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <div className={`text-sm leading-snug ${a}`}>
      <p className="font-semibold">{org.name}</p>
      {org.street ? <p>{org.street}</p> : null}
      <p>{[org.zip, org.city].filter(Boolean).join(" ")}</p>
      {org.phone ? <p>Tel. {org.phone}</p> : null}
      {org.email ? <p>{org.email}</p> : null}
    </div>
  );
}

/** Freie Zeile für den Namen der beschenkten Person (wie auf Papiervorlagen üblich). */
function ForLine({ color }: { color: string }) {
  return (
    <p className="flex items-end gap-2 text-base">
      <span>Für:</span>
      <span className="inline-block h-6 min-w-0 flex-1 border-b" style={{ borderColor: color }} />
    </p>
  );
}

function Meta({ v, color }: { v: VoucherCardData; color: string }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-t pt-3" style={{ borderColor: color }}>
      <div>
        <p className="text-[11px] uppercase tracking-wide opacity-80">Gutscheincode</p>
        <p className="font-mono text-xl font-bold tracking-wider">{v.code}</p>
      </div>
      <div className="text-right text-sm">
        <p>Ausgestellt am {dateDe(v.issuedAt)}</p>
        <p className="font-semibold">Gültig bis {dateDe(v.validUntil)}</p>
      </div>
    </div>
  );
}

const Terms = ({ v }: { v: VoucherCardData }) => (
  <p className="text-[11px] opacity-80">
    Einlösbar für alle Leistungen und Produkte{v.single ? " laut Vermerk" : ""}. Keine Barauszahlung. Restguthaben bleibt bis zum Ablauf erhalten.
  </p>
);

function Confetti() {
  // nur am Rand, damit kein Text überdeckt wird
  const dots = [
    [2, 12, "#f59e0b"], [3, 40, "#ec4899"], [2, 70, "#3b82f6"], [3, 92, "#10b981"], [20, 2, "#ec4899"], [40, 3, "#3b82f6"],
    [62, 2, "#f59e0b"], [30, 96, "#10b981"], [55, 97, "#ec4899"], [80, 96, "#3b82f6"], [97, 30, "#10b981"], [96, 62, "#f59e0b"], [97, 85, "#ec4899"],
  ] as const;
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      {dots.map(([x, y, c], i) => (
        <rect key={i} x={x} y={y} width="1.6" height="3" rx="0.6" fill={c} transform={`rotate(${(i * 37) % 90} ${x} ${y})`} opacity="0.85" />
      ))}
    </svg>
  );
}

function Snowflakes() {
  const flakes = [[4, 8, 3], [50, 4, 2], [96, 6, 3], [3, 50, 2], [97, 45, 2], [4, 94, 3], [96, 94, 3]] as const;
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden>
      {flakes.map(([x, y, s], i) => (
        <g key={i} stroke="#ffffff" strokeWidth="0.5" opacity="0.55" strokeLinecap="round">
          <line x1={x - s} y1={y} x2={x + s} y2={y} />
          <line x1={x} y1={y - s} x2={x} y2={y + s} />
          <line x1={x - s * 0.7} y1={y - s * 0.7} x2={x + s * 0.7} y2={y + s * 0.7} />
          <line x1={x - s * 0.7} y1={y + s * 0.7} x2={x + s * 0.7} y2={y - s * 0.7} />
        </g>
      ))}
    </svg>
  );
}

function Leaves() {
  return (
    <svg className="pointer-events-none absolute -bottom-4 -right-4 h-48 w-48" viewBox="0 0 100 100" aria-hidden>
      <g fill="#5fae8b" opacity="0.25">
        <path d="M50 95 C 20 70, 20 30, 60 8 C 70 45, 70 70, 50 95 Z" />
        <path d="M80 98 C 60 80, 66 50, 96 36 C 100 62, 96 82, 80 98 Z" />
      </g>
      <g stroke="#2f7d5b" strokeWidth="1" fill="none" opacity="0.4">
        <path d="M50 95 C 52 60, 56 35, 60 8" />
        <path d="M80 98 C 84 78, 90 56, 96 36" />
      </g>
    </svg>
  );
}

export function VoucherCard({ motif, v, org }: { motif: VoucherMotif; v: VoucherCardData; org: VoucherOrg }) {
  const logo = org ? <PracticeLogo organizationId={org.id} kind="full" alt={`Logo ${org.name}`} className="h-14 max-w-56" /> : null;
  const base = "voucher-card relative mx-auto w-full max-w-[180mm] overflow-hidden";

  if (motif === "elegant") {
    const navy = "#1f3a68";
    return (
      <section aria-label="Gutscheinkarte" className={`${base} bg-white p-2`} style={{ color: navy }}>
        <div className="border-2 p-1" style={{ borderColor: "#b8975a" }}>
          <div className="flex flex-col gap-4 border px-8 py-6" style={{ borderColor: "#b8975a" }}>
            <div className="flex items-start justify-between gap-6">
              {logo ?? <p className="text-xl font-semibold" style={SERIF}>{org?.name}</p>}
              <Contact org={org} />
            </div>
            <div className="text-center">
              <p className="text-5xl italic" style={SERIF}>Gutschein</p>
              <p className="mt-1 text-sm tracking-[0.3em] uppercase" style={{ color: "#b8975a" }}>im Wert von</p>
              <p className="mt-1 text-4xl font-bold tabular-nums" style={SERIF}>{money(v.amountCents)}</p>
            </div>
            <ForLine color={navy} />
            <Meta v={v} color="#b8975a" />
            <Terms v={v} />
          </div>
        </div>
      </section>
    );
  }

  if (motif === "natur") {
    const green = "#1f5e45";
    return (
      <section aria-label="Gutscheinkarte" className={`${base} rounded-2xl`} style={{ color: green, background: "linear-gradient(135deg, #f1f8f3 0%, #e3f1e8 100%)" }}>
        <Leaves />
        <div className="relative grid gap-4 p-8 sm:grid-cols-[1fr_auto]">
          <div className="flex flex-col gap-3">
            {logo}
            <p className="text-sm uppercase tracking-[0.25em]">Gutschein</p>
            <p className="text-3xl font-semibold" style={SERIF}>Eine kleine Auszeit für Ihre Füße</p>
            <p className="text-5xl font-bold tabular-nums">{money(v.amountCents)}</p>
          </div>
          <Contact org={org} />
          <div className="sm:col-span-2"><ForLine color={green} /></div>
          <div className="flex flex-col gap-3 sm:col-span-2">
            <Meta v={v} color={green} />
            <Terms v={v} />
          </div>
        </div>
      </section>
    );
  }

  if (motif === "geburtstag") {
    const ink = "#7a2342";
    return (
      <section aria-label="Gutscheinkarte" className={`${base} rounded-2xl border-2`} style={{ color: ink, borderColor: "#f3b6c8", background: "#fff7f0" }}>
        <Confetti />
        <div className="relative flex flex-col gap-4 p-8">
          <div className="flex items-start justify-between gap-6">
            {logo ?? <span />}
            <Contact org={org} />
          </div>
          <div className="text-center">
            <p className="text-4xl font-bold" style={SERIF}>Alles Gute zum Geburtstag!</p>
            <p className="mt-2 text-sm uppercase tracking-[0.25em]">Gutschein über</p>
            <p className="mt-1 text-5xl font-bold tabular-nums" style={{ color: "#d9467a" }}>{money(v.amountCents)}</p>
          </div>
          <ForLine color={ink} />
          <Meta v={v} color="#f3b6c8" />
          <Terms v={v} />
        </div>
      </section>
    );
  }

  if (motif === "weihnachten") {
    return (
      <section aria-label="Gutscheinkarte" className={`${base} rounded-2xl text-white`} style={{ background: "linear-gradient(160deg, #8c1c2b 0%, #5e1220 100%)" }}>
        <Snowflakes />
        <div className="relative flex flex-col gap-4 p-8">
          <div className="flex items-start justify-between gap-6">
            {logo ? <div className="rounded-lg bg-white p-2">{logo}</div> : <span />}
            <Contact org={org} />
          </div>
          <div className="text-center">
            <p className="text-4xl italic" style={SERIF}>Frohe Weihnachten</p>
            <p className="mt-2 text-sm uppercase tracking-[0.25em]" style={{ color: "#f1d48a" }}>Gutschein über</p>
            <p className="mt-1 text-5xl font-bold tabular-nums" style={{ color: "#f1d48a" }}>{money(v.amountCents)}</p>
          </div>
          <ForLine color="#f1d48a" />
          <Meta v={v} color="#f1d48a" />
          <Terms v={v} />
        </div>
      </section>
    );
  }

  // Klassisch – bisheriges Layout, ergänzt um Logo und „Für“-Zeile
  return (
    <section
      aria-label="Gutscheinkarte"
      className={`${base} rounded-[var(--radius-card)] border-2 border-dashed p-8`}
      style={{ borderColor: "#0f766e", background: "#ecf8f6", color: "#134e4a" }}
    >
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div>
          {logo ? <div className="mb-3">{logo}</div> : null}
          <p className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest">
            <Gift size={18} aria-hidden /> Gutschein
          </p>
          <p className="mt-3 font-display text-5xl font-bold tabular-nums">{money(v.amountCents)}</p>
        </div>
        <Contact org={org} />
      </div>
      <div className="mt-6"><ForLine color="#0f766e" /></div>
      <div className="mt-6"><Meta v={v} color="#0f766e" /></div>
      <div className="mt-3"><Terms v={v} /></div>
    </section>
  );
}
