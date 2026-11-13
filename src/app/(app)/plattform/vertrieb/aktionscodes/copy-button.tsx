"use client";

import { useState } from "react";

/** Kopiert einen Link in die Zwischenablage (Fallback: Link wird markierbar angezeigt). */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <span className="flex flex-col">
      <button
        type="button"
        className="text-left text-sm font-semibold text-primary"
        title={text}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState("ok");
          } catch {
            setState("fail");
          }
        }}
      >
        {state === "ok" ? `${label} kopiert` : `${label} kopieren`}
      </button>
      {state === "fail" ? <span className="select-all break-all text-xs text-muted">{text}</span> : null}
    </span>
  );
}
