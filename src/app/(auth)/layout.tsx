import { ThemeToggle } from "@/components/theme-toggle";
import { Logo } from "@/components/logo";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-6 sm:p-8">{children}</div>
        <p className="mt-6 text-center text-xs text-muted">
          Gesundheitsdaten werden verschlüsselt übertragen und auf Servern in Deutschland gespeichert.
        </p>
      </div>
    </main>
  );
}
