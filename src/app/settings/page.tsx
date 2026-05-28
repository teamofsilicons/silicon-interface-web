"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { SignOut } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { authStore } from "@/lib/auth";

import { Button } from "@/components/ui/button";
import { ProfileEditor } from "@/components/profile/profile-editor";

export default function SettingsPage() {
  const router = useRouter();

  const logout = () => {
    authStore.clear();
    toast.success("logged out");
    router.replace("/auth/login");
  };

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">profile</h1>
        <p className="text-sm text-muted-foreground">Your name, photo, tagline, and timezone.</p>
      </header>

      <ProfileEditor />

      <div className="border-t pt-5">
        <Button variant="outline" onClick={logout} className="w-full sm:w-auto">
          <SignOut /> Log out
        </Button>
      </div>
    </div>
  );
}
