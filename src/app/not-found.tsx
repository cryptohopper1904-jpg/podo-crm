import type { Metadata } from "next";
import { headers } from "next/headers";
import { errorContext } from "@/components/error-screen";
import { NotFoundContent } from "@/components/not-found-content";

/**
 * 404 für die ganze App (unbekannte Adressen und notFound() ohne eigene Segment-Seite) – deutsch, mit Logo, hell/dunkel.
 * Text je nach Bereich (x-podo-path aus src/proxy.ts).
 *
 * Manifest: Next.js hängt den Verweis aus src/app/manifest.ts bei der Root-404 immer an (die Datei-Metadaten des
 * Root-Segments werden nach `manifest: null` angewendet). Patientenbereiche haben deshalb eigene Segment-404s ohne
 * Manifest: src/app/buchen/not-found.tsx, src/app/p/not-found.tsx (plus page.tsx für /buchen und /p ohne Slug).
 */
export const metadata: Metadata = { title: "Seite nicht gefunden" };

export default async function NotFound() {
  return <NotFoundContent ctx={errorContext((await headers()).get("x-podo-path"))} />;
}
