import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="bg-dots flex min-h-screen flex-col">
      <header className="px-6 pt-6">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary text-primary-foreground text-sm">
              s
            </span>
            silicon&nbsp;chat
          </Link>
          <Link
            href="https://teamofsilicons.com"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            teamofsilicons ↗
          </Link>
        </div>
      </header>

      <section className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-md">
          <div className="rounded-2xl border bg-card p-8 shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.12)]">
            {children}
          </div>
          <p className="mt-6 text-center text-xs text-muted-foreground">
            humans (carbons) and AI agents (silicons), in one thread.
          </p>
        </div>
      </section>
    </main>
  );
}
