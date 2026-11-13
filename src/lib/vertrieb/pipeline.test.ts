import { describe, expect, it } from "vitest";
import { deriveStage, emailDomain, isFreemail, matchLeadsToOrgs, replyRate, stageLabel, websiteDomain, type PipelineLead, type PipelineOrg } from "./pipeline";

const lead = (x: Partial<PipelineLead> = {}): PipelineLead => ({ id: "l1", status: "neu", step: 0, repliedAt: null, email: null, website: null, ...x });
const org = (x: Partial<PipelineOrg> = {}): PipelineOrg => ({ id: "o1", name: "Praxis", plan: "trial", subscriptionStatus: "trialing", trialEndsAt: null, createdAt: new Date(), ownerEmails: [], ...x });

describe("Pipeline: Stufe", () => {
  it("neu → angeschrieben → geantwortet", () => {
    expect(deriveStage(lead(), null)).toBe("neu");
    expect(deriveStage(lead({ status: "in_sequenz", step: 2 }), null)).toBe("angeschrieben");
    expect(stageLabel("angeschrieben", 2)).toBe("Angeschrieben (Mail 2)");
    expect(deriveStage(lead({ status: "geantwortet", step: 1 }), null)).toBe("geantwortet");
    expect(deriveStage(lead({ status: "interessiert", step: 1 }), null)).toBe("geantwortet");
    expect(deriveStage(lead({ status: "in_sequenz", step: 1, repliedAt: new Date() }), null)).toBe("geantwortet");
  });
  it("aus: kein Interesse, abgemeldet, gesperrt", () => {
    expect(deriveStage(lead({ status: "kein_interesse", step: 1 }), null)).toBe("aus");
    expect(deriveStage(lead({ status: "abgemeldet" }), null)).toBe("aus");
    expect(deriveStage(lead({ status: "in_sequenz", step: 1, suppressed: true }), null)).toBe("aus");
  });
  it("Registrierung schlägt Antwort/Abmeldung, bezahltes Abo bzw. Status Kunde ist Kunde", () => {
    expect(deriveStage(lead({ status: "abgemeldet" }), { converted: false })).toBe("test");
    expect(deriveStage(lead({ status: "geantwortet" }), { converted: false })).toBe("test");
    expect(deriveStage(lead({ status: "in_sequenz" }), { converted: true })).toBe("kunde");
    expect(deriveStage(lead({ status: "kunde" }), null)).toBe("kunde");
    expect(deriveStage(lead({ status: "unbekannt" }), null)).toBe("neu");
  });
  it("Antwortquote", () => {
    expect(replyRate(0, 0)).toBeNull();
    expect(replyRate(8, 1)).toBe(13);
  });
});

describe("Pipeline: Zuordnung registrierter Praxen", () => {
  it("Freemail-Domains (auch Länder-Varianten)", () => {
    for (const d of ["gmx.com", "gmx.net", "yahoo.de", "yahoo.co.uk", "outlook.de", "hotmail.fr", "icloud.com", "me.com", "aol.de", "proton.me", "protonmail.com", "t-online.de", "web.de", "freenet.de", "posteo.de", "mailbox.org"]) {
      expect(isFreemail(d), d).toBe(true);
    }
    expect(isFreemail("praxis-muster.de")).toBe(false);
    expect(isFreemail("outlook-praxis.de")).toBe(false);
  });
  it("Domains", () => {
    expect(emailDomain("Info@Praxis-Muster.DE")).toBe("praxis-muster.de");
    expect(emailDomain("kaputt")).toBeNull();
    expect(websiteDomain("https://www.praxis-muster.de/kontakt")).toBe("praxis-muster.de");
    expect(websiteDomain("praxis-muster.de")).toBe("praxis-muster.de");
    expect(websiteDomain("http://[")).toBeNull();
  });
  it("persönlicher Code > gleiche E-Mail > eindeutige Domain; Freemail und interne Praxen nie", () => {
    const leads = [
      lead({ id: "code", email: "x@a.example" }),
      lead({ id: "mail", email: "anna@gmx.de" }),
      lead({ id: "domain", email: "info@praxis-b.example" }),
      lead({ id: "web", email: null, website: "https://www.praxis-c.example" }),
      lead({ id: "freemail", email: "info@gmx.de" }),
      lead({ id: "doppelt", email: "info@geteilt.example" }),
      lead({ id: "intern", email: "chef@betreiber.example" }),
    ];
    const orgs = [
      org({ id: "oA", ownerEmails: ["owner@other.example"] }),
      org({ id: "oMail", ownerEmails: ["Anna@gmx.de"] }),
      org({ id: "oB", ownerEmails: ["petra@praxis-b.example"], plan: "praxis", subscriptionStatus: "active" }),
      org({ id: "oC", ownerEmails: ["c@praxis-c.example"] }),
      org({ id: "oG1", ownerEmails: ["a@geteilt.example"] }),
      org({ id: "oG2", ownerEmails: ["b@geteilt.example"] }),
      org({ id: "oInt", plan: "internal", subscriptionStatus: "active", ownerEmails: ["chef@betreiber.example"] }),
    ];
    const m = matchLeadsToOrgs(leads, orgs, [{ leadId: "code", organizationId: "oA" }]);
    expect(m.get("code")).toMatchObject({ id: "oA", via: "code", converted: false });
    expect(m.get("mail")).toMatchObject({ id: "oMail", via: "email" });
    expect(m.get("domain")).toMatchObject({ id: "oB", via: "domain", converted: true });
    expect(m.get("web")).toMatchObject({ id: "oC", via: "domain" });
    expect(m.has("freemail")).toBe(false);
    expect(m.has("doppelt")).toBe(false);
    expect(m.has("intern")).toBe(false);
  });
});
