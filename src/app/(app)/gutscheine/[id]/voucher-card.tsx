import type { CSSProperties, ReactNode } from "react";
import "@fontsource/cormorant-garamond/latin-500-italic.css";
import "@fontsource/cormorant-garamond/latin-600.css";
import "@fontsource/dm-serif-display/latin-400.css";
import "@fontsource-variable/fraunces/index.css";
import { PracticeLogo } from "@/components/practice-logo";
import { dateDe, money } from "@/lib/format";

/**
 * Gutschein-Motive zum Ausdrucken (Wunsch der Pilotpraxis: Vorlagen nach Geschmack oder Anlass, mit Praxislogo).
 * Format DIN lang (210 × 99 mm); im Druck auf die bedruckbare A4-Breite verkleinert (PRINT_CSS in page.tsx). Feste Farben statt Theme-Tokens, damit der Druck in Hell- und
 * Dunkelmodus gleich aussieht; Schriften lokal (fontsource), keine externen Abrufe.
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
export type VoucherOrg = { id: string; name: string; street?: string | null; zip?: string | null; city?: string | null; phone?: string | null } | null | undefined;

const INTER = "'Inter Variable', Inter, ui-sans-serif, sans-serif";
const GROTESK = "'Space Grotesk Variable', 'Inter Variable', sans-serif";
const CORMORANT = "'Cormorant Garamond', Georgia, serif";
const FRAUNCES = "'Fraunces Variable', Georgia, serif";
const DMSERIF = "'DM Serif Display', Georgia, serif";

const P: CSSProperties = { margin: 0 };
const caps = (size: number, spacing: string, color?: string): CSSProperties => ({ ...P, fontSize: size, letterSpacing: spacing, textTransform: "uppercase", color });

/** Kartenrahmen: am Bildschirm exakt DIN lang, auf schmalen Bildschirmen seitlich scrollbar (Druck: siehe PRINT_CSS) */
function Frame({ children, style }: { children: ReactNode; style: CSSProperties }) {
  return (
    <div className="voucher-card mx-auto max-w-full overflow-x-auto">
      <section
        aria-label="Gutscheinkarte"
        style={{ width: "210mm", height: "99mm", boxSizing: "border-box", position: "relative", overflow: "hidden", flexShrink: 0, ...style }}
      >
        {children}
      </section>
    </div>
  );
}

/** Schreiblinie „Für“/„Von“ zum Ausfüllen von Hand */
function Line({ label, color, style }: { label: string; color: string; style?: CSSProperties }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 8, ...style }}>
      <span>{label}</span>
      <span style={{ flexGrow: 1, borderBottom: `1px solid ${color}`, height: 20 }} />
    </div>
  );
}

/** Praxislogo (vollständig) in fester Höhe; ohne hochgeladenes Logo bleibt die Stelle leer */
function OrgLogo({ org, h, w, box }: { org: VoucherOrg; h: number; w: number; box?: CSSProperties }) {
  if (!org) return null;
  return (
    <div style={{ height: h, maxWidth: w, display: "flex", alignItems: "center", ...box }} className="[&_img]:h-full [&_img]:max-w-full">
      <PracticeLogo organizationId={org.id} kind="full" alt={`Logo ${org.name}`} />
    </div>
  );
}

const placeLine = (o: VoucherOrg) => [[o?.zip, o?.city].filter(Boolean).join(" "), o?.phone].filter(Boolean).join(" · ");
const singleNote = (v: VoucherCardData) => (v.single ? " Einlösbar laut Vermerk." : "");

