/**
 * Umsatzsteuer für Produktpositionen (Salben, Cremes, Pflegeprodukte …) – reine Funktion, läuft im Browser
 * (Rechnungsformular) und auf dem Server (createInvoice, verbindlich).
 *
 * Regel:
 * - Ein Produkt wird grundsätzlich mit seinem regulären Satz verkauft (19 %, ggf. 7 %).
 * - 0 % nur, wenn das Produkt WÄHREND einer Heilbehandlung angewendet/verbraucht wird (unselbständige
 *   Nebenleistung, teilt das Schicksal der steuerfreien Hauptleistung nach § 4 Nr. 14 UStG). Dafür muss derselbe
 *   Beleg eine Behandlungsposition enthalten: Katalogleistung mit therapeutischem Ziel und 0 %.
 * - Auf der Sammelrechnung (mehrere Behandlungstage) muss die Produktposition einer bestimmten Behandlungsposition
 *   zugeordnet werden, sobald mehr als eine Behandlung auf dem Beleg steht (gleicher Tag/Termin).
 * - Mitgegebene oder zum Mitnehmen verkaufte Produkte: immer regulärer Satz.
 * - Kleinunternehmer (§ 19 UStG): keine USt, die Option entfällt.
 * - 0-%-Produktpositionen zählen für den USt-Wächter (Bestätigung „Heilbehandlung mit therapeutischem Ziel“).
 */

export const PRODUCT_IN_TREATMENT_LABEL = "in der Behandlung angewendet (Nebenleistung, 0 %)";
export const PRODUCT_VAT_HINT =
  "0 % nur, wenn das Produkt während der Behandlung angewendet/verbraucht wird. Mitgegebene oder verkaufte Produkte zum Mitnehmen: 19 %.";
/** Zusatz in der Positionsbeschreibung (steht so auch auf dem Beleg) */
export const IN_TREATMENT_SUFFIX = " – in der Behandlung angewendet";

export type VatRuleLine =
  | {
      kind: "service";
      /** gewählter Satz der Position */
      vatRate: number;
      /** Katalogleistung mit therapeutischem Ziel (services.requires_therapeutic_purpose); Freitext = false */
      therapeutic: boolean;
    }
  | {
      kind: "product";
      vatRate: number;
      /** regulärer Satz des Produkts (19 oder 7) */
      productVatRate: number;
      inTreatment: boolean;
      /** Index (0-basiert) der zugeordneten Behandlungsposition im selben Beleg; null = keine Zuordnung */
      treatmentLine?: number | null;
    };

export type InvoiceKindLike = "invoice" | "receipt" | "collective" | "no_show_fee" | string;

/** Behandlungsposition im Sinne der Regel: Katalogleistung mit therapeutischem Ziel, 0 %, kein Ausfallhonorar. */
export function isTreatmentLine(l: VatRuleLine, invoiceKind: InvoiceKindLike): boolean {
  return invoiceKind !== "no_show_fee" && l.kind === "service" && l.therapeutic && l.vatRate === 0;
}

export type ProductVatResult = { vatRate: number; inTreatment: boolean };

/**
 * Prüft und bestimmt Steuersatz/Behandlungsbezug jeder Produktposition. Andere Positionen bleiben unverändert
 * (Ergebnis null an ihrer Stelle). Fehlertext je Position (1-basiert in der Meldung) oder null.
 */
export function resolveProductVat(
  lines: readonly VatRuleLine[],
  opts: { smallBusiness: boolean; invoiceKind: InvoiceKindLike },
): { results: (ProductVatResult | null)[]; error: string | null } {
  const treatments = lines.map((l, i) => (isTreatmentLine(l, opts.invoiceKind) ? i : -1)).filter((i) => i >= 0);
  const results: (ProductVatResult | null)[] = [];
  let error: string | null = null;
  const fail = (msg: string) => {
    if (!error) error = msg;
  };
  lines.forEach((l, i) => {
    if (l.kind !== "product") return void results.push(null);
    const pos = `Position ${i + 1}`;
    if (opts.invoiceKind === "no_show_fee") fail(`${pos}: Produkte können nicht auf ein Ausfallhonorar.`);
    if (opts.smallBusiness) return void results.push({ vatRate: 0, inTreatment: false });
    if (!l.inTreatment) {
      if (l.vatRate !== l.productVatRate) {
        fail(`${pos}: Produkte zum Mitnehmen werden mit ${l.productVatRate} % verkauft. 0 % nur, wenn das Produkt in der Behandlung angewendet wird.`);
      }
      return void results.push({ vatRate: l.productVatRate, inTreatment: false });
    }
    // in der Behandlung angewendet → 0 %, aber nur mit Behandlung auf demselben Beleg
    if (l.vatRate !== 0) fail(`${pos}: In der Behandlung angewendete Produkte werden mit 0 % abgerechnet.`);
    if (!treatments.length) {
      fail(`${pos}: 0 % für Produkte nur zusammen mit einer Heilbehandlung (0 %) auf demselben Beleg. Ohne Behandlung: ${l.productVatRate} %.`);
    } else if (l.treatmentLine !== null && l.treatmentLine !== undefined) {
      if (!treatments.includes(l.treatmentLine)) fail(`${pos}: Die zugeordnete Position ist keine Heilbehandlung (0 %).`);
    } else if (opts.invoiceKind === "collective" && treatments.length > 1) {
      fail(`${pos}: Bitte die Behandlung (Tag/Termin) zuordnen, bei der das Produkt angewendet wurde.`);
    }
    results.push({ vatRate: 0, inTreatment: true });
  });
  return { results, error };
}
