/**
 * Vertriebs-Pipeline (rein, testbar): Stufe eines Leads aus Status, Versandschritt, Antwort und – falls sich die Praxis
 * registriert hat – deren Abo-Stand. Registrierte Praxen werden Leads zugeordnet über
 *   1. einen persönlichen Aktionscode des Leads (promo_codes.lead_id), der von der Praxis eingelöst wurde,
 *   2. gleiche E-Mail-Adresse von Lead und Inhaber:in,
 *   3. gleiche Domain (E-Mail oder Website des Leads ↔ E-Mail der Inhaber:in), außer Freemail-Domains (gmx.de, web.de …).
 * Nur eindeutige Domain-Treffer zählen. Interne Praxen werden nie zugeordnet.
 */
import { isLeadStatus, STATUS_LABEL, type LeadStatus } from "./constants";

export const STAGES = ["neu", "angeschrieben", "geantwortet", "test", "kunde", "aus"] as const;
export type Stage = (typeof STAGES)[number];
export const isStage = (v: unknown): v is Stage => typeof v === "string" && (STAGES as readonly string[]).includes(v);

export const STAGE_LABEL: Record<Stage, string> = {
  neu: "Neu",
  angeschrieben: "Angeschrieben",
  geantwortet: "Geantwortet",
  test: "Test gestartet",
  kunde: "Kunde",
  aus: "Kein Interesse / abgemeldet",
};

export const STAGE_HINT: Record<Stage, string> = {
  neu: "noch keine Mail",
  angeschrieben: "Mail 1–3 versendet, keine Antwort",
  geantwortet: "Antwort erhalten bzw. interessiert",
  test: "Praxis registriert (Code eingelöst oder Adresse passt), noch kein Abo",
  kunde: "bezahltes Abo bzw. Status „Kunde“",
  aus: "kein Interesse, abgemeldet oder gesperrt",
};

/** Status, die man für mehrere Leads auf einmal setzen kann („Stufe setzen“) */
export const BULK_STATUSES: readonly LeadStatus[] = ["neu", "geantwortet", "interessiert", "kein_interesse", "kunde"];

export type PipelineLead = { id: string; status: string; step: number; repliedAt: Date | null; email: string | null; website: string | null; suppressed?: boolean };
export type PipelineOrg = { id: string; name: string; plan: string; subscriptionStatus: string; trialEndsAt: Date | null; createdAt: Date; ownerEmails: string[] };
export type MatchedOrg = PipelineOrg & { via: "code" | "email" | "domain"; converted: boolean };

/** Häufige Freemail-/Provider-Domains: gleiche Domain sagt hier nichts über dieselbe Praxis aus */
export const FREEMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "gmx.de", "gmx.net", "gmx.at", "gmx.ch", "web.de", "t-online.de", "freenet.de", "outlook.com", "outlook.de",
  "hotmail.com", "hotmail.de", "live.de", "live.com", "yahoo.com", "yahoo.de", "icloud.com", "me.com", "mac.com", "aol.com", "aol.de",
  "posteo.de", "mailbox.org", "mail.de", "arcor.de", "online.de", "email.de", "vodafone.de", "kabelmail.de", "magenta.de", "ionos.de", "proton.me", "protonmail.com",
]);

export function emailDomain(email: string | null | undefined): string | null {
  const m = /@([^@\s]+)$/.exec((email ?? "").trim().toLowerCase());
  return m ? m[1].replace(/\.$/, "") : null;
}

export function websiteDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const h = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
    return h.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

const isConverted = (o: { plan: string; subscriptionStatus: string }) => o.subscriptionStatus === "active" && ["starter", "praxis", "plus"].includes(o.plan);

/**
 * Ordnet registrierte Praxen Leads zu. `codeRedemptions`: lead_id des eingelösten Codes → organization_id.
 * Rückgabe: leadId → Praxis (mit Art der Zuordnung).
 */
export function matchLeadsToOrgs(leads: PipelineLead[], orgs: PipelineOrg[], codeRedemptions: { leadId: string; organizationId: string }[] = []): Map<string, MatchedOrg> {
  const candidates = orgs.filter((o) => o.plan !== "internal");
  const byId = new Map(candidates.map((o) => [o.id, o]));
  const byEmail = new Map<string, PipelineOrg>();
  const byDomain = new Map<string, PipelineOrg[]>();
  for (const o of candidates) {
    for (const e of o.ownerEmails) {
      const email = e.trim().toLowerCase();
      if (!byEmail.has(email)) byEmail.set(email, o);
      const d = emailDomain(email);
      if (d && !FREEMAIL_DOMAINS.has(d)) {
        const list = byDomain.get(d) ?? [];
        if (!list.includes(o)) list.push(o);
        byDomain.set(d, list);
      }
    }
  }
  const out = new Map<string, MatchedOrg>();
  const put = (leadId: string, o: PipelineOrg, via: MatchedOrg["via"]) => out.set(leadId, { ...o, via, converted: isConverted(o) });
  for (const r of codeRedemptions) {
    const o = byId.get(r.organizationId);
    if (o && !out.has(r.leadId)) put(r.leadId, o, "code");
  }
  for (const l of leads) {
    if (out.has(l.id)) continue;
    const email = l.email?.trim().toLowerCase();
    const exact = email ? byEmail.get(email) : undefined;
    if (exact) {
      put(l.id, exact, "email");
      continue;
    }
    for (const d of [emailDomain(l.email), websiteDomain(l.website)]) {
      if (!d || FREEMAIL_DOMAINS.has(d)) continue;
      const list = byDomain.get(d);
      if (list?.length === 1) {
        put(l.id, list[0], "domain");
        break;
      }
    }
  }
  return out;
}

const REPLIED: readonly LeadStatus[] = ["geantwortet", "interessiert"];

/** Stufe eines Leads. Reihenfolge: Kunde > Test > aus > geantwortet > angeschrieben > neu. */
export function deriveStage(lead: PipelineLead, org: { converted: boolean } | null | undefined): Stage {
  const status = isLeadStatus(lead.status) ? lead.status : "neu";
  if (status === "kunde" || org?.converted) return "kunde";
  if (org) return "test";
  if (status === "kein_interesse" || status === "abgemeldet" || lead.suppressed) return "aus";
  if (REPLIED.includes(status) || lead.repliedAt) return "geantwortet";
  if (lead.step > 0 || status === "in_sequenz") return "angeschrieben";
  return "neu";
}

/** Kurzlabel für Tabellen, z. B. „Angeschrieben (Mail 2)“ */
export function stageLabel(stage: Stage, step: number): string {
  return stage === "angeschrieben" && step > 0 ? `${STAGE_LABEL.angeschrieben} (Mail ${step})` : STAGE_LABEL[stage];
}

export const statusLabel = (s: string) => (isLeadStatus(s) ? STATUS_LABEL[s] : s);

/** Antwortquote in Prozent (gerundet) – Antworten je angeschriebenem Lead; null ohne angeschriebene Leads */
export function replyRate(contacted: number, replied: number): number | null {
  return contacted > 0 ? Math.round((replied / contacted) * 100) : null;
}
