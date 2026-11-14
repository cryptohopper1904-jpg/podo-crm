import Link from "next/link";
import type { RiskFlags } from "@/db/schema";
import { StatusButtons } from "@/app/(app)/kalender/status-buttons";
import { appointmentEditLock } from "@/lib/appointment-edit";
import { timeDe } from "@/lib/format";
import { dotStyle, type TherapistColor } from "@/lib/therapist-colors";
import { RiskBadges } from "./risk-badges";
import { Badge } from "./ui";
import { withReturn } from "@/lib/back-link";

export const SOURCE: Record<string, string> = { manual: "Praxis", doctolib: "Doctolib", online: "Online", phone: "Telefon", whatsapp: "WhatsApp", email: "E-Mail", voice_agent: "KI-Telefon", portal: "Patientenportal", extern: "Extern" };
export const STATUS: Record<string, { label: string; tone: "primary" | "info" | "warn" | "neutral" | "accent" }> = {
  planned: { label: "geplant", tone: "neutral" },
  confirmed: { label: "bestätigt", tone: "info" },
  done: { label: "erledigt", tone: "primary" },
  cancelled: { label: "abgesagt", tone: "neutral" },
  no_show: { label: "nicht erschienen", tone: "accent" },
};

export type ApptRow = {
  a: { id: string; startsAt: Date; endsAt: Date; status: string; source: string; title: string | null; homeVisit: boolean; notes: string | null; therapistId?: string | null };
  patient: { id: string; firstName: string | null; lastName: string; riskFlags: RiskFlags; homeVisit: boolean; city: string | null } | null;
  therapist: string | null;
  /** Termin aus einem Kalender-Abo (nur lesend; Änderungen in der Quelle, z. B. Doctolib) */
  feed?: { label: string; conflict: string | null } | null;
};

/** Feste Breite je Aktions-Slot – gleiche Buttons stehen so in allen Zeilen exakt untereinander. */
const SLOT = "w-[5.5rem]";
const btnBase = "inline-flex h-10 shrink-0 items-center justify-center whitespace-nowrap rounded-xl px-2 text-sm font-semibold";
const outline = "border border-border hover:bg-surface-2";
const slotBtn = `${SLOT} ${btnBase}`;
const slotSecondary = `${slotBtn} ${outline}`;
/**
 * Leerer Slot: hält den Platz frei, ist unsichtbar und nicht im Tab-Fokus. Nur in breiten Listen (@xl), wo die Knöpfe
 * spaltenbündig untereinander stehen – schmal brechen die Knöpfe um, Lücken wären dort nur leere Flächen.
 */
const Gap = ({ wide = false }: { wide?: boolean }) => <span aria-hidden className={`${wide ? "w-[11.375rem]" : SLOT} hidden h-10 shrink-0 @xl:inline-block`} />;

/**
 * Terminzeile (Kalender-Liste, Heute, Behandlung): ruhiges, spaltenbündiges Raster.
 * Spalten: Zeit · Farbstreifen · Patient/Infos · Badges (Quelle + Status, feste Breite) · Aktionen.
 * Aktionen stehen in festen Slots gleicher Breite und fester Reihenfolge
 * (Doku · Anamnese bzw. Quittung · Ändern/Details · Losfahren · Nicht da · Absagen); fehlende lassen ihren Slot leer.
 * „Nicht da“/„Absagen“ zeigen danach eine Meldung mit „Rückgängig“ (status-buttons.tsx).
 * Die Umbrüche hängen an der Breite der Liste (Container-Query), nicht des Fensters – so brechen alle Zeilen
 * einer Liste gleich um: schmal Aktionen in eigener Zeile (weiterhin bündig), breit alles in einer Zeile.
 */
