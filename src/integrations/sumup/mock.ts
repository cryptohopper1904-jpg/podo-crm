import { mockId } from "../mock-util";
import type { CheckoutInput, PaymentPort, PaymentTransaction, TerminalPaymentInput } from "../types";
import { verifyHmacSignature } from "./sumup";

/**
 * Mock: Checkouts gelten sofort als bezahlt, Terminal-Zahlungen ebenfalls –
 * außer der Betrag endet auf 13 Cent (→ „failed“, zum Testen des Fehlerpfads).
 */
export class SumupMock implements PaymentPort {
  readonly provider = "sumup" as const;
  readonly isMock = true;
  readonly transactions = new Map<string, PaymentTransaction>();

  constructor(private readonly webhookSecret = "mock-secret") {}

  private record(id: string, amountCents: number, reference: string | null): PaymentTransaction {
    const tx: PaymentTransaction = {
      id,
      status: amountCents % 100 === 13 ? "failed" : "paid",
      amountCents,
      currency: "EUR",
      reference,
      paidAt: "2026-01-01T10:00:00.000Z",
      cardType: "VISA",
    };
    this.transactions.set(id, tx);
    return tx;
  }

  async createCheckout(input: CheckoutInput) {
    const id = mockId("sumup-checkout", input.reference);
    const tx = this.record(id, input.amountCents, input.reference);
    return { checkoutId: id, url: `https://pay.example.invalid/checkout/${id}`, status: tx.status };
  }

  async startTerminalPayment(input: TerminalPaymentInput) {
    const id = mockId("sumup-reader", `${input.readerId}|${input.reference ?? ""}|${input.amountCents}`);
    this.record(id, input.amountCents, input.reference ?? null);
    return { clientTransactionId: id };
  }

  async getTransaction(id: string) {
    const tx = this.transactions.get(id);
    if (!tx) return { id, status: "unknown" as const, amountCents: 0, currency: "EUR" };
    return tx;
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>) {
    const sig = Object.entries(headers).find(([k]) => k.toLowerCase() === "x-payload-signature")?.[1];
    return verifyHmacSignature(rawBody, sig, this.webhookSecret);
  }
}
