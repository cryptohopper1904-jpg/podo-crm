/**
 * Plattform-Konsole (/plattform/**): dieselbe App-Hülle wie die Praxis-App, aber als eigene Route-Gruppe OHNE
 * (app)/loading.tsx. So liefert notFound() hier eine echte 404 (kein gestreamtes 200 hinter einer Suspense-Grenze).
 */
export { default, metadata } from "../(app)/layout";
