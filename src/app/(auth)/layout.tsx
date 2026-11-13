import { ThemeToggle } from "@/components/theme-toggle";
import { Logo } from "@/components/logo";
import type { Metadata } from "next";
import { appLayoutMetadata } from "@/lib/pwa/app-meta";
import { PwaClient } from "@/components/pwa/pwa-client";

/** Login ist meist die Seite, von der aus die App auf den Home-Bildschirm gelegt wird → iOS-Startbilder hier mitgeben */
export const metadata: Metadata = appLayoutMetadata();

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-[max(1rem,env(safe-area-inset-left))] py-[max(2.5rem,env(safe-area-inset-top))]">
      <div className="absolute top-[max(1rem,env(safe-area-inset-top))] right-[max(1rem,env(safe-area-inset-right))]">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-6 sm:p-8">{children}</div>
        <p className="mt-6 text-center text-xs text-muted">
          Gesundheitsdaten werden verschlüsselt übertragen; Fotos und Dokumente werden zusätzlich verschlüsselt gespeichert.
        </p>
      </div>
      <PwaClient />
    </main>
  );
}
