"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { UploadSimple } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { authStore } from "@/lib/auth";
import { generateAndStoreAvatar } from "@/lib/avatar";
import { suggestCarbonId } from "@/lib/email";

import { Logo } from "@/components/logo";
import { IdAvatar } from "@/components/profile/id-avatar";
import { Button } from "@/components/ui/button";

const FLOW_KEY = "silicon-interface:onboarding-flow";
const EMAIL_KEY = "silicon-interface:onboarding-email";
const CARBON_ID_RE = /^[a-z0-9_.-]{3,32}$/;
const TYPE_DELAY_MS = 28;

interface Screen {
  text: (ctx: { carbonId: string; name: string }) => string;
  pickCarbonId?: boolean;
  preview?: boolean;
  cta?: string;
}

const SCREENS: Screen[] = [
  {
    text: () =>
      "Welcome to Silicon Interface, you can chat with Silicon and Carbons here. Let me set things up for you…",
  },
  {
    text: () =>
      "Before we begin, some context:\nCarbon is… You; all the human elements in the play. And Silicon… well you will know once you talk to one. Let's get you started…",
  },
  {
    text: () =>
      "Choose a Carbon ID for yourself, keep in mind this can't be changed later.",
    pickCarbonId: true,
  },
  {
    text: ({ carbonId }) =>
      `cool meeting you ${carbonId}. Does this base profile look good, don't worry you can always update it with your latest picture in the profile section 😎.`,
    preview: true,
  },
  {
    text: () =>
      "Awesome man! You are all setup, enjoy Silicon Interface. Have some great conversations with Silicons and Carbons",
    cta: "Enter Silicon Interface",
  },
];

