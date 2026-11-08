"use client";

/**
 * Interaktiver 3D-Fuß (three.js). Wird NUR per next/dynamic (ssr:false) geladen – siehe ./index.tsx –,
 * damit three.js nicht im Haupt-Bundle landet und das 2D-Schema der schnelle Standard bleibt.
 *
 * Bedienung: Ziehen = drehen (Maus, Finger, Stift), Mausrad/Zwei-Finger-Pinch = zoomen,
 * kurzes Tippen auf die Oberfläche = Markierung setzen. Tastatur (Canvas fokussiert):
 * Pfeiltasten drehen, +/− zoomen, 0 = Ansicht zurücksetzen.
 * Gerendert wird nur bei Änderungen (kein Dauer-Loop) – schont Akku und respektiert reduzierte Bewegung.
 */
import { useEffect, useRef } from "react";
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import type { FootPoint } from "@/db/schema";
import { displayPos, type Side } from "@/lib/foot3d";
import { buildFoot } from "./build-foot";

export type ViewPreset = "default" | "top" | "sole" | "medial" | "lateral";

export interface Foot3dViewerProps {
  side: Side;
  /** alle Markierungen (beider Seiten) – Index = Nummer in der Liste */
  points: FootPoint[];
  readOnly?: boolean;
  selected?: number | null;
  onPick?: (pos: [number, number, number]) => void;
  onSelect?: (index: number | null) => void;
  onUnavailable?: (reason: string) => void;
  /** wechselt bei jedem Klick auf „Ansicht zurücksetzen“/Voreinstellung */
  view?: { preset: ViewPreset; n: number };
  label?: string;
}

type Orbit = { theta: number; phi: number; radius: number };

const TARGET = new Vector3(0, 0.22, -0.02);
/** Ansichten für den rechten Fuß (theta: 0 = von vorn, negativ = von medial); links gespiegelt */
const PRESETS: Record<ViewPreset, Orbit> = {
  default: { theta: -0.75, phi: 0.95, radius: 3.4 },
  top: { theta: Math.PI, phi: 0.12, radius: 3.2 },
  sole: { theta: 0, phi: Math.PI - 0.12, radius: 3.2 },
  medial: { theta: -Math.PI / 2, phi: Math.PI / 2 - 0.15, radius: 3.2 },
  lateral: { theta: Math.PI / 2, phi: Math.PI / 2 - 0.15, radius: 3.2 },
};
const PHI_MIN = 0.05;
const PHI_MAX = Math.PI - 0.05;
const R_MIN = 1.5;
const R_MAX = 7;
const TAP_SLOP_PX = 6;

function cssColor(name: string, fallback: string): Color {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  try {
    return new Color(v || fallback);
  } catch {
    return new Color(fallback);
  }
}

