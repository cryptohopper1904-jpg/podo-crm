import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Badge, Button, Card, CardTitle, Empty, Field, Select, Table } from "@/components/ui";
import type { AuthContext } from "@/lib/auth/session";
import { dateTimeDe, money } from "@/lib/format";
import type { FallPruefung } from "@/lib/gkv302/direktabrechnung";
import { pruefe302, type Gkv302Quelle } from "@/server/gkv302-export";
import { TestdateiButton } from "./testdatei-button";

export const WARNUNG_302 = "Noch nicht an Datenannahmestelle senden – Verschlüsselung/Signatur (ITSG-Zertifikat) fehlt.";

const STATUS: Record<FallPruefung["status"], { label: string; tone: "primary" | "warn" | "accent" }> = {
  ok: { label: "ok", tone: "primary" },
  fehlend: { label: "fehlende Angaben", tone: "warn" },
  abweichung: { label: "Abweichungen", tone: "accent" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `?p302=bereit` bzw. `?p302=<Lauf-ID>` → Quelle; sonst kein Prüflauf */
export function quelleAus(p: string | string[] | undefined): Gkv302Quelle | null {
  if (p === "bereit") return { art: "bereit" };
  if (typeof p === "string" && UUID.test(p)) return { art: "lauf", batchId: p };
  return null;
}

/**
 * Abschnitt „Direktabrechnung § 302 (Erprobung)“: Prüflauf je Verordnung, Summen je Kostenträger, Testdatei.
 * Der Prüflauf läuft nur auf ausdrücklichen Klick (GET mit ?p302=…), er liest nur und protokolliert den Zugriff.
 */
export async function Direktabrechnung({ auth, quelle, batches }: { auth: AuthContext; quelle: Gkv302Quelle | null; batches: { id: string; createdAt: Date; prescriptionCount: number }[] }) {
  const ergebnis = quelle ? await pruefe302(auth, quelle) : null;
  const kannErzeugen = !auth.readOnly && !auth.support;
  const wert = quelle?.art === "lauf" ? quelle.batchId : "bereit";
  return (
    <Card className="mt-6" id="direktabrechnung">
      <CardTitle>Direktabrechnung § 302 (Erprobung)</CardTitle>
      <p className="mb-3 flex items-start gap-2 rounded-xl bg-warn-soft p-4 text-sm font-medium text-warn-soft-text" role="note">
        <TriangleAlert size={18} aria-hidden className="mt-0.5 shrink-0" />
        <span>{WARNUNG_302} Die Testdatei dient nur zur Prüfung der Daten und für die spätere Erprobung mit den Kassen.</span>
      </p>
      <p className="mb-4 text-sm text-muted">
        PodoHero bildet aus den gespeicherten Preis-Snapshots und Stammdaten die Abrechnungsfälle nach der Technischen Anlage 1 und prüft sie.
        Nur Fälle ohne fehlende Angaben und ohne Abweichungen kommen in die Testdatei. Kostenträgerdatei und Tarifkennzeichen:{" "}
        <Link className="font-semibold text-primary underline" href="/einstellungen/praxis#direktabrechnung">Einstellungen → Praxis</Link>.
      </p>
      <form method="get" action="/verordnungen/abrechnung#direktabrechnung" className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Verordnungen" className="min-w-64">
          <Select name="p302" defaultValue={wert}>
            <option value="bereit">alle abrechnungsreifen Verordnungen</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>Abrechnungslauf vom {dateTimeDe(b.createdAt)} ({b.prescriptionCount})</option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="secondary">Fälle prüfen</Button>
      </form>
      {!ergebnis ? null : "error" in ergebnis ? (
        <p className="rounded-xl bg-warn-soft p-4 text-sm text-warn-soft-text">{ergebnis.error}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {ergebnis.laufFehler.length ? (
            <div className="rounded-xl bg-warn-soft p-4 text-sm text-warn-soft-text">
              <p className="font-semibold">Zu viele Verordnungen für einen Lauf:</p>
              <ul className="ml-5 list-disc">{ergebnis.laufFehler.map((f) => <li key={f}>{f}</li>)}</ul>
            </div>
          ) : null}
          {ergebnis.praxisFehler.length ? (
            <div className="rounded-xl bg-warn-soft p-4 text-sm text-warn-soft-text">
              <p className="font-semibold">Praxisdaten unvollständig – es kann keine Datei entstehen:</p>
              <ul className="ml-5 list-disc">{ergebnis.praxisFehler.map((f) => <li key={f}>{f}</li>)}</ul>
            </div>
          ) : null}
          {ergebnis.kotrHinweise.length ? (
            <div className="rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
              <ul className="ml-5 list-disc">{ergebnis.kotrHinweise.map((f) => <li key={f}>{f}</li>)}</ul>
              {!ergebnis.kotrVorhanden ? <Link className="mt-2 inline-block font-semibold underline" href="/einstellungen/praxis#direktabrechnung">Kostenträgerdatei hochladen</Link> : null}
            </div>
          ) : null}
          {ergebnis.faelle.length === 0 ? (
            <Empty title="Keine Verordnungen">In dieser Auswahl gibt es keine Verordnungen.</Empty>
          ) : (
            <>
              <p className="text-sm">
                Geprüft am {ergebnis.stichtag.split("-").reverse().join(".")}: {ergebnis.faelle.length} Verordnungen, davon <strong>{ergebnis.anzahlOk} ok</strong>,{" "}
                {ergebnis.faelle.filter((f) => f.status === "fehlend").length} mit fehlenden Angaben, {ergebnis.faelle.filter((f) => f.status === "abweichung").length} mit Abweichungen.
              </p>
              <Table label="Prüfergebnis je Verordnung" minWidth={900}>
                <thead><tr><th>Verordnung</th><th>Kasse / Kostenträger</th><th>Status</th><th>Fehlende Angaben / Abweichungen</th><th>Hinweise</th><th>Rechnungsbetrag</th></tr></thead>
                <tbody>
                  {ergebnis.faelle.map((f) => (
                    <tr key={f.id} className="align-top">
                      <td className="font-semibold">{f.anzeige}</td>
                      <td className="text-sm">
                        {f.kasseName ?? "–"}{f.kasseIk ? <div className="text-muted tabular-nums">IK {f.kasseIk}</div> : null}
                        {f.kostentraegerIk && f.kostentraegerIk !== f.kasseIk ? <div className="text-muted tabular-nums">Kostenträger {f.kostentraegerIk}</div> : null}
                      </td>
                      <td><Badge tone={STATUS[f.status].tone}>{STATUS[f.status].label}</Badge></td>
                      <td className="text-sm">
                        {[...f.abweichungen, ...f.fehlendeAngaben].length ? (
                          <ul className="ml-4 list-disc">
                            {f.abweichungen.map((t) => <li key={`a${t}`} className="text-accent-soft-text">{t}</li>)}
                            {f.fehlendeAngaben.map((t) => <li key={`f${t}`}>{t}</li>)}
                          </ul>
                        ) : "–"}
                      </td>
                      <td className="text-sm text-muted">{f.hinweise.length ? <ul className="ml-4 list-disc">{f.hinweise.map((t) => <li key={t}>{t}</li>)}</ul> : "–"}</td>
                      <td className="tabular-nums">{f.betraege ? money(f.betraege.rechnungsbetragCent) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <h3 className="font-display text-base font-semibold">Summen je Kostenträger (nur Fälle „ok“)</h3>
              <Table label="Summen je Kostenträger" minWidth={720}>
                <thead><tr><th>Kostenträger</th><th>Datenannahmestelle</th><th>Fälle ok / gesamt</th><th>Brutto</th><th>Zuzahlung</th><th>Rechnungsbetrag</th></tr></thead>
                <tbody>
                  {ergebnis.summen.map((s) => (
                    <tr key={s.ik}>
                      <td>{s.name ?? "–"}<div className="text-sm text-muted tabular-nums">IK {s.ik}</div></td>
                      <td className="tabular-nums">{s.davIk ?? "–"}</td>
                      <td className="tabular-nums">{s.faelleOk} / {s.faelleGesamt}</td>
                      <td className="tabular-nums">{money(s.bruttoCent)}</td>
                      <td className="tabular-nums">{money(s.zuzahlungCent)}</td>
                      <td className="tabular-nums">{money(s.rechnungsbetragCent)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <div className="rounded-xl border border-border p-4">
                <p className="mb-3 text-sm text-muted">
                  Die Testdatei (ZIP) enthält je Datenannahmestelle und Kassenart eine unverschlüsselte Nutzdatei mit Testkennung (TSOL…), die Auftragsdatei
                  und für Papierverordnungen den Begleitzettel (PDF und Text). Rechnungsnummern kommen aus einem eigenen Test-Nummernkreis (T…).
                </p>
                {kannErzeugen ? (
                  <TestdateiButton quelle={wert} disabled={!ergebnis.testpaketMoeglich} anzahl={ergebnis.anzahlOk} />
                ) : (
                  <p className="text-sm text-muted">Im Nur-Lesen- bzw. Support-Modus können keine Dateien erzeugt werden.</p>
                )}
                {!ergebnis.testpaketMoeglich && kannErzeugen ? <p className="mt-2 text-sm text-muted">Erst möglich, wenn die Praxisdaten vollständig sind, eine Kostenträgerdatei hinterlegt ist, höchstens 1000 Verordnungen gewählt sind und mindestens ein Fall „ok“ ist.</p> : null}
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
