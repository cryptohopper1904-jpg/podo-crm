"use client";

/** Lädt den Datenschutzhinweis als Textdatei herunter (UTF-8 mit BOM, damit Word/Editor die Umlaute erkennen). */
export function Art14Download({ text, filename }: { text: string; filename: string }) {
  return (
    <button
      type="button"
      className="text-left text-sm font-semibold text-primary"
      onClick={() => {
        const url = URL.createObjectURL(new Blob(["﻿", text.replace(/\n/g, "\r\n")], { type: "text/plain;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}
    >
      Als Textdatei herunterladen
    </button>
  );
}
