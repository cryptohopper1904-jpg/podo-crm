"use client";

import { Printer } from "lucide-react";
import { Button } from "./ui";

export function PrintButton({ label = "Drucken / als PDF speichern" }: { label?: string }) {
  return (
    <Button type="button" variant="secondary" onClick={() => window.print()} className="no-print">
      <Printer size={18} aria-hidden /> {label}
    </Button>
  );
}
