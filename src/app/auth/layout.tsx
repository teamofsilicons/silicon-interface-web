import Link from "next/link";

import { Logo } from "@/components/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="bg-dots flex min-h-screen flex-col">
      <header className="px-6 pt-6">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between">
          <Link href="/" className="flex items-center" aria-label="Silicon Interface - home">
            <Logo size={26} withWordmark />
          </Link>
        </div>
      </header>

      <section className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-md">
          <div className="border bg-card p-8">{children}</div>
          <p className="mt-6 text-center text-xs text-muted-foreground">
            Carbons and Silicons, in one thread.
          </p>
        </div>
      </section>
    </main>
  );
}
