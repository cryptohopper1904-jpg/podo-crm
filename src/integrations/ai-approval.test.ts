import { describe, expect, it } from "vitest";
import { AI_APPROVAL_MISSING, AI_APPROVAL_TEXT, AI_APPROVAL_VERSION, aiApprovalInfo, aiApprovalProblem, aiApprovalValid, aiProcessingApproved, nextAiApproval } from "./ai-approval";
import { OpenAiCompatibleLlm } from "./llm/openai-compatible";
import { getAdapter } from "./registry";

const now = new Date("2026-11-19T10:00:00Z");
const target = { baseUrl: "https://llm.example/v1", model: "m" };
const approval = { at: "2026-11-01T08:00:00.000Z", by: "user-1", version: AI_APPROVAL_VERSION, ...target, ownKey: false };
const valid = { ...target, dataProcessingApproved: true, dataProcessingApproval: approval };
const owner = { userId: "u-2", role: "owner", support: false, targetChanged: false, oldOwnKey: false, ownKey: false, now };

describe("KI-Anbieter: Pflicht-Bestätigung", () => {
  it("Wortlaut (Version v2, alte Bestätigungen verfallen)", () => {
    expect(AI_APPROVAL_TEXT).toBe(
      "Ich bestätige als Verantwortliche/r für unsere Praxis: (1) Mit dem Anbieter besteht ein Auftragsverarbeitungsvertrag nach Art. 28 DSGVO, der ihn und seine Unterauftragsverarbeiter zur Verschwiegenheit nach § 203 Abs. 4 StGB verpflichtet. (2) Die Daten werden in der EU bzw. im EWR verarbeitet; eine Übermittlung in Drittländer oder ein Zugriff von dort (auch durch Unterauftragsverarbeiter oder Support) findet nicht statt oder ist durch Garantien nach Art. 44 ff. DSGVO abgesichert. (3) Der Anbieter speichert Eingaben und Ergebnisse nicht über die Verarbeitung hinaus (Zero Data Retention) und nutzt sie nicht zum Training. (4) Unsere Datenschutzhinweise für Patientinnen und Patienten informieren über diesen Einsatz.",
    );
    expect(AI_APPROVAL_VERSION).not.toBe("ki-avv-eu-kein-training-v1");
    expect(aiApprovalValid({ ...valid, dataProcessingApproval: { ...approval, version: "ki-avv-eu-kein-training-v1" } }, false)).toBe(false);
    expect(aiApprovalProblem({ ...valid, dataProcessingApproval: { ...approval, version: "ki-avv-eu-kein-training-v1" } }, false)).toBe("version");
  });

  it("„verbunden (echt)“ ohne gültige Bestätigung wird abgelehnt", () => {
    expect(nextAiApproval({}, target, { ...owner, status: "connected", checked: false })).toMatchObject({ error: expect.stringMatching(/Datenschutz-Bestätigung/) });
  });

  it("mit Häkchen: Zeitpunkt, Benutzer, Version und Ziel gespeichert", () => {
    expect(nextAiApproval({}, target, { ...owner, status: "connected", checked: true })).toEqual({
      dataProcessingApproved: true,
      dataProcessingApproval: { at: "2026-11-19T10:00:00.000Z", by: "u-2", version: AI_APPROVAL_VERSION, ...target, ownKey: false },
      changed: true,
    });
  });

  it("ohne Häkchen bleibt eine gültige Bestätigung beim selben Ziel erhalten", () => {
    expect(nextAiApproval(valid, { ...valid }, { ...owner, status: "connected", checked: false })).toEqual({ dataProcessingApproved: true, dataProcessingApproval: approval, changed: false });
  });

  it("Zielwechsel verwirft die Bestätigung (Basis-URL oder Modell)", () => {
    expect(nextAiApproval(valid, { ...valid, baseUrl: "https://andere.example/v1" }, { ...owner, status: "connected", checked: false, targetChanged: true })).toMatchObject({ error: expect.any(String) });
    expect(nextAiApproval(valid, { ...valid, model: "anderes" }, { ...owner, status: "connected", checked: false })).toMatchObject({ error: expect.any(String) });
    // auch eine gespeicherte Bestätigung gilt nicht mehr, sobald das Ziel in der Config ein anderes ist
    expect(aiApprovalValid({ ...valid, baseUrl: "https://andere.example/v1" }, false)).toBe(false);
    expect(aiApprovalProblem({ ...valid, model: "anderes" }, false)).toBe("target");
    // neue Bestätigung für das neue Ziel
    expect(nextAiApproval(valid, { ...valid, baseUrl: "https://andere.example/v1" }, { ...owner, status: "connected", checked: true, targetChanged: true })).toMatchObject({
      dataProcessingApproval: { baseUrl: "https://andere.example/v1", by: "u-2" },
    });
  });

  it("API-Schlüssel nachgetragen oder gelöscht = anderes Ziel: Bestätigung verworfen, neue nur durch Inhaber:in", () => {
    // Schlüssel nachtragen ohne Häkchen → abgelehnt
    expect(nextAiApproval(valid, { ...valid }, { ...owner, status: "connected", checked: false, targetChanged: true, oldOwnKey: false, ownKey: true })).toEqual({ error: AI_APPROVAL_MISSING });
    // auch ohne targetChanged-Flag fällt der Wechsel über ownKey auf
    expect(nextAiApproval(valid, { ...valid }, { ...owner, status: "connected", checked: false, oldOwnKey: false, ownKey: true })).toEqual({ error: AI_APPROVAL_MISSING });
    // mit Häkchen: neue Bestätigung mit ownKey
    expect(nextAiApproval(valid, { ...valid }, { ...owner, status: "connected", checked: true, targetChanged: true, oldOwnKey: false, ownKey: true })).toMatchObject({ dataProcessingApproval: { ownKey: true, by: "u-2" } });
    // … aber nicht im Support-Modus
    expect(nextAiApproval(valid, { ...valid }, { ...owner, status: "connected", checked: true, targetChanged: true, oldOwnKey: false, ownKey: true, support: true })).toMatchObject({ error: expect.stringMatching(/Support/) });
    // Schlüssel gelöscht: Bestätigung mit eigenem Schlüssel gilt nicht mehr
    const withKey = { ...valid, dataProcessingApproval: { ...approval, ownKey: true } };
    expect(aiApprovalValid(withKey, true)).toBe(true);
    expect(aiApprovalValid(withKey, false)).toBe(false);
    expect(aiApprovalProblem(withKey, false)).toBe("target");
    expect(nextAiApproval(withKey, { ...withKey }, { ...owner, status: "connected", checked: false, targetChanged: true, oldOwnKey: true, ownKey: false })).toEqual({ error: AI_APPROVAL_MISSING });
    // Bestätigung aus einer Vorversion ohne ownKey-Angabe gilt nicht
    const { ownKey: _drop, ...noOwnKey } = approval;
    void _drop;
    expect(aiApprovalValid({ ...valid, dataProcessingApproval: noOwnKey }, false)).toBe(false);
  });

  it("neue Bestätigung im Support-Modus und durch Nicht-Inhaber:innen abgelehnt", () => {
    expect(nextAiApproval({}, target, { ...owner, status: "connected", checked: true, support: true })).toMatchObject({ error: expect.stringMatching(/Support/) });
    expect(nextAiApproval({}, target, { ...owner, status: "connected", checked: true, role: "admin" })).toMatchObject({ error: expect.stringMatching(/Inhaberin/) });
  });

  it("aus/Testmodus ohne Häkchen erlaubt – Bestätigung wird entfernt", () => {
    expect(nextAiApproval(valid, valid, { ...owner, status: "disconnected", checked: false })).toEqual({ dataProcessingApproved: false, dataProcessingApproval: null, changed: true });
    expect(nextAiApproval({}, {}, { ...owner, status: "mock", checked: false })).toEqual({ dataProcessingApproved: false, dataProcessingApproval: null, changed: false });
  });

  it("altes Häkchen ohne Zeitpunkt/Benutzer gilt nicht", () => {
    expect(aiApprovalValid({ ...target, dataProcessingApproved: true }, false)).toBe(false);
    expect(aiApprovalValid({ ...valid, dataProcessingApproved: false }, false)).toBe(false);
    expect(aiApprovalValid(valid, false)).toBe(true);
    expect(aiApprovalInfo(valid, false)).toEqual(approval);
    expect(aiApprovalInfo({ ...target, dataProcessingApproved: true }, false)).toBeNull();
  });

  it("Freigabe zur Verarbeitung (processingApproved und Hinweis auf „Heute“): env-Freigabe nur ohne Praxisziel (Basis-URL oder eigener Schlüssel)", () => {
    expect(aiProcessingApproved({ status: "connected", config: valid }, false, false)).toBe(true);
    expect(aiProcessingApproved({ status: "connected", config: {} }, true, false)).toBe(true); // Plattform-Anbieter mit Betreiber-Freigabe
    expect(aiProcessingApproved({ status: "connected", config: {} }, false, false)).toBe(false);
    expect(aiProcessingApproved({ status: "connected", config: { ...target } }, true, false)).toBe(false); // eigene Basis-URL
    expect(aiProcessingApproved({ status: "connected", config: {} }, true, true)).toBe(false); // eigener API-Schlüssel
    expect(aiProcessingApproved({ status: "disconnected", config: { ...target } }, true, true)).toBe(true); // „aus“: nur env-Anbieter
    expect(aiProcessingApproved(null, true, false)).toBe(true);
    expect(aiProcessingApproved({ status: "mock", config: valid }, false, false)).toBe(false);
    // Bestätigung ohne eigenen Schlüssel gilt nicht mehr, sobald einer hinterlegt ist (und umgekehrt)
    expect(aiProcessingApproved({ status: "connected", config: valid }, false, true)).toBe(false);
  });

  it("Adapter: ohne gültige Bestätigung gesperrt; env-Freigabe gilt nicht für eine praxiseigene Basis-URL; „aus“ ignoriert die Praxis-Config", async () => {
    const saved = { approved: process.env.LLM_DATA_PROCESSING_APPROVED, key: process.env.LLM_API_KEY, url: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL };
    process.env.LLM_DATA_PROCESSING_APPROVED = "true";
    process.env.LLM_API_KEY = "env-key";
    process.env.LLM_BASE_URL = "https://plattform-llm.example/v1";
    process.env.LLM_MODEL = "env-model";
    try {
      const conn = (status: "connected" | "disconnected", config: Record<string, unknown>) => ({ provider: "llm" as const, status, config, organizationId: "org-1" });
      // praxiseigene Basis-URL mit altem Häkchen: trotz env-Freigabe gesperrt
      const own = getAdapter("llm", conn("connected", { ...target, dataProcessingApproved: true }), { mode: "live" });
      await expect(own.suggestReply("Hallo")).rejects.toThrow(/nicht freigegeben/);
      // eigener API-Schlüssel ohne Basis-URL: ebenfalls Praxisziel – env-Freigabe gilt nicht
      const ownKey = new OpenAiCompatibleLlm({ apiKey: "praxis-key" });
      await expect(ownKey.suggestReply("Hallo")).rejects.toThrow(/nicht freigegeben/);
      const ok = getAdapter("llm", conn("connected", valid), { mode: "live" }) as unknown as { opts: { dataProcessingApproved?: boolean } };
      expect(ok.opts.dataProcessingApproved).toBe(true);
      // Status „aus“: nur der env-Anbieter, Praxis-Ziel und -Bestätigung werden ignoriert
      const off = getAdapter("llm", conn("disconnected", valid), { mode: "live" }) as unknown as { baseUrl: string; opts: { baseUrl?: string; dataProcessingApproved?: boolean } };
      expect(off.baseUrl).toBe("https://plattform-llm.example/v1");
      expect(off.opts.dataProcessingApproved).toBe(false);
    } finally {
      for (const [k, v] of [["LLM_DATA_PROCESSING_APPROVED", saved.approved], ["LLM_API_KEY", saved.key], ["LLM_BASE_URL", saved.url], ["LLM_MODEL", saved.model]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
