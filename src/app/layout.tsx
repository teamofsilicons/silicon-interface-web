import type { Metadata } from "next";
import { JetBrains_Mono, TikTok_Sans } from "next/font/google";
import { Toaster } from "sonner";

import "./globals.css";

// Two faces for a more dynamic feel: TikTok Sans is the workhorse (body,
// labels, chat, UI chrome) and JetBrains Mono is reserved for emphasis —
// the brand wordmark, KPI numbers, monospace IDs, code, and the .label-mono
// treatment. Tracking is tightened app-wide in globals.css.
const tiktokSans = TikTok_Sans({ variable: "--font-tiktok-sans", subsets: ["latin"] });
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Silicon Interface",
  description: "Where Carbons and Silicons talk, in one thread.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${tiktokSans.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      {/* h-full + flex column lets the chat layout (which uses h-screen
          overflow-hidden) clamp itself to viewport; min-h-full is kept on the
          other auth/landing pages by virtue of their own min-h-screen flex
          containers, which still render correctly inside an h-full body. */}
      <body className="flex h-full flex-col bg-background text-foreground">
        {children}
        {/* Sonner — brand-themed. richColors would override our palette, so
            we drop it and supply colored swatches via toastOptions classes.
            Sharp corners, hairline border, beige canvas, ink text — matches
            cards/dialogs everywhere else. */}
        <Toaster
          position="top-right"
          closeButton
          theme="light"
          duration={4500}
          gap={8}
          toastOptions={{
            unstyled: false,
            classNames: {
              toast:
                "!rounded-none !border !border-[var(--border)] !bg-[var(--card)] !text-[var(--foreground)] !shadow-none !font-sans",
              title: "!text-sm !font-medium !tracking-tight",
              description: "!text-xs !text-[var(--muted-foreground)]",
              actionButton:
                "!rounded-none !bg-[var(--primary)] !text-[var(--primary-foreground)] !text-xs",
              cancelButton:
                "!rounded-none !bg-transparent !text-[var(--muted-foreground)] !text-xs",
              // Visual treatment is in globals.css under
              // `[data-sonner-toast] [data-close-button]` — we strip the
              // chip-like default and pin it right-center as a plain ×.
              closeButton: "",
              success: "!border-l-2 !border-l-[var(--success)]",
              error: "!border-l-2 !border-l-[var(--destructive)]",
              warning: "!border-l-2 !border-l-[var(--warning)]",
              info: "!border-l-2 !border-l-[var(--muted-foreground)]",
            },
          }}
        />
      </body>
    </html>
  );
}