export function VoucherCard({ motif, v, org }: { motif: VoucherMotif; v: VoucherCardData; org: VoucherOrg }) {
  const amount = money(v.amountCents);

  if (motif === "elegant") {
    const navy = "#1d3557";
    const gold = "#b08d4a";
    const serif: CSSProperties = { fontFamily: CORMORANT };
    return (
      <Frame style={{ background: "#fbf9f4", padding: 14, fontFamily: INTER, color: navy }}>
        <div style={{ height: "100%", boxSizing: "border-box", border: `1.5px solid ${gold}`, padding: 5 }}>
          <div style={{ height: "100%", boxSizing: "border-box", border: `1px solid ${gold}`, padding: "22px 36px 20px", display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.3fr) minmax(0,1fr)", gap: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
              <OrgLogo org={org} h={52} w={160} />
              <div style={{ fontSize: 12, lineHeight: 1.55, color: "#3a4a63" }}>
                <p style={{ ...P, fontWeight: 600, color: navy }}>{org?.name}</p>
                {org?.street ? <p style={P}>{org.street}</p> : null}
                <p style={P}>{[org?.zip, org?.city].filter(Boolean).join(" ")}</p>
                {org?.phone ? <p style={P}>{org.phone}</p> : null}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: 4 }}>
              <p style={caps(11, "0.32em", "#8a7346")}>Ein Geschenk für Sie</p>
              <p style={{ ...P, ...serif, fontStyle: "italic", fontWeight: 500, fontSize: 64, lineHeight: 1 }}>Gutschein</p>
              <div style={{ width: 64, height: 1, background: gold, margin: "8px 0" }} />
              <p style={caps(11, "0.24em", "#8a7346")}>im Wert von</p>
              <p style={{ ...P, ...serif, fontWeight: 600, fontSize: 44, lineHeight: 1.05 }} className="tabular-nums">{amount}</p>
            </div>
            <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", textAlign: "right" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, textAlign: "left", marginTop: 6, ...serif, fontSize: 19 }}>
                <Line label="Für" color={navy} />
                <Line label="Von" color={navy} />
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.55, color: "#3a4a63" }}>
                <p style={caps(10, "0.2em", "#8a7346")}>Gutscheincode</p>
                <p style={{ ...P, marginBottom: 6, fontSize: 16, fontWeight: 600, letterSpacing: "0.08em", color: navy }}>{v.code}</p>
                <p style={P}>Ausgestellt am {dateDe(v.issuedAt)}</p>
                <p style={{ ...P, fontWeight: 600, color: navy }}>Gültig bis {dateDe(v.validUntil)}</p>
                <p style={{ ...P, marginTop: 6, fontSize: 10.5, color: "#5a6578" }}>Keine Barauszahlung.{singleNote(v)}</p>
              </div>
            </div>
          </div>
        </div>
      </Frame>
    );
  }

  if (motif === "natur") {
    const ink = "#24402f";
    const sage = "#9cb8a2";
    return (
      <Frame style={{ background: "#f3f1ea", fontFamily: INTER, color: ink }}>
        <svg aria-hidden width="300" height="374" viewBox="0 0 300 374" style={{ position: "absolute", right: 0, top: 0, height: "100%" }}>
          <path d="M300 0 L300 374 L120 374 C 60 300, 70 200, 150 140 C 210 95, 250 60, 300 0 Z" fill={sage} opacity="0.35" />
          <path d="M210 374 C 200 300, 230 250, 300 220 L300 374 Z" fill={sage} opacity="0.55" />
          <g fill="none" stroke="#2f5d46">
            <path d="M232 92 C 268 104, 284 140, 276 176 C 240 166, 222 130, 232 92 Z" strokeWidth="1.5" />
            <path d="M234 96 C 250 124, 262 150, 274 172" strokeWidth="1.2" />
            <path d="M196 180 C 226 176, 254 196, 262 226 C 230 232, 204 214, 196 180 Z" strokeWidth="1.5" />
            <path d="M200 184 C 220 196, 242 210, 258 224" strokeWidth="1.2" />
          </g>
        </svg>
        <div style={{ position: "relative", boxSizing: "border-box", height: "100%", padding: "32px 40px 26px", display: "flex", flexDirection: "column", gap: 14, width: 560 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
            <OrgLogo org={org} h={50} w={180} />
            <p style={caps(11, "0.28em", "#4a6656")}>Gutschein</p>
          </div>
          <p style={{ ...P, marginTop: 6, fontFamily: FRAUNCES, fontWeight: 400, fontSize: 34, lineHeight: 1.12 }}>
            Eine kleine Auszeit
            <br />
            für Ihre Füße
          </p>
          <p style={{ ...P, fontFamily: FRAUNCES, fontWeight: 600, fontSize: 46, lineHeight: 1 }} className="tabular-nums">{amount}</p>
          <Line label="Für" color={ink} style={{ fontSize: 14, marginTop: 4, gap: 10 }} />
          <div style={{ marginTop: "auto", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, fontSize: 12, lineHeight: 1.5, color: "#3d5a49" }}>
            <div>
              <p style={caps(10, "0.18em")}>Code</p>
              <p style={{ ...P, fontSize: 16, fontWeight: 600, letterSpacing: "0.06em", color: ink }}>{v.code}</p>
            </div>
            <div>
              <p style={P}>Gültig bis <strong style={{ color: ink }}>{dateDe(v.validUntil)}</strong></p>
              <p style={P}>Ausgestellt am {dateDe(v.issuedAt)}</p>
            </div>
            <div style={{ textAlign: "right" }}>
              <p style={{ ...P, fontWeight: 600, color: ink }}>{org?.name}</p>
              <p style={P}>{placeLine(org)}</p>
            </div>
          </div>
        </div>
      </Frame>
    );
  }

  if (motif === "geburtstag") {
    const ink = "#4a1d2c";
    const coral = "#d6455f";
    return (
      <Frame style={{ background: "#fff6ef", fontFamily: INTER, color: ink }}>
        <svg aria-hidden viewBox="0 0 794 374" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
          <circle cx="40" cy="44" r="7" fill={coral} />
          <rect x="96" y="20" width="18" height="7" rx="3.5" fill="#f2b84b" transform="rotate(-24 105 23)" />
          <path d="M22 140 l10 -10 l10 10 l-10 10 Z" fill="#7cc4b0" />
          <rect x="18" y="300" width="20" height="7" rx="3.5" fill="#f2b84b" transform="rotate(30 28 303)" />
          <circle cx="70" cy="344" r="5" fill="#7cc4b0" />
          <circle cx="742" cy="30" r="6" fill="#7cc4b0" />
          <rect x="680" y="16" width="20" height="7" rx="3.5" fill={coral} transform="rotate(18 690 19)" />
          <path d="M760 112 l9 -9 l9 9 l-9 9 Z" fill="#f2b84b" />
          <circle cx="770" cy="250" r="7" fill={coral} />
          <rect x="720" y="344" width="20" height="7" rx="3.5" fill="#7cc4b0" transform="rotate(-30 730 347)" />
          <circle cx="420" cy="18" r="4" fill="#f2b84b" />
          <circle cx="360" cy="356" r="5" fill={coral} />
        </svg>
        <div style={{ position: "relative", boxSizing: "border-box", height: "100%", padding: "30px 72px 24px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
            <OrgLogo org={org} h={48} w={170} />
            <div style={{ textAlign: "right", fontSize: 12, lineHeight: 1.5, color: "#6a3445", marginLeft: "auto" }}>
              <p style={{ ...P, fontWeight: 600, color: ink }}>{org?.name}</p>
              <p style={P}>{placeLine(org)}</p>
            </div>
          </div>
          <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, marginTop: 4 }}>
            <p style={{ ...P, fontFamily: DMSERIF, fontSize: 44, lineHeight: 1.05 }}>Alles Gute zum Geburtstag!</p>
            <p style={{ ...caps(11, "0.26em", "#8a4458"), marginTop: 6 }}>Ein Gutschein über</p>
            <p style={{ ...P, fontFamily: DMSERIF, fontSize: 50, lineHeight: 1.05, color: coral }} className="tabular-nums">{amount}</p>
          </div>
          <div style={{ display: "flex", gap: 32, fontSize: 14 }}>
            <Line label="Für" color={ink} style={{ flex: "1 1 0" }} />
            <Line label="Von" color={ink} style={{ flex: "1 1 0" }} />
          </div>
          <div style={{ marginTop: "auto", display: "flex", justifyContent: "space-between", alignItems: "flex-end", fontSize: 12, lineHeight: 1.5, color: "#6a3445" }}>
            <p style={P}>Code <strong style={{ fontSize: 14, letterSpacing: "0.06em", color: ink }}>{v.code}</strong></p>
            <p style={P}>Ausgestellt am {dateDe(v.issuedAt)} · <strong style={{ color: ink }}>gültig bis {dateDe(v.validUntil)}</strong></p>
          </div>
        </div>
      </Frame>
    );
  }

  if (motif === "weihnachten") {
    const goldW = "#e8cf8f";
    return (
      <Frame style={{ background: "#1f3d33", fontFamily: INTER, color: "#f5efe0" }}>
        <svg aria-hidden width="230" height="374" viewBox="0 0 230 374" style={{ position: "absolute", left: 0, top: 0, height: "100%" }}>
          <path d="M10 20 C 70 90, 110 180, 120 374" fill="none" stroke={goldW} strokeWidth="1.5" />
          <path
            d="M38 56 l-26 6 M38 56 l10 -24 M62 96 l-30 4 M62 96 l14 -26 M84 140 l-32 2 M84 140 l18 -26 M100 188 l-32 0 M100 188 l22 -24 M111 238 l-30 -2 M111 238 l24 -22 M117 290 l-28 -4 M117 290 l24 -18"
            fill="none"
            stroke={goldW}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="150" cy="70" r="5" fill="#c4473a" />
          <circle cx="162" cy="84" r="4" fill="#c4473a" />
          <g stroke="#f5efe0" strokeWidth="1.2" strokeLinecap="round" opacity="0.7">
            <path d="M180 200 l0 16 M172 208 l16 0 M174 202 l12 12 M186 202 l-12 12" />
            <path d="M40 330 l0 12 M34 336 l12 0" />
          </g>
        </svg>
        <div style={{ position: "relative", boxSizing: "border-box", height: "100%", marginLeft: 210, padding: "30px 40px 24px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
            <OrgLogo org={org} h={40} w={150} box={{ background: "#fbf8ef", borderRadius: 8, padding: 5 }} />
            <div style={{ textAlign: "right", fontSize: 12, lineHeight: 1.5, color: "#e6e0cf", marginLeft: "auto" }}>
              <p style={{ ...P, fontWeight: 600, color: "#ffffff" }}>{org?.name}</p>
              <p style={P}>{placeLine(org)}</p>
            </div>
          </div>
          <p style={{ ...P, marginTop: 6, fontFamily: CORMORANT, fontStyle: "italic", fontWeight: 500, fontSize: 50, lineHeight: 1 }}>Frohe Weihnachten</p>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
            <p style={caps(11, "0.26em", goldW)}>Gutschein über</p>
            <p style={{ ...P, fontFamily: CORMORANT, fontWeight: 600, fontSize: 48, lineHeight: 1, color: goldW }} className="tabular-nums">{amount}</p>
          </div>
          <div style={{ display: "flex", gap: 28, fontSize: 14, marginTop: 4 }}>
            <Line label="Für" color={goldW} style={{ flex: "1 1 0" }} />
            <Line label="Von" color={goldW} style={{ flex: "1 1 0" }} />
          </div>
          <div style={{ marginTop: "auto", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, fontSize: 12, lineHeight: 1.5, color: "#e6e0cf" }}>
            <p style={P}>Code <strong style={{ fontSize: 14, letterSpacing: "0.06em", color: "#ffffff" }}>{v.code}</strong></p>
            <p style={{ ...P, textAlign: "right" }}>
              Ausgestellt am {dateDe(v.issuedAt)}
              <br />
              <strong style={{ color: "#ffffff" }}>Gültig bis {dateDe(v.validUntil)}</strong>
            </p>
          </div>
        </div>
      </Frame>
    );
  }

  // Klassisch
  const accent = "#0f6b62";
  const ink = "#12322f";
  return (
    <Frame style={{ background: "#ffffff", fontFamily: INTER, color: ink, display: "flex", border: "1px solid #d5e4e2" }}>
      <div style={{ width: 248, flexShrink: 0, background: accent, color: "#ffffff", boxSizing: "border-box", padding: "36px 32px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <p style={{ ...caps(12, "0.22em"), fontWeight: 600 }}>Gutschein</p>
          <p style={{ ...P, fontFamily: GROTESK, fontSize: 52, lineHeight: 1, fontWeight: 700 }} className="tabular-nums">{amount}</p>
          <p style={{ ...P, marginTop: 6, fontSize: 13, lineHeight: 1.45 }}>einlösbar für alle Leistungen und Produkte{v.single ? " laut Vermerk" : ""}</p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <p style={caps(11, "0.14em")}>Gutscheincode</p>
          <p style={{ ...P, fontFamily: GROTESK, fontSize: 22, fontWeight: 700, letterSpacing: "0.06em" }}>{v.code}</p>
        </div>
      </div>
      <div style={{ flexGrow: 1, boxSizing: "border-box", padding: "32px 40px 28px 36px", display: "flex", flexDirection: "column", gap: 18, borderLeft: "2px dashed #b9d6d2" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 24 }}>
          <OrgLogo org={org} h={52} w={190} />
          <div style={{ textAlign: "right", fontSize: 13, lineHeight: 1.5, color: "#2c4a47", marginLeft: "auto" }}>
            <p style={{ ...P, fontWeight: 600, color: ink }}>{org?.name}</p>
            <p style={P}>{[org?.street, [org?.zip, org?.city].filter(Boolean).join(" ")].filter(Boolean).join(" · ")}</p>
            {org?.phone ? <p style={P}>{org.phone}</p> : null}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 8, fontSize: 15 }}>
          <Line label="Für" color={ink} style={{ gap: 12 }} />
          <Line label="Von" color={ink} style={{ gap: 12 }} />
        </div>
        <div style={{ marginTop: "auto", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, fontSize: 12, color: "#3f5f5b" }}>
          <p style={{ ...P, maxWidth: 260, lineHeight: 1.45 }}>Keine Barauszahlung. Restguthaben bleibt bis zum Ablauf erhalten.</p>
          <div style={{ textAlign: "right", lineHeight: 1.5 }}>
            <p style={P}>Ausgestellt am {dateDe(v.issuedAt)}</p>
            <p style={{ ...P, fontWeight: 600, color: ink }}>Gültig bis {dateDe(v.validUntil)}</p>
          </div>
        </div>
      </div>
    </Frame>
  );
}
