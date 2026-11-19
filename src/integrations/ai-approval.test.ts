import { describe, expect, it } from "vitest";
import { AI_APPROVAL_TEXT, AI_APPROVAL_VERSION, aiApprovalInfo, aiApprovalValid, nextAiApproval } from "./ai-approval";
import { getAdapter } from "./registry";

const now = new Date("2026-11-19T10:00:00Z");
const valid = { dataProcessingApproved: true, dataProcessingApproval: { at: "2026-11-01T08:00:00.000Z", by: "user-1", version: AI_APPROVAL_VERSION } };

describe("KI-Anbieter: Pflicht-Bestätigung (AVV, EU, kein Training)", () => {
  it("Wortlaut", () => {
    expect(AI_APPROVAL_TEXT).toBe("Ich habe mit dem Anbieter einen AVV geschlossen, die Verarbeitung erfolgt in der EU und der Anbieter nutzt die Daten nicht zum Training.");
  });

  it("„verbunden (echt)“ ohne Häkchen wird abgelehnt", () => {
    expect(nextAiApproval({}, { status: "connected", checked: false, userId: "u", now })).toMatchObject({ error: expect.stringMatching(/AVV/) });
    expect(nextAiApproval(valid, { status: "connected", checked: false, userId: "u", now })).toMatchObject({ error: expect.any(String) });
  });

  it("mit Häkchen: Zeitpunkt und Benutzer gespeichert; bestehende Bestätigung bleibt unverändert", () => {
    expect(nextAiApproval({}, { status: "connected", checked: true, userId: "u-2", now })).toEqual({
      dataProcessingApproved: true,
      dataProcessingApproval: { at: "2026-11-19T10:00:00.000Z", by: "u-2", version: AI_APPROVAL_VERSION },
      changed: true,
    });
    expect(nextAiApproval(valid, { status: "connected", checked: true, userId: "u-2", now })).toEqual({ dataProcessingApproved: true, dataProcessingApproval: valid.dataProcessingApproval, changed: false });
  });

  it("aus/Testmodus ohne Häkchen erlaubt – Bestätigung wird entfernt", () => {
    expect(nextAiApproval(valid, { status: "disconnected", checked: false, userId: "u", now })).toEqual({ dataProcessingApproved: false, dataProcessingApproval: null, changed: true });
    expect(nextAiApproval({}, { status: "mock", checked: false, userId: "u", now })).toEqual({ dataProcessingApproved: false, dataProcessingApproval: null, changed: false });
  });

  it("altes Häkchen ohne Zeitpunkt/Benutzer oder alter Wortlaut gilt nicht", () => {
    expect(aiApprovalValid({ dataProcessingApproved: true })).toBe(false);
    expect(aiApprovalValid({ ...valid, dataProcessingApproval: { ...valid.dataProcessingApproval, version: "alt" } })).toBe(false);
    expect(aiApprovalValid({ ...valid, dataProcessingApproved: false })).toBe(false);
    expect(aiApprovalValid(valid)).toBe(true);
    expect(aiApprovalInfo(valid)).toEqual(valid.dataProcessingApproval);
    expect(aiApprovalInfo({ dataProcessingApproved: true })).toBeNull();
  });

  it("Adapter bleibt ohne gültige Bestätigung gesperrt (auch mit altem Häkchen)", async () => {
    const saved = { approved: process.env.LLM_DATA_PROCESSING_APPROVED, key: process.env.LLM_API_KEY };
    delete process.env.LLM_DATA_PROCESSING_APPROVED;
    process.env.LLM_API_KEY = "test-key";
    try {
      const conn = (config: Record<string, unknown>) => ({ provider: "llm" as const, status: "connected" as const, config: { baseUrl: "https://llm.example", model: "m", ...config }, organizationId: "org-1" });
      const legacy = getAdapter("llm", conn({ dataProcessingApproved: true }), { mode: "live" });
      await expect(legacy.suggestReply("Hallo")).rejects.toThrow(/nicht freigegeben/);
      const ok = getAdapter("llm", conn(valid), { mode: "live" }) as unknown as { opts: { dataProcessingApproved?: boolean } };
      expect(ok.opts.dataProcessingApproved).toBe(true);
    } finally {
      if (saved.approved === undefined) delete process.env.LLM_DATA_PROCESSING_APPROVED;
      else process.env.LLM_DATA_PROCESSING_APPROVED = saved.approved;
      if (saved.key === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = saved.key;
    }
  });
});