export default function Foot3dViewer({ side, points, readOnly = false, selected = null, onPick, onSelect, onUnavailable, view, label }: Foot3dViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Laufzeit-Objekte, die zwischen den Effekten geteilt werden
  const api = useRef<{
    setMarkers: (pts: FootPoint[], side: Side, selected: number | null) => void;
    setSide: (side: Side) => void;
    applyView: (p: ViewPreset) => void;
  } | null>(null);
  // Callbacks stabil halten (Effekt für die Szene läuft nur einmal)
  const cb = useRef({ onPick, onSelect, onUnavailable, readOnly });
  useEffect(() => {
    cb.current = { onPick, onSelect, onUnavailable, readOnly };
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    } catch {
      cb.current.onUnavailable?.("WebGL ist auf diesem Gerät nicht verfügbar.");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const canvas = renderer.domElement;
    canvas.style.touchAction = "none";
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", label ?? "3D-Fußmodell. Pfeiltasten drehen, Plus/Minus zoomen, 0 setzt die Ansicht zurück. Markierungen in der Liste darunter.");
    canvas.className = "rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring";
    host.appendChild(canvas);

    const scene = new Scene();
    const camera = new PerspectiveCamera(35, 1, 0.05, 50);
    const hemi = new HemisphereLight(0xffffff, 0x8a9a98, 2.2);
    const sun = new DirectionalLight(0xffffff, 1.4);
    sun.position.set(-1.5, 3, 2.5);
    const fill = new DirectionalLight(0xffffff, 0.5);
    fill.position.set(2, -1.5, -2);
    scene.add(hemi, sun, fill);

    const skin = new MeshLambertMaterial({ color: 0xf2d9c8 });
    const nail = new MeshLambertMaterial({ color: 0xfff6f0 });
    const markerMat = new MeshBasicMaterial({ color: 0x0b7f73 });
    const markerSelMat = new MeshBasicMaterial({ color: 0xf2715a });
    const markerGeo = new SphereGeometry(0.038, 18, 12);
    const applyTheme = () => {
      skin.color.copy(cssColor("--foot-skin", "#f2d9c8"));
      nail.color.copy(cssColor("--foot-nail", "#fff6f0"));
      markerMat.color.copy(cssColor("--primary", "#0b7f73"));
      markerSelMat.color.copy(cssColor("--accent", "#f2715a"));
      hemi.groundColor.copy(cssColor("--border-strong", "#a9c2bf"));
    };
    applyTheme();

    const foot = buildFoot({ skin, nail });
    scene.add(foot.group);
    const markerGroup = foot.group; // Marker in Modellkoordinaten → gleiche Gruppe (inkl. Spiegelung)
    let markers: { mesh: Mesh; index: number }[] = [];

    let currentSide: Side = "right";
    const presetFor = (p: ViewPreset): Orbit => ({ ...PRESETS[p], theta: currentSide === "left" ? -PRESETS[p].theta : PRESETS[p].theta });
    let orbit: Orbit = presetFor("default");
    let frame = 0;
    const render = () => {
      frame = 0;
      const sp = Math.sin(orbit.phi);
      camera.position.set(TARGET.x + orbit.radius * sp * Math.sin(orbit.theta), TARGET.y + orbit.radius * Math.cos(orbit.phi), TARGET.z + orbit.radius * sp * Math.cos(orbit.theta));
      camera.lookAt(TARGET);
      renderer.render(scene, camera);
    };
    const invalidate = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };

    let tween = 0;
    const applyView = (preset: ViewPreset) => {
      const to = presetFor(preset);
      cancelAnimationFrame(tween);
      if (reducedMotion) {
        orbit = { ...to };
        invalidate();
        return;
      }
      const from = { ...orbit };
      // kürzester Weg für den Azimut
      let dTheta = (to.theta - from.theta) % (Math.PI * 2);
      if (dTheta > Math.PI) dTheta -= Math.PI * 2;
      if (dTheta < -Math.PI) dTheta += Math.PI * 2;
      const t0 = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / 320);
        const e = 1 - (1 - k) ** 3;
        orbit = { theta: from.theta + dTheta * e, phi: from.phi + (to.phi - from.phi) * e, radius: from.radius + (to.radius - from.radius) * e };
        render();
        if (k < 1) tween = requestAnimationFrame(step);
      };
      tween = requestAnimationFrame(step);
    };

    const setSide = (s: Side) => {
      if (s === currentSide) return;
      currentSide = s;
      foot.group.scale.x = s === "left" ? -1 : 1;
      orbit = { ...orbit, theta: -orbit.theta }; // gleiche anatomische Ansicht behalten
      invalidate();
    };
    const setMarkers = (pts: FootPoint[], s: Side, sel: number | null) => {
      for (const m of markers) markerGroup.remove(m.mesh);
      markers = [];
      pts.forEach((p, index) => {
        if (p.side !== s) return;
        const pos = displayPos(p);
        if (!pos) return;
        const mesh = new Mesh(markerGeo, index === sel ? markerSelMat : markerMat);
        mesh.position.set(pos[0], pos[1], pos[2]);
        if (index === sel) mesh.scale.setScalar(1.45);
        markerGroup.add(mesh);
        markers.push({ mesh, index });
      });
      invalidate();
    };
    api.current = { setMarkers, setSide, applyView };

    // ── Größe ──
    const resize = () => {
      const w = host.clientWidth || 300;
      const h = host.clientHeight || 300;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      invalidate();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // ── Theme-Wechsel (Hell/Dunkel-Umschalter setzt data-theme) ──
    const mo = new MutationObserver(() => {
      applyTheme();
      invalidate();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onScheme = () => {
      applyTheme();
      invalidate();
    };
    mq?.addEventListener?.("change", onScheme);

    // ── Zeiger: drehen, zoomen, tippen ──
    const pointers = new Map<number, { x: number; y: number }>();
    let down: { x: number; y: number; moved: boolean; t: number } | null = null;
    let pinch = 0;
    const raycaster = new Raycaster();
    const ndc = new Vector2();

    const pick = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hitMarker = raycaster.intersectObjects(markers.map((m) => m.mesh), false)[0];
      const hitFoot = raycaster.intersectObjects(foot.pickables, false)[0];
      if (hitMarker && (!hitFoot || hitMarker.distance <= hitFoot.distance + 0.02)) {
        const m = markers.find((x) => x.mesh === hitMarker.object);
        if (m) cb.current.onSelect?.(m.index);
        return;
      }
      if (!hitFoot) {
        cb.current.onSelect?.(null);
        return;
      }
      if (cb.current.readOnly) return;
      const local = foot.group.worldToLocal(hitFoot.point.clone());
      cb.current.onPick?.([local.x, local.y, local.z]);
    };

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) down = { x: e.clientX, y: e.clientY, moved: false, t: performance.now() };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
        if (down) down.moved = true; // zwei Finger = nie eine Markierung
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      pointers.set(e.pointerId, cur);
      if (pointers.size === 1) {
        if (down && Math.hypot(cur.x - down.x, cur.y - down.y) > TAP_SLOP_PX) down.moved = true;
        if (!down?.moved) return;
        cancelAnimationFrame(tween);
        orbit.theta -= (cur.x - prev.x) * 0.009;
        orbit.phi = Math.min(PHI_MAX, Math.max(PHI_MIN, orbit.phi - (cur.y - prev.y) * 0.009));
        invalidate();
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0 && d > 0) {
          orbit.radius = Math.min(R_MAX, Math.max(R_MIN, orbit.radius * (pinch / d)));
          invalidate();
        }
        pinch = d;
      }
    };
    const onUp = (e: PointerEvent) => {
      const wasTap = pointers.size === 1 && down && !down.moved && performance.now() - down.t < 700;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (wasTap && e.type === "pointerup") pick(e.clientX, e.clientY);
      if (pointers.size === 0) down = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelAnimationFrame(tween);
      orbit.radius = Math.min(R_MAX, Math.max(R_MIN, orbit.radius * Math.exp(e.deltaY * 0.0012)));
      invalidate();
    };
    const onKey = (e: KeyboardEvent) => {
      const step = 0.2;
      let handled = true;
      if (e.key === "ArrowLeft") orbit.theta -= step;
      else if (e.key === "ArrowRight") orbit.theta += step;
      else if (e.key === "ArrowUp") orbit.phi = Math.max(PHI_MIN, orbit.phi - step);
      else if (e.key === "ArrowDown") orbit.phi = Math.min(PHI_MAX, orbit.phi + step);
      else if (e.key === "+" || e.key === "=") orbit.radius = Math.max(R_MIN, orbit.radius * 0.88);
      else if (e.key === "-" || e.key === "_") orbit.radius = Math.min(R_MAX, orbit.radius / 0.88);
      else if (e.key === "0" || e.key === "Home") applyView("default");
      else handled = false;
      if (handled) {
        e.preventDefault();
        invalidate();
      }
    };
    const onLost = (e: Event) => {
      e.preventDefault();
      cb.current.onUnavailable?.("Die 3D-Darstellung wurde vom Browser beendet.");
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onKey);
    canvas.addEventListener("webglcontextlost", onLost);

    return () => {
      api.current = null;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(tween);
      ro.disconnect();
      mo.disconnect();
      mq?.removeEventListener?.("change", onScheme);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("keydown", onKey);
      canvas.removeEventListener("webglcontextlost", onLost);
      // WebGL-Ressourcen freigeben (iPad Safari hat ein knappes Kontext-Limit)
      foot.dispose();
      markerGeo.dispose();
      for (const m of [skin, nail, markerMat, markerSelMat]) m.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
    // label nur beim Aufbau relevant
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api.current?.setSide(side);
    api.current?.setMarkers(points, side, selected);
  }, [side, points, selected]);

  useEffect(() => {
    if (view) api.current?.applyView(view.preset);
  }, [view]);

  return <div ref={hostRef} className="relative h-80 w-full touch-none select-none sm:h-96" />;
}
