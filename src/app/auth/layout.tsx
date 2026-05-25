import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-bold tracking-tight">
            silicon-chat
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link href="/auth/login" className="hover:text-foreground">
              log in
            </Link>
            <Link href="/auth/register" className="hover:text-foreground">
              register
            </Link>
          </nav>
        </div>
      </header>
      <section className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-md">{children}</div>
      </section>
    </main>
  );
}
