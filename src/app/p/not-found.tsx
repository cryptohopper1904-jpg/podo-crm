import type { Metadata } from "next";
import { NotFoundContent } from "@/components/not-found-content";
import { NOT_INSTALLABLE } from "@/lib/pwa/app-meta";

/**
 * 404 für Patient:innen (unbekannte Praxis, deaktivierte Seite): eigene Segment-Seite, damit – anders als bei der
 * Root-404 – kein Verweis auf das Manifest der Praxis-App im HTML steht (NOT_INSTALLABLE wie im Segment-Layout).
 */
export const metadata: Metadata = { title: "Seite nicht gefunden", ...NOT_INSTALLABLE };

export default function NotFound() {
  return <NotFoundContent ctx="patient" />;
}
