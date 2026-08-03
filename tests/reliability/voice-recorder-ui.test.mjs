import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("a paused voice recording exposes a playable encoded snapshot", async () => {
  const session = await source("src/lib/voice-recording-session.ts");
  const recorder = await source("src/components/chat/voice-recorder.tsx");

  assert.match(session, /previewBlob\(\): Blob \| null/);
  assert.match(session, /this\.snapshot\.phase !== "paused"/);
  assert.match(session, /this\.refreshPreviewUrl\(\)/);
  assert.match(recorder, /session\.phase === "paused" \? \(/);
  assert.match(recorder, /<SiliconAudio[\s\S]*url=\{previewUrl\}/);
  assert.match(recorder, /<SiliconAudio[\s\S]*peaks=\{waveform\}/);
});

test("voice transcription state is visible and only direct Silicon delivery waits", async () => {
  const composer = await source("src/components/chat/composer.tsx");
  const mediaSend = await source("src/lib/media-send.ts");
  const room = await source("src/components/chat/room-view.tsx");
  const bubble = await source("src/components/chat/message-bubble.tsx");

  assert.match(composer, /transcription_status: "pending"/);
  assert.match(composer, /transcribe: voiceTranscriptionDeliveryGate/);
  assert.match(composer, /completionMeta,\s*\/\/ Direct Carbon/);
  assert.match(
    room,
    /voiceTranscriptionDeliveryGate=\{[\s\S]*room\.kind === "direct" && peer\?\.kind === "silicon"/,
  );
  assert.match(mediaSend, /const transcript = spec\.transcribe/);
  assert.match(bubble, /Transcription in progress…/);
  assert.match(bubble, /Will send to Silicon once done\./);
});

test("voice sends have one durable network owner and one recovery surface", async () => {
  const composer = await source("src/components/chat/composer.tsx");
  const bubble = await source("src/components/chat/message-bubble.tsx");
  const page = await source("src/app/chat/page.tsx");

  const uploadVoice = composer.slice(
    composer.indexOf("const uploadVoice = async"),
    composer.indexOf("const onVoiceSubmit", composer.indexOf("const uploadVoice = async")),
  );
  assert.match(uploadVoice, /stageMediaSendIntent/);
  assert.match(uploadVoice, /wakeOutboxRecovery\(outboxOwner, clientId\)/);
  assert.doesNotMatch(uploadVoice, /prepareMediaOutboxPayload/);
  assert.doesNotMatch(uploadVoice, /api\.sendEvent/);
  assert.match(composer, /A matching outbox row already renders in the timeline/);
  assert.match(bubble, /function DurableVoiceAttachment/);
  assert.match(bubble, /readMediaUpload\(`carbon:\$\{owner\}`, clientId\)/);
  assert.match(
    page,
    /const accepted = decorateDirectAcceptedTimelineEvent\([\s\S]*?persistEventFrames\([\s\S]*?event: accepted/,
  );
});

test("failed local messages never expose a server unsend action", async () => {
  const room = await source("src/components/chat/room-view.tsx");
  const failedGuard = room.indexOf('if (local._status === "failed" || local._failure) return false;');
  const pendingGrant = room.indexOf("if (isHeldOrPending) return true;", failedGuard);

  assert.ok(failedGuard >= 0);
  assert.ok(pendingGrant > failedGuard);
});

test("failed voice menu offers retry and trash-backed discard without unsend", async () => {
  const bubble = await source("src/components/chat/message-bubble.tsx");
  assert.match(bubble, /<ArrowClockwise className="mr-2 h-3\.5 w-3\.5" \/>[\s\S]*retry/);
  assert.match(bubble, /action === "discard_local"[\s\S]*<Trash/);
  assert.match(bubble, /onRetry=\{status === "failed" \? onRetry : undefined\}/);
});

test("voice metadata stays outside the voice bubble and saved playback is compact", async () => {
  const bubble = await source("src/components/chat/message-bubble.tsx");
  const composer = await source("src/components/chat/composer.tsx");
  assert.doesNotMatch(bubble, /event\.type === "m\.voice" && "pb-6"/);
  assert.doesNotMatch(bubble, /event\.type === "m\.voice" && "-mt-5 px-3"/);
  assert.match(composer, /peaks=\{peaks\}/);
  assert.match(composer, /className="w-full max-w-\[22rem\]"/);
});

test("voice playback displays total duration without a current-time label", async () => {
  const audio = await source("src/components/chat/silicon-audio.tsx");
  assert.match(audio, /<span className="shrink-0 label-mono text-\[10px\] opacity-60">\{formatTime\(dur\)\}<\/span>/);
  assert.doesNotMatch(audio, /formatTime\(currentMs\)\}\/{formatTime\(dur\)/);
});

test("transient media storage retries do not raise a global saving outage", async () => {
  const page = await source("src/app/chat/page.tsx");
  assert.match(
    page,
    /storageIssue\.severity === "blocked" \|\| storageIssue\.area === "timeline"/,
  );
  assert.match(page, /if \(room\.observed\) return \{ allowed: false, preview: false, sound: false \}/);
});

test("audio waveform clips inside its reserved grid track", async () => {
  const audio = await source("src/components/chat/silicon-audio.tsx");
  const recorder = await source("src/components/chat/voice-recorder.tsx");

  assert.match(audio, /grid-cols-\[auto_minmax\(0,1fr\)_auto_auto_auto\]/);
  assert.match(audio, /gap-px overflow-hidden/);
  assert.match(audio, /Math\.floor\(\(element\.clientWidth \+ 1\) \/ 3\)/);
  assert.match(audio, /"w-0\.5 shrink-0"/);
  assert.match(audio, /resampleWaveform\(samples, barCount\)/);
  assert.match(recorder, /<VoiceWaveform[\s\S]*samples=\{waveform\}/);
  assert.doesNotMatch(recorder, /wavesContainerRef/);
});
