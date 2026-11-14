import type { Metadata } from "next";
import { NotFoundContent } from "@/components/not-found-content";
import { NOT_INSTALLABLE } from "@/lib/pwa/app-meta";

/**
 * 404 für Patient:innen unter /anamnese: eigene Segment-Seite (Sie-Form, kein Weg in die Praxis-App) – anders als die
 * Root-404 ohne Verweis auf das Manifest der Praxis-App (NOT_INSTALLABLE wie im Segment-Layout).
 */
export const metadata: Metadata = { title: "Seite nicht gefunden", ...NOT_INSTALLABLE };

export default function NotFound() {
  return <NotFoundContent ctx="patient" />;
}
