"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Checkbox, Field, Input } from "@/components/ui";
import { BOOKING_CHANNELS, BOOKING_CHANNEL_LABEL, LIMITS, type BookingChannel, type DocumentSettings } from "@/lib/practice-documents";
import { saveDocumentsAction } from "../actions";

/** Belege: Website, Berufsbezeichnung, WhatsApp-Hinweis und Buchungsweg (QR-Code auf Rechnungen). */
export function DocumentsForm({ doc, websiteUrl, ownBookingUrl, ownBookingActive }: { doc: DocumentSettings; websiteUrl: string | null; ownBookingUrl: string | null; ownBookingActive: boolean }) {
  const [channel, setChannel] = useState<BookingChannel>(doc.booking.channel);
  return (
    <ActionForm action={saveDocumentsAction}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Website (Fußzeile)" hint="z. B. https://www.podologie-kiehne.de">
          <Input name="websiteUrl" type="url" inputMode="url" defaultValue={websiteUrl ?? ""} maxLength={LIMITS.url} placeholder="https://" />
        </Field>
        <Field label="Berufsbezeichnung / Qualifikation (Fußzeile)" hint="Erscheint klein unter der Fußzeile, z. B. „staatlich anerkannte Podologin & Heilpraktikerin auf dem Gebiet der Podologie“.">
          <Input name="qualification" defaultValue={doc.qualification ?? ""} maxLength={LIMITS.qualification} />
        </Field>
      </div>
      <Field label="Standard-Zahlungsziel für neue Rechnungen (Tage)" hint="0 = sofort fällig („Zahlbar sofort“). Lässt sich auf jeder Rechnung noch ändern." className="sm:max-w-xs">
        <Input name="dueDays" type="number" inputMode="numeric" min={0} max={120} defaultValue={doc.dueDays} required />
      </Field>
      <div className="flex flex-col gap-1">
        <Checkbox
          name="therapeuticDefault"
          defaultChecked={doc.therapeuticDefault}
          label="USt-Wächter dauerhaft bestätigen: Unsere 0-%-Leistungen sind Heilbehandlungen mit therapeutischem Ziel (Befund/Verordnung dokumentiert)"
        />
        <p className="ml-8 text-xs text-muted">
          Dann ist der Haken auf neuen Rechnungen schon gesetzt; bei kosmetischen Leistungen (z. B. Fußpflege ohne Befund) auf der Rechnung abwählen bzw. 19 % wählen. Steuerliche Einordnung bitte mit der Steuerberatung abstimmen.
        </p>
      </div>
      <Checkbox name="whatsapp" defaultChecked={doc.whatsapp} label="Telefonnummer ist auch per WhatsApp erreichbar („auch WhatsApp“ im Block Terminvereinbarung)" />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Hinweis + QR-Code „Nächsten Termin online buchen“ auf Rechnungen</legend>
        {BOOKING_CHANNELS.map((c) => (
          <label key={c} className="flex min-h-11 items-center gap-3 text-[15px]">
            <input type="radio" name="bookingChannel" value={c} checked={channel === c} onChange={() => setChannel(c)} className="size-5 accent-[var(--primary)]" />
            <span>{BOOKING_CHANNEL_LABEL[c]}</span>
          </label>
        ))}
        {channel === "podohero" ? (
          <p className="ml-8 text-sm text-muted">
            {ownBookingUrl && ownBookingActive ? <>Link auf der Rechnung: <span className="break-all font-semibold text-text">{ownBookingUrl}</span></> : "Die eigene Buchungsseite ist derzeit nicht verfügbar (Online-Buchung ausgeschaltet oder Server-Adresse nicht eingerichtet) – dann erscheint kein Hinweis."}
          </p>
        ) : null}
        {channel === "doctolib" ? (
          <Field label="Doctolib-Link Ihrer Praxis" className="ml-8">
            <Input name="doctolibUrl" type="url" inputMode="url" defaultValue={doc.booking.channel === "doctolib" ? doc.booking.url ?? "" : ""} maxLength={LIMITS.url} placeholder="https://www.doctolib.de/…" required />
          </Field>
        ) : null}
        {channel === "custom" ? (
          <div className="ml-8 grid gap-4 sm:grid-cols-2">
            <Field label="Buchungslink">
              <Input name="customUrl" type="url" inputMode="url" defaultValue={doc.booking.channel === "custom" ? doc.booking.url ?? "" : ""} maxLength={LIMITS.url} placeholder="https://" required />
            </Field>
            <Field label="Beschriftung (optional)" hint="Standard: „Nächsten Termin online buchen:“">
              <Input name="customLabel" defaultValue={doc.booking.channel === "custom" ? doc.booking.label ?? "" : ""} maxLength={LIMITS.bookingLabel} />
            </Field>
          </div>
        ) : null}
      </fieldset>
    </ActionForm>
  );
}
