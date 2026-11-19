"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Download } from "lucide-react";
import { FormError } from "@/components/form-error";
import { errorFromBody, filenameFromDisposition, handoverErrorText } from "@/lib/gkv-handover/download";

/**
 * Erst-Export des Übergabepakets (GKV Paket E): POST mit Pflicht-Häkchen an /api/export/gkv-batch/[id]/paket – per fetch
 * von derselben Seite (Sec-Fetch-Site: same-origin, siehe guard.ts), damit Fehler (403/409/429) als Meldung hier
 * erscheinen statt als JSON-Seite. Erfolg: Download aus dem Blob, danach Seite neu rendern (neuer Status, Nachdruck-Link).
 * Ohne JavaScript schickt das Formular weiter einen normalen POST (gleiche Route, gleiche Prüfungen).
 */
export function HandoverExport({ batchId }: { batchId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const url = `/api/export/gkv-batch/${batchId}/paket`;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(url, { method: "POST", credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        setError(handoverErrorText(res.status, errorFromBody(body)));
        setAttempt((n) => n + 1);
        return;
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = filenameFromDisposition(res.headers.get("Content-Disposition"));
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
      router.refresh();
    } catch {
      setError("Keine Verbindung zum Server. Bitte prüfe die Internetverbindung und versuch es erneut.");
      setAttempt((n) => n + 1);
    } finally {
      setPending(false);
    }
  }

  return (
    // Erst-Export nur per POST mit Bestätigung (übergibt den Lauf unumkehrbar, AppSec M2)
    <form method="post" action={url} onSubmit={onSubmit} className="flex flex-col gap-3" aria-busy={pending}>
      <FormError id="uebergabe-fehler" message={error} revealKey={attempt} />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" required className="mt-0.5 size-5 accent-[var(--primary)]" />
        Ich übergebe diesen Abrechnungslauf an das Abrechnungszentrum. Das Paket wird archiviert und der Lauf als übergeben vermerkt – das lässt sich
        nicht rückgängig machen.
      </label>
      <div>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-4 font-semibold text-on-primary disabled:opacity-60"
        >
          <Download size={18} aria-hidden /> {pending ? "Übergabepaket wird erzeugt …" : "Übergabepaket erzeugen und herunterladen"}
        </button>
      </div>
      <p className="text-xs text-muted">Nach dem Download zeigt die Seite den Lauf als übergeben. Die CSV „nur Verordnungen“ gibt es danach aus dem Archiv.</p>
    </form>
  );
}
