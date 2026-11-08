import { createHash, randomUUID } from "node:crypto";
import type { FiscalFinishInput, FiscalPort, FiscalSignature, FiscalStartInput } from "./types";

/**
 * Mock-TSE: erzeugt fortlaufende Test-Signaturen (prozesslokal). KEINE gültige TSE –
 * nur für Entwicklung und den Testbetrieb ohne Bargeld.
 */
export class FiscalMock implements FiscalPort {
  readonly vendor = "mock" as const;
  readonly isMock = true;
  private static counter = 0;
  private readonly open = new Map<string, string>();

  async startTransaction(_input: FiscalStartInput) {
    const transactionId = randomUUID();
    const startedAt = new Date().toISOString();
    this.open.set(transactionId, startedAt);
    return { transactionId, startedAt };
  }

  async finishTransaction(input: FiscalFinishInput): Promise<FiscalSignature> {
    const startedAt = this.open.get(input.transactionId) ?? new Date().toISOString();
    this.open.delete(input.transactionId);
    const n = ++FiscalMock.counter;
    const finishedAt = new Date().toISOString();
    const signature = createHash("sha256")
      .update(`${input.transactionId}|${input.reference}|${input.paymentCents}|${JSON.stringify(input.amounts)}|${n}`)
      .digest("base64");
    return { transactionId: input.transactionId, number: n, signatureCounter: n, signature, startedAt, finishedAt, tssSerial: "MOCK-TSE", isTest: true };
  }

  async exportDsfinvk() {
    return { exportId: `mock-export-${Date.now()}`, status: "ready" as const, downloadUrl: null };
  }
}
