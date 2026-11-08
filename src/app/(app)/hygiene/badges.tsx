import { Badge } from "@/components/ui";
import { dateDe } from "@/lib/format";
import { BATCH_RESULT_LABELS, batchUsability, deadlineStatus, type BatchResult } from "@/lib/hygiene-rules";

/** Fristen-Ampel: rot = überfällig, gelb = ≤ 30 Tage, grün = ok. Text statt nur Farbe (Barrierefreiheit). */
export function DeadlineBadge({ date, today }: { date: string | null; today: string }) {
  const st = deadlineStatus(date, today);
  if (st.status === "none") return <Badge>keine Frist</Badge>;
  const d = st.daysLeft ?? 0;
  if (st.status === "overdue") return <Badge tone="accent">überfällig seit {dateDe(date)} ({-d} T.)</Badge>;
  if (st.status === "soon") return <Badge tone="warn">{d === 0 ? "heute" : `in ${d} T.`} · {dateDe(date)}</Badge>;
  return <Badge tone="primary">{dateDe(date)}</Badge>;
}

export function BatchBadge({ result, expiresAt, today }: { result: string; expiresAt: string | null; today: string }) {
  const check = batchUsability({ result, expiresAt }, today);
  if (check.reason === "expired") return <Badge tone="accent">abgelaufen</Badge>;
  const label = BATCH_RESULT_LABELS[result as BatchResult] ?? result;
  return <Badge tone={result === "released" ? "primary" : result === "rejected" ? "accent" : "warn"}>{label}</Badge>;
}

