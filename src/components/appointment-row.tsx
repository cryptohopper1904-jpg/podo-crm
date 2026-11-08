import Link from "next/link";
import type { RiskFlags } from "@/db/schema";
import { setAppointmentStatusAction } from "@/app/(app)/kalender/actions";
import { timeDe } from "@/lib/format";
import { RiskBadges } from "./risk-badges";
import { Badge } from "./ui";

const SOURCE: Record<string, string> = { manual: "Praxis", doctolib: "Doctolib", online: "Online", phone: "Telefon", whatsapp: "WhatsApp", email: "E-Mail", voice_agent: "KI-Telefon", portal: "Kundenportal" };
const STATUS: Record<string, { label: string; tone: "primary" | "info" | "warn" | "neutral" | "accent" }> = {
  planned: { label: "geplant", tone: "neutral" },
  confirmed: { label: "bestätigt", tone: "info" },
  done: { label: "erledigt", tone: "primary" },
  cancelled: { label: "abgesagt", tone: "neutral" },
  no_show: { label: "nicht erschienen", tone: "accent" },
};

export type ApptRow = {
  a: { id: string; startsAt: Date; endsAt: Date; status: string; source: string; title: string | null; homeVisit: boolean; notes: string | null };
  patient: { id: string; firstName: string | null; lastName: string; riskFlags: RiskFlags; homeVisit: boolean; city: string | null } | null;
  therapist: string | null;
};

export function AppointmentRow({ row, canDoc, canEdit }: { row: ApptRow; canDoc: boolean; canEdit: boolean }) {
  const { a, patient } = row;
  const st = STATUS[a.status];
  const cancelled = a.status === "cancelled";
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border py-3 first:border-t-0 ${cancelled ? "opacity-50" : ""}`}>
      <span className="w-28 shrink-0 whitespace-nowrap font-semibold tabular-nums">{timeDe(a.startsAt)}–{timeDe(a.endsAt)}</span>
      <span className={`w-1 self-stretch rounded ${a.homeVisit ? "bg-[#e9b931]" : a.status === "done" ? "bg-primary" : "bg-accent"}`} aria-hidden />
      <div className="min-w-0 flex-[1_1_14rem]">
        <p className="font-semibold">
          {patient ? <Link href={`/kunden/${patient.id}`} className="hover:text-primary">{[patient.firstName, patient.lastName].filter(Boolean).join(" ")}</Link> : a.title}
        </p>
        <p className="text-sm text-muted">{patient ? a.title : a.notes}{a.homeVisit ? ` · Hausbesuch${patient?.city ? ` ${patient.city}` : ""}` : ""}{row.therapist ? ` · ${row.therapist}` : ""}</p>
        {patient ? <div className="mt-1"><RiskBadges flags={patient.riskFlags} compact /></div> : null}
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
      <Badge tone="neutral">{SOURCE[a.source] ?? a.source}</Badge>
      <Badge tone={st.tone}>{st.label}</Badge>
        {canDoc && patient && a.status !== "done" && !cancelled ? (
          <Link href={`/kunden/${patient.id}/doku/neu?termin=${a.id}`} className="inline-flex h-10 items-center rounded-xl bg-primary px-3 text-sm font-semibold text-on-primary hover:bg-primary-hover">Doku</Link>
        ) : null}
        {canEdit && !cancelled && a.status !== "done" ? (
          <>
            <form action={setAppointmentStatusAction}>
              <input type="hidden" name="id" value={a.id} />
              <input type="hidden" name="status" value="no_show" />
              <button className="h-10 rounded-xl border border-border px-3 text-sm font-semibold hover:bg-surface-2" title="Nicht erschienen (Ausfallhonorar möglich)">Nicht da</button>
            </form>
            <form action={setAppointmentStatusAction}>
              <input type="hidden" name="id" value={a.id} />
              <input type="hidden" name="status" value="cancelled" />
              <button className="h-10 rounded-xl border border-border px-3 text-sm font-semibold hover:bg-surface-2">Absagen</button>
            </form>
          </>
        ) : null}
      </div>
    </div>
  );
}
