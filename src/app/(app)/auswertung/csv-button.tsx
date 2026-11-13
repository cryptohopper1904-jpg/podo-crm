"use client";

import { Download } from "lucide-react";
import { writeCsv } from "@/integrations/csv";
import { neutralizeCsvRows } from "@/lib/csv-safe";

/**
 * CSV-Export einer Auswertungstabelle – im Browser erzeugt (nur Aggregate, keine Personendaten).
 * Semikolon + BOM (Excel, deutsches Gebietsschema); Textzellen gegen Formel-Injection neutralisiert.
 */
export function CsvButton({ filename, rows }: { filename: string; rows: (string | number)[][] }) {
  const download = () => {
    const blob = new Blob([writeCsv(neutralizeCsvRows(rows))], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <button
      type="button"
      onClick={download}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-primary hover:bg-surface-2"
    >
      <Download size={16} aria-hidden /> CSV
    </button>
  );
}
