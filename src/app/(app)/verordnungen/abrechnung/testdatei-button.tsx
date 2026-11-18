"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Button, FormError, FormSuccess } from "@/components/ui";

/**
 * „Testdatei erzeugen“: POST an /api/export/gkv302-test (vergibt Test-Nummern, schreibt Audit), lädt das ZIP herunter.
 * Fehlermeldungen des Servers (z. B. kein Fall vollständig) werden angezeigt statt einer leeren Datei.
 */
export function TestdateiButton({ quelle, disabled, anzahl }: { quelle: string; disabled: boolean; anzahl: number }) {
  const [pending, setPending] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function erzeugen() {
    setPending(true);
    setFehler(null);
    setOk(null);
    try {
      const res = await fetch("/api/export/gkv302-test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quelle }), credentials: "same-origin" });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        setFehler(j?.error ?? "Die Testdatei konnte nicht erzeugt werden.");
        return;
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "TEST-302.zip";
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setOk(`Testdatei ${name} erzeugt.`);
    } catch {
      setFehler("Verbindung fehlgeschlagen. Bitte erneut versuchen.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <FormError message={fehler ?? undefined} />
      {ok ? <FormSuccess message={ok} /> : null}
      <div>
        <Button type="button" onClick={erzeugen} disabled={disabled || pending} className="inline-flex items-center gap-2">
          <Download size={18} aria-hidden /> {pending ? "Wird erzeugt …" : `Testdatei erzeugen (${anzahl} ${anzahl === 1 ? "Fall" : "Fälle"})`}
        </Button>
      </div>
    </div>
  );
}
