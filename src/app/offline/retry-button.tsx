"use client";

import { useEffect } from "react";
import { RotateCw } from "lucide-react";

/** Lädt die aufgerufene Seite neu – auf Knopfdruck oder von selbst, sobald der Browser wieder online meldet. */
export function RetryButton() {
  useEffect(() => {
    const onOnline = () => location.reload();
    addEventListener("online", onOnline);
    return () => removeEventListener("online", onOnline);
  }, []);
  return (
    <button
      type="button"
      onClick={() => location.reload()}
      className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[15px] font-semibold text-on-primary hover:bg-primary-hover"
    >
      <RotateCw size={18} aria-hidden /> Erneut versuchen
    </button>
  );
}