function nameFromCarbonId(cid: string): string {
  if (!cid) return "";
  const cleaned = cid.replace(/[^a-zA-Z]/g, "");
  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

export default function OnboardingPage() {
  return (
    <React.Suspense fallback={null}>
      <OnboardingInner />
    </React.Suspense>
  );
}

function OnboardingInner() {
  const router = useRouter();
  const [flowId, setFlowId] = React.useState<string | null>(null);
  const [emailHint, setEmailHint] = React.useState<string>("");
  const [step, setStep] = React.useState(0);
  const [carbonId, setCarbonId] = React.useState("");
  const [name, setName] = React.useState("");
  const [bio, setBio] = React.useState("");
  const [nameDirty, setNameDirty] = React.useState(false);
  // Step 4 — locally-staged profile photo (uploaded after finalize since
  // presign needs an auth session).
  const [photoFile, setPhotoFile] = React.useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = React.useState<string | null>(null);
  const photoInputRef = React.useRef<HTMLInputElement>(null);

  const [revealed, setRevealed] = React.useState("");
  const [typingDone, setTypingDone] = React.useState(false);
  const [finalizing, setFinalizing] = React.useState(false);
  const [avail, setAvail] = React.useState<{
    for: string; ok: boolean; reason: string;
  } | null>(null);

  // Pull flowId + the email hint once on mount. If flowId is missing, kick
  // back to register; if email is present, pre-seed carbon ID + name.
  React.useEffect(() => {
    const f = window.sessionStorage.getItem(FLOW_KEY);
    if (!f) {
      router.replace("/auth/register");
      return;
    }
    setFlowId(f);
    const e = window.sessionStorage.getItem(EMAIL_KEY) ?? "";
    setEmailHint(e);
    if (e) {
      const suggested = suggestCarbonId(e);
      setCarbonId(suggested);
    }
  }, [router]);

  const screen = SCREENS[step];
  const target = React.useMemo(
    () => screen.text({ carbonId, name }),
    [screen, carbonId, name],
  );

  React.useEffect(() => {
    setRevealed("");
    setTypingDone(false);
    let i = 0;
    const id = window.setInterval(() => {
      i++;
      setRevealed(target.slice(0, i));
      if (i >= target.length) {
        window.clearInterval(id);
        setTypingDone(true);
      }
    }, TYPE_DELAY_MS);
    return () => window.clearInterval(id);
  }, [target]);

  React.useEffect(() => {
    if (!nameDirty) setName(nameFromCarbonId(carbonId));
  }, [carbonId, nameDirty]);

  const cid = carbonId.trim().toLowerCase();
  const formatValid = CARBON_ID_RE.test(cid);
  React.useEffect(() => {
    if (!cid || !formatValid) return;
    const t = setTimeout(async () => {
      try {
        const r = await api.carbonIdAvailable(cid);
        setAvail({ for: cid, ok: r.valid && r.available, reason: r.reason });
      } catch {
        /* keep prior */
      }
    }, 280);
    return () => clearTimeout(t);
  }, [cid, formatValid]);

  const carbonIdReady = formatValid && avail?.for === cid && avail.ok;

  const skipTyping = () => {
    setRevealed(target);
    setTypingDone(true);
  };

  // Photo handlers
  const onPhotoPick = (f: File | null) => {
    if (!f || !f.type.startsWith("image/")) return;
    setPhotoFile(f);
    // Cheap inline preview using object URL.
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoPreview(URL.createObjectURL(f));
  };
  React.useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
    // Cleanup on unmount only; we already revoke when swapping above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const next = React.useCallback(async () => {
    if (step === 2 && !carbonIdReady) return;
    if (step === 3) {
      if (!flowId) return;
      setFinalizing(true);
      try {
        const session = await api.registerUsername(flowId, cid);
        authStore.setSession(session);
        // Apply name + bio in the background; failures are non-fatal.
        if (name && name !== session.carbon.name) {
          await api.patchMe({ name }).catch(() => undefined);
        }
        if (bio) {
          await api.patchMe({ tagline: bio }).catch(() => undefined);
        }
        // If the user uploaded a custom photo on the preview screen, push
        // it through the same presign + complete + patchMe flow used by
        // /settings. Otherwise mint the deterministic glyph.
        if (photoFile) {
          try {
            const r = await api.presignUpload({
              mime: photoFile.type || "image/png",
              size: photoFile.size,
              kind: "profile_icon",
              filename: photoFile.name,
            });
            if (!r.upload.dev_mode) {
              const form = new FormData();
              for (const [k, v] of Object.entries(r.upload.fields)) form.append(k, v);
              form.append("file", photoFile);
              const up = await fetch(r.upload.url, { method: r.upload.method || "POST", body: form });
              if (up.ok) await api.mediaComplete(r.media.media_id);
            }
            const key =
              (r.upload.fields as Record<string, string>).key || r.media.media_id;
            await api.patchMe({ profile_photo_key: key }).catch(() => undefined);
          } catch {
            // photo upload failure shouldn't block onboarding completion
          }
        } else {
          void generateAndStoreAvatar(session.carbon.carbon_id);
        }
        window.sessionStorage.removeItem(FLOW_KEY);
        window.sessionStorage.removeItem(EMAIL_KEY);
        setStep((s) => s + 1);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : String(e));
      } finally {
        setFinalizing(false);
      }
      return;
    }
    if (step === SCREENS.length - 1) {
      router.replace("/chat");
      return;
    }
    setStep((s) => s + 1);
  }, [step, carbonIdReady, flowId, cid, name, bio, photoFile, router]);

  // Pressing Enter advances when the screen is ready to advance.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (!typingDone) return;
      // For the Carbon-ID step, Enter is only meaningful when the field is
      // valid + available.
      if (step === 2 && !carbonIdReady) return;
      // Allow Enter inside textarea / multi-line surfaces to insert newlines.
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "TEXTAREA") return;
      e.preventDefault();
      void next();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [typingDone, step, carbonIdReady, next]);

  // Smooth, opacity-only entrance for the contextual widgets so they don't
  // pop in and shove the CTA down.
  const fadeIn = "animate-[onb-fade-in_0.45s_ease-out_both]";

  const progressPct = ((step + 1) / SCREENS.length) * 100;

  return (
    <div className="bg-dots relative flex min-h-screen flex-col">
      <header className="px-6 pt-6">
        <Logo size={26} withWordmark />
      </header>
      <section className="flex flex-1 flex-col items-center justify-center px-6 py-10">
        <div className="w-full max-w-lg space-y-7">
          <div
            onClick={skipTyping}
            className="min-h-[140px] cursor-text whitespace-pre-wrap text-lg leading-relaxed"
            title="click to skip"
          >
            {revealed}
            {!typingDone && (
              <span className="ml-0.5 inline-block h-5 w-[2px] animate-pulse bg-foreground align-middle" />
            )}
          </div>

          {/* Carbon ID picker */}
          {screen.pickCarbonId && typingDone && (
            <div key={`pick-${step}`} className={`space-y-2 ${fadeIn}`}>
              <div className="flex items-center border border-input bg-transparent transition-colors focus-within:border-ring">
                <span className="pl-3 text-2xl text-muted-foreground">@</span>
                <input
                  autoFocus
                  value={carbonId}
                  onChange={(e) => setCarbonId(e.target.value.toLowerCase())}
                  placeholder="your-carbon-id"
                  className="h-14 w-full min-w-0 bg-transparent px-2 text-2xl font-medium tracking-tight outline-none placeholder:text-muted-foreground"
                />
                <span className="px-3 label-mono text-[10px]">
                  {formatValid
                    ? avail?.for === cid
                      ? avail.ok
                        ? "available"
                        : (avail.reason || "taken")
                      : "checking…"
                    : carbonId
                      ? "3-32 chars: a-z 0-9 _ . -"
                      : ""}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Lowercase letters, digits, _ . - · 3 to 32 characters · permanent
                {emailHint ? ` · suggested from ${emailHint}` : ""}
              </p>
            </div>
          )}

          {/* Profile preview + optional photo upload (Carbon ID intentionally
              not shown here — they just picked it on the previous screen). */}
          {screen.preview && typingDone && (
            <div
              key={`preview-${step}`}
              className={`flex flex-col items-center gap-4 border bg-card p-6 ${fadeIn}`}
            >
              <div className="relative">
                {photoPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element -- local object URL
                  <img
                    src={photoPreview}
                    alt="your photo"
                    className="h-32 w-32 border object-cover"
                  />
                ) : (
                  <IdAvatar seed={carbonId || "?"} src={null} size={132} />
                )}
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => onPhotoPick(e.target.files?.[0] ?? null)}
                />
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  className="absolute -bottom-2 -right-2 inline-flex h-9 w-9 items-center justify-center border bg-foreground text-background transition-opacity hover:opacity-90"
                  title="upload a photo"
                  aria-label="upload a photo"
                >
                  <UploadSimple className="h-4 w-4" />
                </button>
              </div>
              <div className="w-full space-y-3">
                <div className="space-y-1">
                  <label className="label-mono text-[10px] text-muted-foreground">
                    name
                  </label>
                  <input
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setNameDirty(true);
                    }}
                    className="w-full border border-input bg-transparent px-3 py-2 text-base font-medium outline-none transition-colors focus:border-ring"
                    placeholder="Your name"
                  />
                </div>
                <div className="space-y-1">
                  <label className="label-mono text-[10px] text-muted-foreground">
                    bio
                  </label>
                  <input
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    maxLength={160}
                    placeholder="a line about you (optional)"
                    className="w-full border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-ring"
                  />
                </div>
              </div>
            </div>
          )}

          {/* CTA — chunkier vertical padding, with an (↵) hint so users know
              Enter advances too. */}
          {typingDone && (
            <div className={fadeIn} key={`cta-${step}`}>
              <Button
                onClick={() => void next()}
                disabled={
                  (step === 2 && !carbonIdReady) ||
                  finalizing ||
                  (step === 3 && !flowId)
                }
                className="h-14 w-full text-base"
              >
                {finalizing ? (
                  "setting up your account…"
                ) : (
                  <>
                    {screen.cta ?? "Continue"}
                    <span className="ml-2 label-mono text-[10px] text-white/80">
                      (↵)
                    </span>
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* Bottom progress bar — fills as we advance, 10px tall. */}
      <div className="absolute inset-x-0 bottom-0 h-[10px] bg-foreground/10">
        <div
          className="h-full bg-foreground transition-[width] duration-500 ease-out"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Keyframes for the contextual fade-in. Local to keep onboarding self-
          contained instead of polluting globals.css. */}
      <style jsx global>{`
        @keyframes onb-fade-in {
          from {
            opacity: 0;
            transform: translateY(6px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}