export function AppointmentRow({ row, canDoc, canEdit, overlap = false, from, color, billable = false }: {
  row: ApptRow;
  canDoc: boolean;
  canEdit: boolean;
  overlap?: boolean;
  /**
   * Seite, auf die „Zurück“ im Termin führt (src/lib/back-link.ts): Kalender-Ansicht mit Query, oder „/heute“ bzw.
   * „/doku“ – dort wird `von` immer angehängt, da der Standard im Termin der Kalender ist.
   */
  from?: string;
  /** Kalenderfarbe der Behandler:in – als Farbpunkt vor dem Namen (der Statusstreifen bleibt) */
  color?: TherapistColor;
  /**
   * Erledigter Termin ist noch nicht abgerechnet und die Person darf Belege ausstellen → „Quittung“ direkt in der Zeile
   * (die aufrufende Seite prüft Recht und Abrechnungsstand, z. B. billedAppointmentIds).
   */
  billable?: boolean;
}) {
  const { a, patient, feed } = row;
  const apptHref = from ? withReturn(`/kalender/termin/${a.id}`, from, !from.startsWith("/kalender")) : `/kalender/termin/${a.id}`;
  const st = STATUS[a.status];
  const cancelled = a.status === "cancelled";
  const open = !cancelled && a.status !== "done";
  const showDoc = canDoc && !!patient && open;
  const assign = canEdit && !!feed && !patient && !cancelled;
  const showDrive = canEdit && !!patient && (a.homeVisit || patient.homeVisit) && open;
  const showStatus = canEdit && open;
  // Doctolib/Kalender-Abo/extern: Absage in der Quelle (Server lehnt sie hier ab)
  const showCancel = showStatus && !feed && a.source !== "doctolib" && a.source !== "extern";
  const showReceipt = billable && !!patient && a.status === "done";
  const who = patient ? [patient.firstName, patient.lastName].filter(Boolean).join(" ") : (a.title ?? "");
  return (
    <div data-appt-row className={`@container border-t border-border py-3 first:border-t-0 ${cancelled ? "opacity-50" : ""}`}>
      <div className="grid grid-cols-[5.75rem_4px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 @xl:grid-cols-[6.75rem_4px_minmax(0,1fr)_7.5rem] @min-[62.5rem]:grid-cols-[6.75rem_4px_minmax(10rem,1fr)_7.5rem_auto]">
        <Link href={apptHref} className="col-start-1 row-start-1 whitespace-nowrap font-semibold tabular-nums hover:text-primary" title="Termin öffnen (verschieben, abrechnen)">
          {timeDe(a.startsAt)}–{timeDe(a.endsAt)}
        </Link>
        <span
          className={`col-start-2 row-span-2 row-start-1 w-1 self-stretch rounded @xl:row-span-2 @min-[62.5rem]:row-span-1 ${a.homeVisit ? "bg-[#e9b931]" : a.status === "done" ? "bg-primary" : "bg-accent"}`}
          aria-hidden
        />
        <div className="col-start-3 row-start-1 min-w-0">
          <p className="font-semibold">
            {patient ? <Link href={`/kunden/${patient.id}`} className="hover:text-primary">{[patient.firstName, patient.lastName].filter(Boolean).join(" ")}</Link> : a.title}
          </p>
          <p className="text-sm text-muted">{patient ? a.title : a.notes}{a.homeVisit ? ` · Hausbesuch${patient?.city ? ` ${patient.city}` : ""}` : ""}{row.therapist ? (
              <>
                {" · "}
                <span className="wrap-break-word @xl:whitespace-nowrap">
                  {color ? <span className="mr-1 inline-block size-2.5 rounded-full align-[-1px]" style={dotStyle(color)} aria-hidden /> : null}
                  {row.therapist}
                </span>
              </>
            ) : null}
          </p>
          {patient ? <div className="mt-1"><RiskBadges flags={patient.riskFlags} compact /></div> : null}
          {feed || (overlap && !cancelled) ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {feed ? (
                <Badge tone="info" className="max-w-56 truncate">
                  <span title={`Importiert aus dem Kalender-Abo „${feed.label}“ – Änderungen bitte in der Quelle (z. B. Doctolib) vornehmen`}>aus Kalender-Abo · {feed.label}</span>
                </Badge>
              ) : null}
              {overlap && !cancelled ? <Badge tone="accent">Überschneidung</Badge> : null}
              {feed?.conflict === "local_change" ? <Badge tone="warn">in PodoHero geändert – Kalender-Änderung nicht übernommen</Badge> : null}
            </div>
          ) : null}
        </div>
        <div className="col-start-3 row-start-2 flex flex-wrap items-start gap-1.5 @xl:col-start-4 @xl:row-start-1 @xl:flex-col">
          <Badge tone="neutral">{SOURCE[a.source] ?? a.source}</Badge>
          <Badge tone={st.tone}>{st.label}</Badge>
        </div>
        <div className="col-span-full row-start-3 flex flex-wrap gap-1.5 @xl:col-start-3 @xl:col-end-[-1] @xl:row-start-2 @min-[62.5rem]:col-start-5 @min-[62.5rem]:col-end-6 @min-[62.5rem]:row-start-1">
          {assign ? (
            <Link href={`/kalender/zuordnen/${a.id}`} className={`w-[11.375rem] ${btnBase} ${outline}`}>Patient:in zuordnen</Link>
          ) : showDoc && patient ? (
            <>
              <Link href={`/kunden/${patient.id}/doku/neu?termin=${a.id}`} className={`${slotBtn} bg-primary text-on-primary hover:bg-primary-hover`}>Doku</Link>
              <Link href={`/kunden/${patient.id}/anamnese/bogen?termin=${a.id}`} className={slotSecondary} title="Anamnesebogen am iPad – Datum und Name sind vorausgefüllt">Anamnese</Link>
            </>
          ) : showReceipt ? (
            <Link href={`/rechnungen/neu?termin=${a.id}&art=quittung`} className={`w-[11.375rem] ${btnBase} bg-primary text-on-primary hover:bg-primary-hover`} title="Quittung für diese Behandlung ausstellen (Zahlung jetzt annehmen)">
              Quittung
            </Link>
          ) : (
            <Gap wide />
          )}
          <Link href={apptHref} className={slotSecondary}>
            {canEdit && !appointmentEditLock(a, !!feed) ? "Ändern" : "Details"}
          </Link>
          {/* Ohne Bearbeitungsrecht hat keine Zeile Losfahren/Nicht da/Absagen – dann entfallen die drei Slots ganz */}
          {showDrive ? <Link href={`/touren/losfahren?termin=${a.id}`} className={slotSecondary}>Losfahren</Link> : canEdit ? <Gap /> : null}
          {showStatus ? (
            <StatusButtons id={a.id} label={`${timeDe(a.startsAt)} ${who}`.trim()} noShow cancel={showCancel} className={`${slotSecondary} cursor-pointer disabled:opacity-50`} />
          ) : null}
          {showStatus && !showCancel ? <Gap /> : null}
          {!showStatus && canEdit ? (
            <>
              <Gap />
              <Gap />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
