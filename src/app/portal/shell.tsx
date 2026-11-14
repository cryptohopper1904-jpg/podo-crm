import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";

export function PortalShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 py-6 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
      <header className="flex items-center justify-between">
        <Logo />
        <ThemeToggle />
      </header>
      {children}
    </div>
  );
}
