import clsx from "clsx";
import { logoInfo, type LogoKind } from "@/server/practice-logos";

/**
 * Praxis-Logo für Bögen und Druckansichten (Server-Komponente). Ohne hochgeladenes Logo wird nichts angezeigt.
 * `kind="compact"` nimmt ersatzweise das vollständige Logo (und umgekehrt).
 */
export async function PracticeLogo({ organizationId, kind = "compact", className, alt }: { organizationId: string; kind?: LogoKind; className?: string; alt: string }) {
  const info = await logoInfo(organizationId);
  const row = info[kind] ?? info[kind === "compact" ? "full" : "compact"];
  if (!row) return null;
  // eslint-disable-next-line @next/next/no-img-element -- geschützte API-Route, keine Bildoptimierung nötig
  return <img src={`/api/praxis/logo/${kind}?ersatz=1&v=${row.sha256.slice(0, 12)}`} alt={alt} className={clsx("object-contain", className)} />;
}
