import { LegalDoc } from "../_content/legal-doc";

export const dynamic = "force-static";
export const metadata = { title: "Datenschutzerklärung" };

export default function Page() {
  return <LegalDoc doc="datenschutz" />;
}
