import { readFile } from "node:fs/promises";
import path from "node:path";
import { Markdown } from "@/components/markdown";

export const LEGAL_FILES = {
  agb: "AGB.md",
  avv: "AVV.md",
  datenschutz: "DATENSCHUTZ.md",
  impressum: "IMPRESSUM.md",
  unterauftragnehmer: "UNTERAUFTRAGNEHMER.md",
} as const;

/**
 * Rechtstext aus docs/legal/*.md. Die Seiten werden zur Laufzeit gerendert (Metadaten aus PUBLIC_URL im Layout);
 * die Markdown-Dateien kommen über outputFileTracingIncludes (next.config.ts) in den Standalone-Output.
 */
export async function LegalDoc({ doc }: { doc: keyof typeof LEGAL_FILES }) {
  const source = await readFile(path.join(process.cwd(), "docs", "legal", LEGAL_FILES[doc]), "utf8");
  return (
    <article lang="de" className="mx-auto max-w-3xl px-4 py-14 hyphens-auto wrap-break-word sm:px-6">
      <Markdown source={source} />
    </article>
  );
}
