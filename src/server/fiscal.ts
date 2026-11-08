import "server-only";
import { randomUUID } from "node:crypto";
import type { Tx } from "@/db";
import { fiscalTransactions } from "@/db/schema";
import { allocateByVat, getFiscalPort, type FiscalSignature } from "@/integrations/tse";
import { isRegisterMethod } from "@/lib/kasse/model";
import { log } from "@/lib/log";

/**
 * KassenSichV: JEDER Vorgang, den PodoCRM als Kassenvorgang aufzeichnet (Bar, Karte, Gutschein), wird über die TSE
 * abgesichert – nicht nur Bargeld. Überweisung/Zahlungslink sind keine Kassenvorgänge (keine Signatur).
 * Die Signatur wird vollständig in fiscal_transactions gespeichert (append-only); payments.external_ref ist dafür
 * nicht maßgeblich.
 */
export class FiscalSignError extends Error {}

export const needsSignature = (method: string) => isRegisterMethod(method);

export type SignedPayment = { paymentId: string; signature: FiscalSignature; vendor: string };

/** Signiert einen Kassenvorgang. Die Zahlungs-ID wird vorab vergeben, damit die Signatur ihr zugeordnet werden kann. */
export async function signRegisterPayment(input: {
  reference: string;
  method: string;
  amountCents: number;
  vatGroups: { rate: number; grossCents: number }[];
}): Promise<SignedPayment> {
  const port = getFiscalPort();
  try {
    const { transactionId } = await port.startTransaction({ reference: input.reference });
    const signature = await port.finishTransaction({
      transactionId,
      reference: input.reference,
      amounts: allocateByVat(input.amountCents, input.vatGroups),
      paymentType: input.method === "cash" ? "cash" : "non_cash",
      paymentCents: input.amountCents,
    });
    return { paymentId: randomUUID(), signature, vendor: port.vendor };
  } catch (e) {
    // Anbieter-Details nur ins Server-Log (ohne Zugangsdaten), nicht an die Oberfläche
    log.error("tse.sign_failed", { error: e, kind: input.method });
    throw new FiscalSignError("Der Kassenvorgang konnte nicht über die TSE signiert werden. Bitte erneut versuchen oder den Support kontaktieren.");
  }
}

/** Speichert die Signatur zur (bereits angelegten) Zahlung – in derselben Transaktion wie die Zahlung. */
export async function storeSignature(tx: Tx, org: string, s: SignedPayment) {
  const sig = s.signature;
  const at = (v: string) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  };
  await tx.insert(fiscalTransactions).values({
    organizationId: org,
    paymentId: s.paymentId,
    vendor: s.vendor,
    tssSerial: String(sig.tssSerial).slice(0, 100),
    txNumber: sig.number,
    signatureCounter: sig.signatureCounter,
    signature: String(sig.signature).slice(0, 1000),
    startedAt: at(sig.startedAt),
    finishedAt: at(sig.finishedAt),
    isTest: sig.isTest,
  });
}
