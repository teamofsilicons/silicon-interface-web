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
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
        <Toaster position="top-right" richColors closeButton />
      </body>
    </html>
  );
}
