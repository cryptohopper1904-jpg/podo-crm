import { ActionForm } from "@/components/action-form";
import { Badge, Card, Checkbox, Field, Input, Select } from "@/components/ui";
import { OCR_DEFAULT_PROVIDER } from "@/integrations/ocr/ocr";
import { HiddenAreaNotice } from "@/components/hidden-area-notice";
import { requireAuth } from "@/lib/auth/session";
import { feature } from "@/lib/features";
import { dateTimeDe } from "@/lib/format";
import { ocrSettingsView } from "@/server/ocr";
import { saveOcrSettingsAction } from "./actions";

export const metadata = { title: "Verordnungs-OCR" };

export default async function OcrSettingsPage() {
  const auth = await requireAuth("settings.manage");
  if (!feature(auth.organization, "ocr")) return <HiddenAreaNotice area="ocr" />;
  const s = await ocrSettingsView(auth);
  const isOwner = auth.role === "owner" && !auth.support;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-1 flex flex-wrap items-center gap-2 font-display text-lg font-semibold">
          Verordnung per Foto auslesen
          {s.enabled ? <Badge tone={s.mode === "mock" || s.envMock ? "info" : "primary"}>{s.mode === "mock" || s.envMock ? "an · Testmodus" : "an"}</Badge> : <Badge>aus</Badge>}
        </h2>
        <p className="text-sm text-muted">
          Im Verordnungsformular kann das Foto der Papierverordnung (Muster 13) ausgelesen werden. Die Felder werden nur vorgeschlagen –
          jede Angabe wird geprüft und erst mit „Übernehmen“ gespeichert. Das Foto selbst bleibt verschlüsselt in der Praxis; an der
          Verordnung werden nur die Vorschläge mit Sicherheitswerten abgelegt.
        </p>
        {s.blocker && s.enabled ? <p className="mt-3 rounded-xl bg-warn-soft p-3 text-sm font-medium text-warn-soft-text">{s.blocker}</p> : null}
      </Card>

      <Card>
        <h2 className="mb-2 font-display text-lg font-semibold">Datenschutz – bitte lesen</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-sm">
          <li><strong>Gesundheitsdaten verlassen die Praxis:</strong> Im echten Betrieb wird das Foto (Name, Geburtsdatum, Versichertennummer, Diagnose) an den unten eingetragenen KI-Dienst gesendet.</li>
          <li>Zulässig nur mit <strong>Auftragsverarbeitungsvertrag (AVV, Art. 28 DSGVO)</strong> mit diesem Anbieter, Verarbeitung in der <strong>EU</strong> und ohne Nutzung zum Training.</li>
          <li>Der Anbieter muss in eurer <strong>Liste der Unterauftragnehmer</strong> stehen (Datenschutzhinweise der Praxis, Verzeichnis der Verarbeitungstätigkeiten).</li>
          <li>Der <strong>Testmodus</strong> sendet nichts nach außen und liefert erfundene Beispieldaten.</li>
          <li>Jede Auslesung wird im Zugriffsprotokoll vermerkt (ohne Inhalte).</li>
        </ul>
      </Card>

      {isOwner ? (
        <Card>
          <ActionForm action={saveOcrSettingsAction}>
            <Checkbox name="enabled" defaultChecked={s.enabled} label="Verordnungs-OCR einschalten" />
            <Field label="Betriebsart">
              <Select name="mode" defaultValue={s.mode} className="max-w-md">
                <option value="mock">Testmodus (Beispieldaten, nichts verlässt die Praxis)</option>
                <option value="live">Echter KI-Dienst (Foto wird gesendet)</option>
              </Select>
            </Field>
            {s.envMock ? <p className="text-sm text-muted">Diese Installation läuft mit INTEGRATIONS_MODE=mock – es wird immer der Testmodus verwendet.</p> : null}
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Adresse (OpenAI-kompatibel, https)" hint={`Vorschlag (EU): ${OCR_DEFAULT_PROVIDER.label} – ${OCR_DEFAULT_PROVIDER.baseUrl}`}>
                <Input name="baseUrl" type="url" defaultValue={s.baseUrl} placeholder={OCR_DEFAULT_PROVIDER.baseUrl} />
              </Field>
              <Field label="Modell (mit Bildverständnis)" hint={`z. B. ${OCR_DEFAULT_PROVIDER.model}`}>
                <Input name="model" defaultValue={s.model} placeholder={OCR_DEFAULT_PROVIDER.model} />
              </Field>
              <Field label="API-Schlüssel" hint={s.hasKey ? "Ein Schlüssel ist verschlüsselt hinterlegt. Leer lassen, um ihn zu behalten." : "Wird verschlüsselt gespeichert und nie wieder angezeigt."}>
                <Input name="apiKey" type="password" autoComplete="off" placeholder={s.hasKey ? "••••••••" : ""} />
              </Field>
              <Field label="Bildformat der Anfrage">
                <Select name="imageStyle" defaultValue={s.imageStyle}>
                  <option value="string">Datenadresse als Text (z. B. Mistral)</option>
                  <option value="openai">OpenAI-Standard (image_url.url)</option>
                </Select>
              </Field>
              <Field label="Höchstzahl Auslesungen je Stunde (Praxis)">
                <Input name="perHour" type="number" min={1} max={500} defaultValue={s.perHour} />
              </Field>
            </div>
            {s.hasKey ? <Checkbox name="clearKey" label="Hinterlegten API-Schlüssel löschen" /> : null}
            <fieldset className="rounded-xl border border-border p-4">
              <legend className="px-1 text-sm font-semibold">Bestätigung der Inhaber:in (Pflicht für den echten Dienst)</legend>
              {s.consent ? (
                <p className="mb-2 text-sm text-muted">Bestätigt am {dateTimeDe(new Date(s.consent.at))}. Bei einer neuen Adresse muss erneut bestätigt werden.</p>
              ) : null}
              <Checkbox name="confirmAvv" defaultChecked={!!s.consent} label="Mit dem Anbieter besteht ein Auftragsverarbeitungsvertrag (AVV); die Verarbeitung erfolgt in der EU ohne Training auf unseren Daten." />
              <Checkbox name="confirmSubprocessor" defaultChecked={!!s.consent} label="Der Anbieter ist in unserer Liste der Unterauftragnehmer aufgeführt." />
              <Checkbox name="confirmDataLeaves" defaultChecked={!!s.consent} label="Mir ist bewusst, dass Fotos mit Gesundheitsdaten die Praxis verlassen und an diesen Anbieter übermittelt werden." />
            </fieldset>
          </ActionForm>
        </Card>
      ) : (
        <p className="rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">Nur die Inhaber:in der Praxis kann die Verordnungs-OCR ein- oder ausschalten und den Anbieter festlegen.</p>
      )}
    </div>
  );
}
