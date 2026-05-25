"use client";

import * as React from "react";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { authStore, useAuth } from "@/lib/auth";
import type { TakeBackPolicy } from "@/lib/types";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SettingsPage() {
  const { carbon } = useAuth();
  const [policy, setPolicy] = React.useState<TakeBackPolicy | null>(null);
  const [siliconKey, setSiliconKey] = React.useState(authStore.getSiliconKey() ?? "");

  React.useEffect(() => {
    api
      .takeBackPolicy()
      .then(setPolicy)
      .catch((e) => toast.error(e instanceof ApiError ? e.message : String(e)));
  }, []);

  const savePolicy = async () => {
    if (!policy) return;
    try {
      const r = await api.setTakeBackPolicy(policy);
      setPolicy(r);
      toast.success("policy updated");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">settings</h1>
        <p className="text-sm text-muted-foreground">
          Your profile, take-back policy, and silicon key (for testing as a silicon).
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {carbon ? (
            <>
              <Row label="username" value={`@${carbon.username}`} />
              <Row label="email" value={carbon.email} />
              <Row label="phone" value={carbon.phone} />
              <Row label="carbon_id" value={carbon.carbon_id} mono />
              <Row label="email verified" value={carbon.email_verified_at ?? "no"} />
              <Row label="phone verified" value={carbon.phone_verified_at ?? "no"} />
            </>
          ) : (
            <p className="text-muted-foreground">not signed in as a carbon.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">take-back policy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {policy ? (
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label>threshold (msgs)</Label>
                  <Input
                    type="number"
                    value={policy.unread_threshold_msgs}
                    onChange={(e) =>
                      setPolicy({ ...policy, unread_threshold_msgs: Number(e.target.value) })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label>duration (secs)</Label>
                  <Input
                    type="number"
                    value={policy.unread_duration_secs}
                    onChange={(e) =>
                      setPolicy({ ...policy, unread_duration_secs: Number(e.target.value) })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label>enabled</Label>
                  <select
                    className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
                    value={String(policy.enabled)}
                    onChange={(e) =>
                      setPolicy({ ...policy, enabled: e.target.value === "true" })
                    }
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                </div>
              </div>
              <Button onClick={savePolicy}>save policy</Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">loading…</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">silicon key (test as silicon)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Paste a silicon API key (X-Silicon-Key) to make every subsequent request
            authenticate as that silicon instead of your carbon. Clear to revert.
          </p>
          <Input
            type="password"
            value={siliconKey}
            onChange={(e) => setSiliconKey(e.target.value)}
            placeholder="scs_live_..."
          />
          <div className="flex gap-2">
            <Button
              onClick={() => {
                authStore.setSiliconKey(siliconKey || null);
                toast.success(siliconKey ? "silicon key saved" : "cleared");
              }}
            >
              save
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setSiliconKey("");
                authStore.setSiliconKey(null);
              }}
            >
              clear
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs" : ""}>{value ?? "—"}</span>
    </div>
  );
}
