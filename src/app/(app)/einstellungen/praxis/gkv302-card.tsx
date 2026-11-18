import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, Input, Table } from "@/components/ui";
import { berlinDateIso, dateTimeDe } from "@/lib/format";
import { gkv302Status } from "@/server/gkv302-export";
import { removeKotrAction, saveGkv302TarifAction, uploadKotrAction } from "../actions";

const ZERTIFIKAT: Record<string, string> = {
  nicht_hinterlegt: "nicht hinterlegt",
  beantragt: "beantragt",
  gueltig: "gültig",
  laeuft_ab: "läuft bald ab",
  abgelaufen: "abgelaufen",
};

/**
 * Einstellungen → Praxis → „Direktabrechnung § 302 (Erprobung)“: Tarifkennzeichen, Kostenträgerdateien (KOTR,
 * verschlüsselt abgelegt) und – nur vorbereitet – das ITSG-Zertifikat. Es werden in diesem Stand KEINE Schlüssel
 * gespeichert; das Upload-Feld für das Zertifikat ist deaktiviert (docs/GKV-302.md, „Was die Praxis beantragen muss“).
 */
export async function Gkv302Card({ org, readOnly, support }: { org: string; readOnly: boolean; support: boolean }) {
  const s = await gkv302Status(org);
  const heute = berlinDateIso();
  return (
    <Card id="direktabrechnung" className="scroll-mt-24">
      <h2 className="mb-1 font-display text-lg font-semibold">Direktabrechnung § 302 (Erprobung)</h2>
      <p className="mb-4 text-sm text-muted">
        Vorbereitung der Abrechnung direkt mit den Krankenkassen (Datenaustausch nach § 302 SGB V). Heute nur Prüflauf und unverschlüsselte Testdatei unter
        Verordnungen → GKV-Abrechnung – <strong>noch kein Versand</strong>. Bis dahin läuft die Abrechnung wie gewohnt über das Abrechnungszentrum.
      </p>

      <h3 className="mb-2 font-semibold">Tarifkennzeichen</h3>
      <ActionForm action={saveGkv302TarifAction}>
        <Field label="Tarifkennzeichen" hint="5 Stellen laut Zulassung bzw. Vertrag (Tarifbereich + Sondertarif), z. B. aus dem Zulassungsbescheid. Ohne Angabe entsteht keine Datei.">
          <Input name="tarifkennzeichen" defaultValue={s.tarifkennzeichen ?? ""} maxLength={5} autoComplete="off" spellCheck={false} className="max-w-40 uppercase" />
        </Field>
      </ActionForm>

      <h3 className="mt-6 mb-2 font-semibold">Kostenträgerdateien</h3>
      <p className="mb-3 text-sm text-muted">
        Aus der Kostenträgerdatei ermittelt PodoHero Kostenträger, Datenannahmestelle und Belegannahmestelle je Krankenkasse. Die Dateien gibt es kostenlos bei
        gkv-datenaustausch.de (Leistungserbringer → Sonstige Leistungserbringer → Kostenträgerdateien) – je Kassenart eine Datei, Dateiname z. B. „AO05Q426.KE0“
        (bitte entpackt hochladen). Neue Fassungen und Nachträge erscheinen laufend; eine neue Datei derselben Kassenart ersetzt die alte. Die Dateien werden verschlüsselt gespeichert.
      </p>
      {s.kotr.length ? (
        <Table label="Hinterlegte Kostenträgerdateien" minWidth={720}>
          <thead><tr><th>Kassenart</th><th>Datei</th><th>Gültig ab</th><th>Einträge</th><th>Hochgeladen</th><th><span className="sr-only">Aktion</span></th></tr></thead>
          <tbody>
            {s.kotr.map((k) => (
              <tr key={k.kassenart}>
                <td className="font-semibold">{k.kassenart}</td>
                <td className="tabular-nums">{k.dateiname}</td>
                <td>
                  {k.gueltigAb}{" "}
                  {k.gueltigAbDatum > heute ? <Badge tone="warn">noch nicht gültig</Badge> : <Badge tone="primary">in Kraft</Badge>}
                </td>
                <td className="tabular-nums">{k.institutionen}</td>
                <td>{dateTimeDe(new Date(k.hochgeladenAm))}</td>
                <td>
                  <ActionForm action={removeKotrAction} submit="Entfernen" className="flex flex-col gap-2">
                    <input type="hidden" name="kassenart" value={k.kassenart} />
                  </ActionForm>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="mb-3 rounded-xl bg-info-soft px-4 py-3 text-sm text-info-soft-text">Noch keine Kostenträgerdatei hinterlegt – ohne sie lassen sich Kostenträger und Datenannahmestelle nicht ermitteln.</p>
      )}
      <ActionForm action={uploadKotrAction} submit="Hochladen" className="mt-3 flex flex-col gap-3">
        <Field label="Kostenträgerdatei hochladen" hint="Textdatei nach Anhang 3 zur TA1, höchstens 8 MB. Wird geprüft (Format, Dateiname) und nie ausgeführt.">
          <input type="file" name="file" required className="text-sm file:mr-3 file:h-11 file:rounded-xl file:border file:border-border file:bg-surface-2 file:px-4 file:font-semibold" />
        </Field>
      </ActionForm>

      <h3 className="mt-6 mb-2 font-semibold">Zertifikat (ITSG)</h3>
      <p className="mb-2 text-sm">
        Status: <Badge tone={s.krypto.zertifikat === "gueltig" ? "primary" : "warn"}>{ZERTIFIKAT[s.krypto.zertifikat] ?? s.krypto.zertifikat}</Badge>
      </p>
      <p className="mb-3 text-sm text-muted">
        Für den echten Versand müssen die Abrechnungsdateien signiert und verschlüsselt werden (Security-Schnittstelle SECON, GGT Anlage 16). Dafür braucht die Praxis
        ein Zertifikat des ITSG Trust Centers auf ihr IK (Laufzeit ein Jahr, jährlicher Folgeantrag) und die Anmeldung bei den Datenannahmestellen mit Testphase.
        Diese Funktion ist vorbereitet, aber noch nicht freigeschaltet: Hier werden noch keine Schlüssel oder Zertifikate gespeichert.
      </p>
      <Field label="Zertifikat einspielen (folgt)" hint="Noch nicht verfügbar – bitte keine Schlüsseldateien hochladen oder per E-Mail schicken.">
        <input type="file" disabled aria-disabled className="text-sm opacity-60 file:mr-3 file:h-11 file:rounded-xl file:border file:border-border file:bg-surface-2 file:px-4 file:font-semibold" />
      </Field>
      {readOnly ? <p className="mt-3 text-sm text-muted">Im Nur-Lesen-Modus sind Änderungen gesperrt.</p> : null}
      {support ? <p className="mt-3 text-sm text-muted">Im Support-Modus können Kostenträgerdateien nicht hochgeladen oder entfernt werden – das entscheidet die Praxis selbst.</p> : null}
    </Card>
  );
}
