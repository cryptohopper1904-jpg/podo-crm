/** Fenster „Neuer Termin“ über dem Kalender – reine Logik ohne DOM (Position, Vorbelegung aus Links). */

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };

/**
 * Fensterposition im sichtbaren Bereich halten: links/oben nie außerhalb, rechts/unten so weit, dass mindestens
 * `keep` px (bzw. das ganze Fenster, falls kleiner) sichtbar bleiben – die Titelleiste ist immer greifbar.
 */
export function clampPosition(p: Point, size: Size, viewport: Size, margin = 8, keep = 160): Point {
  const visibleW = Math.min(size.width, keep);
  const maxX = Math.max(margin, viewport.width - visibleW - margin);
  const minX = Math.min(margin, maxX);
  // oben: ganze Titelleiste sichtbar; unten: mindestens die Titelleiste (48 px) über dem Rand
  const maxY = Math.max(margin, viewport.height - Math.min(size.height, 48) - margin);
  const x = Math.round(Math.min(Math.max(p.x, minX), maxX));
  const y = Math.round(Math.min(Math.max(p.y, margin), maxY));
  // Fenster passt ganz hinein → ganz hineinschieben
  const fitX = size.width + 2 * margin <= viewport.width ? Math.min(x, viewport.width - size.width - margin) : x;
  const fitY = size.height + 2 * margin <= viewport.height ? Math.min(y, viewport.height - size.height - margin) : y;
  return { x: Math.max(margin, fitX), y: Math.max(margin, fitY) };
}

/** Startposition: rechts neben dem Klick bzw. rechts oben, im sichtbaren Bereich */
export function initialPosition(viewport: Size, size: Size, anchor?: Point | null, margin = 16): Point {
  const base = anchor ? { x: anchor.x + 24, y: anchor.y - 80 } : { x: viewport.width - size.width - margin * 2, y: 96 };
  if (anchor && base.x + size.width > viewport.width - margin) base.x = anchor.x - size.width - 24;
  return clampPosition(base, size, viewport, margin, size.width);
}

export type NewPrefill = { date?: string; time?: string; therapistId?: string; durationMin?: number; serviceId?: string; patientId?: string };

/** Vorbelegung aus einem Link auf /kalender/neu (?datum, zeit, behandler, dauer, leistung, patient); sonst null */
export function prefillFromHref(href: string, origin = "http://x"): NewPrefill | null {
  let u: URL;
  try {
    u = new URL(href, origin);
  } catch {
    return null;
  }
  if (u.pathname !== "/kalender/neu") return null;
  const q = u.searchParams;
  const out: NewPrefill = {};
  const date = q.get("datum");
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.date = date;
  const time = q.get("zeit");
  if (time && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) out.time = time;
  const uuid = /^[0-9a-f-]{36}$/i;
  const t = q.get("behandler");
  if (t && uuid.test(t)) out.therapistId = t;
  const d = Number(q.get("dauer"));
  if (Number.isInteger(d) && d >= 5 && d <= 480) out.durationMin = d;
  const s = q.get("leistung");
  if (s && uuid.test(s)) out.serviceId = s;
  const p = q.get("patient");
  if (p && uuid.test(p)) out.patientId = p;
  return out;
}
