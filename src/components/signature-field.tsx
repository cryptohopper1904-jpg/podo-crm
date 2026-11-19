"use client";

import { useEffect, useRef, useState } from "react";
import { Eraser } from "lucide-react";
import { Button, Input, Select, cx } from "@/components/ui";
import { PAPER_SIGNATURE_LABEL, SIGNATURE_HEIGHT, SIGNATURE_WIDTH, SIGNER_ROLES, SIGNER_ROLE_LABEL, type SignerRole } from "@/lib/signature";

/**
 * Unterschrift der versicherten Person auf dem Gerät (Finger/Stift) für den GKV-Leistungsnachweis. Schreibt das Bild als
 * PNG-data-URL in das versteckte Feld `signatureData` (Server prüft Typ, Größe und Abmessungen) sowie Name und Rolle.
 * Alternativ das bewusst gesetzte Häkchen „Unterschrift auf der Papier-Verordnung (Rückseite) erfasst“.
 * Ohne Angabe bleibt die Behandlung gespeichert, an der Verordnung erscheint „Unterschrift fehlt“.
 */
export function SignatureField({ patientName, compact = false, onChange }: { patientName: string; compact?: boolean; onChange?: (filled: boolean) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [data, setData] = useState("");
  const [paper, setPaper] = useState(false);
  const [role, setRole] = useState<SignerRole>("insured");
  const [name, setName] = useState(patientName);

  useEffect(() => {
    onChange?.(paper || !!data);
  }, [paper, data, onChange]);

  const ctx = () => {
    const c = canvasRef.current?.getContext("2d");
    if (c) {
      c.lineWidth = 4;
      c.lineCap = "round";
      c.lineJoin = "round";
      c.strokeStyle = "#111";
    }
    return c;
  };
  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * SIGNATURE_WIDTH, y: ((e.clientY - r.top) / r.height) * SIGNATURE_HEIGHT };
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pos(e);
    const c = ctx();
    if (c && last.current) {
      c.beginPath();
      c.arc(last.current.x, last.current.y, 1.5, 0, Math.PI * 2);
      c.fill();
    }
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return;
    const p = pos(e);
    const c = ctx();
    if (!c) return;
    c.beginPath();
    c.moveTo(last.current.x, last.current.y);
    c.lineTo(p.x, p.y);
    c.stroke();
    last.current = p;
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    setData(canvasRef.current?.toDataURL("image/png") ?? "");
  };
  const clear = () => {
    const c = canvasRef.current;
    c?.getContext("2d")?.clearRect(0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
    setData("");
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">Bestätigung der Behandlung (Unterschrift)</legend>
      <input type="hidden" name="signatureData" value={paper ? "" : data} />
      {!paper ? (
        <>
          <div className="relative">
            <canvas
              ref={canvasRef}
              width={SIGNATURE_WIDTH}
              height={SIGNATURE_HEIGHT}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              onPointerLeave={up}
              aria-label="Unterschriftsfeld – mit Finger oder Stift unterschreiben"
              className={cx("w-full touch-none rounded-xl border-2 border-dashed border-border bg-white", compact ? "h-28" : "h-40")}
            />
            {!data ? <span className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-xs text-[#525252]">Hier unterschreiben</span> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input name="signerName" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Name der unterschreibenden Person" aria-label="Name der unterschreibenden Person" className="min-w-48 flex-1" />
            <Select name="signerRole" value={role} onChange={(e) => setRole(e.target.value as SignerRole)} aria-label="Wer unterschreibt?" className="w-auto">
              {SIGNER_ROLES.map((r) => <option key={r} value={r}>{SIGNER_ROLE_LABEL[r]}</option>)}
            </Select>
            <Button type="button" variant="ghost" onClick={clear} className="text-sm"><Eraser size={16} aria-hidden /> Unterschrift löschen</Button>
          </div>
        </>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="paperSigned" checked={paper} onChange={(e) => setPaper(e.target.checked)} className="size-5 accent-[var(--primary)]" />
        {PAPER_SIGNATURE_LABEL}
      </label>
      {!paper && !data ? <p className="text-xs text-muted">Ohne Unterschrift wird die Behandlung gespeichert, an der Verordnung steht dann „Unterschrift fehlt“ (nachtragen im Leistungsnachweis).</p> : null}
    </fieldset>
  );
}
