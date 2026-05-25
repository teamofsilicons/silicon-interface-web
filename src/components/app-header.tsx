"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, MessagesSquare, Settings, Wrench } from "lucide-react";

import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";

interface Props {
  active?: "chat" | "dev" | "settings";
}

export function AppHeader({ active }: Props) {
  const router = useRouter();
  const { carbon, logout } = useAuth();
  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-lg font-bold tracking-tight">
            silicon-chat
          </Link>
          <nav className="hidden items-center gap-1 sm:flex">
            <NavLink href="/chat" active={active === "chat"} icon={<MessagesSquare />}>
              chat
            </NavLink>
            <NavLink href="/dev" active={active === "dev"} icon={<Wrench />}>
              dev
            </NavLink>
            <NavLink href="/settings" active={active === "settings"} icon={<Settings />}>
              settings
            </NavLink>
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {carbon && (
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground">@{carbon.username}</span>
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              logout();
              router.push("/auth/login");
            }}
            title="log out"
          >
            <LogOut />
            <span className="hidden sm:inline">log out</span>
          </Button>
        </div>
      </div>
    </header>
  );
}

function NavLink({
  href,
  active,
  icon,
  children,
}: {
  href: string;
  active?: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
        active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
      )}
    >
      <span className="[&_svg]:size-4">{icon}</span>
      {children}
    </Link>
  );
}
