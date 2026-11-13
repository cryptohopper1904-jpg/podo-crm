import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db";
import { media, patients } from "@/db/schema";
import { audit } from "@/lib/audit";
import { getAuth } from "@/lib/auth/session";
import { ALLOWED_MIME, MAX_UPLOAD_BYTES, discardStored, sniffMime, storeEncrypted } from "@/lib/storage";

const meta = z.object({
  patientId: z.string().uuid(),
  purpose: z.enum(["brace_before", "brace_progress", "brace_complication", "brace_after", "finding", "wound", "document", "prescription", "voice_report", "marketing"]),
  footSide: z.enum(["left", "right"]).optional().nullable(),
  toe: z.coerce.number().int().min(1).max(5).optional().nullable(),
  view: z.string().max(40).optional().nullable(),
  caption: z.string().max(300).optional().nullable(),
});

/** Upload eines Fotos/Dokuments direkt aus der Behandlung (wird sofort verschlüsselt gespeichert). */
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth || !auth.can("medical.write")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Datei fehlt" }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "Datei zu groß (max. 25 MB)" }, { status: 413 });
  const buf = Buffer.from(await file.arrayBuffer());
  const mime = sniffMime(buf);
  if (!mime || !ALLOWED_MIME.has(mime)) return NextResponse.json({ error: "Dateityp nicht erlaubt (erlaubt: Fotos, Audio, PDF)" }, { status: 415 });
  const parsed = meta.safeParse({
    patientId: form.get("patientId"),
    purpose: form.get("purpose"),
    footSide: form.get("footSide") || null,
    toe: form.get("toe") || null,
    view: form.get("view") || null,
    caption: form.get("caption") || null,
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const org = auth.organization.id;
  const d = parsed.data;
  const exists = await withOrg(org, (tx) => tx.select({ id: patients.id }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, d.patientId))));
  if (!exists.length) return NextResponse.json({ error: "Patient nicht gefunden" }, { status: 404 });

  const stored = await storeEncrypted(org, buf);
  let row: { id: string };
  try {
    [row] = await withOrg(org, (tx) =>
    tx
      .insert(media)
      .values({
        organizationId: org,
        patientId: d.patientId,
        kind: mime.startsWith("image/") ? "photo" : mime.startsWith("audio/") ? "audio" : "document",
        purpose: d.purpose,
        storageKey: stored.storageKey,
        mime,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        footSide: d.footSide ?? null,
        toe: d.toe ?? null,
        view: d.view ?? null,
        caption: d.caption ?? null,
        uploadedBy: auth.user.id,
      })
      .returning({ id: media.id }),
    );
  } catch (e) {
    // keine verwaisten Gesundheitsdateien ohne DB-Eintrag
    await discardStored(stored.storageKey).catch(() => {});
    throw e;
  }
  await audit({ organizationId: org, userId: auth.user.id, action: "media.upload", entity: "media", entityId: row.id, meta: { purpose: d.purpose } });
  return NextResponse.json({ id: row.id });
}
