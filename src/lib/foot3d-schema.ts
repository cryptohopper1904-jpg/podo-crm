/**
 * Serverseitige Prüfung der Fuß-Markierungen aus dem Doku-Formular (getrennt von ./foot3d.ts,
 * damit zod nicht ins Client-Bundle des 3D-Modells wandert).
 */
import { z } from "zod";
import type { FootPoint } from "@/db/schema";
import { FOOT_POINTS, footPointLabel } from "./foot-points";
import { POS_LIMIT, regionFor3d, roundPos } from "./foot3d";

const KNOWN = new Set(FOOT_POINTS.map((p) => p.id));

const footPointSchema = z
  .object({
    side: z.enum(["left", "right"]),
    point: z.string().trim().min(1).max(10).refine((k) => KNOWN.has(k), "Unbekannte Fußstelle."),
    label: z.string().trim().max(120).optional(),
    note: z.string().max(500).optional(),
    pos3d: z
      .array(z.number().finite().min(-POS_LIMIT).max(POS_LIMIT))
      .length(3)
      .transform((v) => roundPos(v))
      .optional(),
  })
  .strict();

export const footPointsSchema = z.array(footPointSchema).max(60, "Höchstens 60 Markierungen je Eintrag.");

/** Liest Markierungen aus dem Formular (JSON). Wirft bei ungültigen Daten. */
export function parseFootPoints(json: string): FootPoint[] {
  const raw: unknown = JSON.parse(json || "[]");
  return footPointsSchema.parse(raw).map((p) => {
    const out: FootPoint = { side: p.side, point: p.point, label: p.label || footPointLabel(p.point) };
    if (p.note) out.note = p.note;
    if (p.pos3d) {
      // Kürzel immer serverseitig aus der Position ableiten (Client-Angabe ist nur Vorschlag)
      out.point = regionFor3d(p.pos3d);
      out.label = footPointLabel(out.point);
      out.pos3d = p.pos3d;
    }
    return out;
  });
}

