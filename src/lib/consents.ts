/** Einwilligungen, die in der Akte verwaltet werden (versioniert, nur anhängend gespeichert). */
export const CONSENT_LABELS: Record<string, string> = {
  privacy_notice: "Datenschutzhinweise erhalten",
  photo_documentation: "Fotodokumentation (Behandlung)",
  photo_marketing: "Fotos für Werbung (anonymisiert)",
  email_reminders: "Terminerinnerung per E-Mail",
  sms_reminders: "Terminerinnerung per SMS",
  whatsapp: "Kontakt über WhatsApp (nur Organisatorisches)",
  marketing: "Newsletter / Angebote (§ 7 UWG)",
  review_request: "Bitte um Bewertung",
  ai_processing: "KI-Unterstützung (Sprachbericht)",
  call_recording: "Aufzeichnung von Telefonaten",
  no_show_terms: "Ausfallhonorar-Regelung akzeptiert",
};
