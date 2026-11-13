import { FileDown } from "lucide-react";
import { Button, Card, CardTitle, Field, FormError, Input, PageHeader } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateDe } from "@/lib/format";
import { closingsInRange, exportRangeInput } from "@/server/kasse";

export const metadata = { title: "DSFinV-K-Export" };

export default async function KasseExportPage(props: PageProps<"/kasse/export">) {
  const auth = await requireAuth("cash.export");
  const sp = await props.searchParams;
  const today = berlinDateIso();
  const from = typeof sp.from === "string" ? sp.from : `${today.slice(0, 4)}-01-01`;
  const to = typeof sp.to === "string" ? sp.to : today;
  const parsed = exportRangeInput.safeParse({ from, to });
  const list = parsed.success ? await closingsInRange(auth, parsed.data.from, parsed.data.to) : [];
  const href = parsed.success ? `/api/kasse/dsfinvk?from=${parsed.data.from}&to=${parsed.data.to}` : null;
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader back={{ href: "/kasse", label: "Kasse" }} title="DSFinV-K-Export" subtitle="Kassendaten für Betriebsprüfung und Kassen-Nachschau (§ 146b AO)" />
      <Card className="mb-6">
        <CardTitle>Zeitraum</CardTitle>
        <form className="flex flex-wrap items-end gap-3" method="get">
          <Field label="Von (Buchungstag)">
            <Input type="date" name="from" defaultValue={from} max={today} required />
          </Field>
          <Field label="Bis (Buchungstag)">
            <Input type="date" name="to" defaultValue={to} max={today} required />
          </Field>
          <Button type="submit" variant="secondary">Anzeigen</Button>
        </form>
        {!parsed.success ? <div className="mt-4"><FormError message={parsed.error.issues[0]?.message ?? "Zeitraum ungültig."} /></div> : null}
      </Card>
      {parsed.success ? (
        <Card>
          <CardTitle>
            {list.length ? `${list.length} ${list.length === 1 ? "Kassenabschluss" : "Kassenabschlüsse"}` : "Keine Kassenabschlüsse im Zeitraum"}
          </CardTitle>
          {list.length ? (
            <p className="mb-4 text-[15px]">
              Z-Bon Nr. {list[0].number} ({dateDe(list[0].businessDate)}) bis Nr. {list[list.length - 1].number} ({dateDe(list[list.length - 1].businessDate)})
            </p>
          ) : null}
          <p className="mb-4 text-sm text-muted">
            Das ZIP enthält die DSFinV-K-Tabellen (CSV, Semikolon, Dezimalkomma, UTF-8) und die Beschreibung <code>index.xml</code>. Die
            DTD-Datei <code>gdpdu-01-09-2004.dtd</code> wird referenziert und muss bei Weitergabe beigelegt werden. Inhalt und Vollständigkeit
            bitte mit der Steuerberatung abstimmen.
          </p>
          {href && list.length ? (
            <a href={href} className="inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-4 font-semibold text-on-primary hover:bg-primary-hover">
              <FileDown size={18} aria-hidden /> ZIP herunterladen
            </a>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
