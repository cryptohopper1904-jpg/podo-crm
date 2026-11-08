import { LegalDoc } from "../_content/legal-doc";

export const dynamic = "force-static";
export const metadata = { title: "Impressum" };

export default function Page() {
  return <LegalDoc doc="impressum" />;
}
