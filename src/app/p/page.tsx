import { notFound } from "next/navigation";

/** Ohne Praxis-Kennung gibt es hier nichts – 404 über ./not-found.tsx (ohne Manifest-Verweis, nicht die Root-404). */
export default function Page() {
  notFound();
}
