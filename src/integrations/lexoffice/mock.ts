import type { AccountingContactInput, AccountingPort, AccountingVoucherInput } from "../types";
import { mockId } from "../mock-util";

/** Mock: deterministische IDs aus den Eingaben, Zustand nur im Speicher. */
export class LexofficeMock implements AccountingPort {
  readonly provider = "lexoffice" as const;
  readonly isMock = true;
  readonly contacts = new Map<string, { input: AccountingContactInput; version: number }>();
  readonly vouchers = new Map<string, AccountingVoucherInput>();
  /** Testhilfe: bezahlte Beträge je Voucher-ID */
  readonly paidCents = new Map<string, number>();

  async upsertContact(input: AccountingContactInput) {
    const id = input.externalId ?? mockId("lex-contact", `${input.lastName}|${input.firstName ?? ""}|${input.customerNumber ?? ""}`);
    const prev = this.contacts.get(id);
    const version = prev ? prev.version + 1 : 0;
    this.contacts.set(id, { input, version });
    return { externalId: id, version };
  }

  async pushVoucher(input: AccountingVoucherInput) {
    const id = mockId("lex-voucher", input.number);
    this.vouchers.set(id, input);
    return { externalId: id };
  }

  async getPaymentStatus(externalId: string) {
    const v = this.vouchers.get(externalId);
    if (!v) return { status: "unknown" as const, openCents: 0 };
    const paid = this.paidCents.get(externalId) ?? 0;
    const open = Math.max(0, v.totalGrossCents - paid);
    const status = open === 0 ? ("paid" as const) : paid > 0 ? ("partially_paid" as const) : ("open" as const);
    return { status, openCents: open };
  }
}
