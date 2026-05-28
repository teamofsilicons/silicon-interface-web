"use client";

import * as React from "react";
import {
  ChatsCircle,
  Check,
  Envelope,
  GearSix,
  Phone,
  Sparkle,
  UsersThree,
} from "@phosphor-icons/react/dist/ssr";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Logo } from "@/components/logo";
import { OtpInput } from "@/components/auth/otp-input";

const COLORS: { name: string; varName: string; onInk?: boolean }[] = [
  { name: "background", varName: "--background" },
  { name: "foreground", varName: "--foreground" },
  { name: "primary", varName: "--primary", onInk: true },
  { name: "secondary", varName: "--secondary" },
  { name: "muted", varName: "--muted" },
  { name: "accent", varName: "--accent" },
  { name: "border", varName: "--border" },
  { name: "success", varName: "--success" },
  { name: "warning", varName: "--warning" },
  { name: "destructive", varName: "--destructive", onInk: true },
  { name: "terminal-bg", varName: "--terminal-bg", onInk: true },
  { name: "terminal-accent", varName: "--terminal-accent" },
];

export default function StyleGuidePage() {
  const [code, setCode] = React.useState("");
  return (
    <div className="space-y-10">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">style guide</h1>
        <p className="text-sm text-muted-foreground">
          The Silicon Interface design system — warm beige, ink, JetBrains Mono, sharp corners,
          flat surfaces. Everything is driven by the tokens in <code>globals.css</code>.
        </p>
      </header>

      <Section title="logo">
        <div className="flex items-center gap-8">
          <Logo size={56} />
          <Logo size={28} withWordmark />
        </div>
      </Section>

      <Section title="color tokens">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {COLORS.map((c) => (
            <div key={c.varName} className="border">
              <div
                className="flex h-16 items-end p-2 text-[10px]"
                style={{
                  background: `var(${c.varName})`,
                  color: c.onInk ? "var(--primary-foreground)" : "var(--foreground)",
                }}
              >
                {c.varName}
              </div>
              <div className="label-mono px-2 py-1">{c.name}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="type scale">
        <div className="space-y-2">
          <p className="text-3xl font-semibold tracking-tight">Display · 3xl semibold</p>
          <p className="text-2xl font-semibold tracking-tight">Heading · 2xl semibold</p>
          <p className="text-base">Body · base regular</p>
          <p className="text-sm text-muted-foreground">Muted · sm</p>
          <p className="label-mono">label · mono uppercase</p>
        </div>
      </Section>

      <Section title="buttons">
        <div className="flex flex-wrap items-center gap-2">
          <Button>default</Button>
          <Button variant="secondary">secondary</Button>
          <Button variant="outline">outline</Button>
          <Button variant="ghost">ghost</Button>
          <Button variant="destructive">destructive</Button>
          <Button variant="link">link</Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm">small</Button>
          <Button>default</Button>
          <Button size="lg">large</Button>
          <Button size="icon">
            <Sparkle />
          </Button>
        </div>
      </Section>

      <Section title="badges">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>default</Badge>
          <Badge variant="secondary">secondary</Badge>
          <Badge variant="outline">outline</Badge>
          <Badge variant="success">verified</Badge>
          <Badge variant="warning">warning</Badge>
          <Badge variant="destructive">error</Badge>
        </div>
      </Section>

      <Section title="inputs">
        <div className="max-w-sm space-y-4">
          <Input placeholder="text input" />
          <OtpInput value={code} onChange={setCode} />
        </div>
      </Section>

      <Section title="icons (phosphor)">
        <div className="flex flex-wrap items-center gap-4 [&_svg]:size-6">
          <ChatsCircle />
          <UsersThree />
          <GearSix />
          <Envelope />
          <Phone />
          <Sparkle />
          <Check />
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="label-mono">{title}</h2>
      {children}
    </section>
  );
}
