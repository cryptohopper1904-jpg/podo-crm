"use client";

import { useState } from "react";
import { Copy, Mail } from "lucide-react";
import { Button } from "@/components/ui";

/** Bestelltext kopieren bzw. im Mailprogramm öffnen – es wird nichts automatisch bestellt. */
export function CopyOrderText({ text, email, subject }: { text: string; email: string | null; subject: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="no-print flex flex-wrap gap-2">
      <Button
        type="button"
        variant="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setDone(true);
            setTimeout(() => setDone(false), 2500);
          } catch {
            setDone(false);
          }
        }}
      >
        <Copy size={16} aria-hidden /> {done ? "Kopiert" : "Bestelltext kopieren"}
      </Button>
      {email ? (
        <a
          href={`mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`}
          className="inline-flex h-11 items-center gap-2 rounded-xl border border-border bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2"
        >
          <Mail size={16} aria-hidden /> E-Mail vorbereiten
        </a>
      ) : null}
    </div>
  );
}
