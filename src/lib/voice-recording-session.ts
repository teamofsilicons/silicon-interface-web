"use client";

import * as React from "react";

import { vibrate } from "@/lib/sounds";
import {
  hasActiveVoiceRecording as recordingActivityActive,
  setVoiceRecordingActive,
} from "@/lib/composer-activity";
import {
  appendLiveVoiceChunk,
  beginLiveVoiceDraft,
  clearLiveVoiceDraft,
} from "@/lib/voice-drafts";

export type VoiceRecordingPhase = "idle" | "requesting" | "recording" | "paused" | "stopping";

export interface VoiceRecordingSnapshot {
  phase: VoiceRecordingPhase;
  roomId: string | null;
  startedAt: number | null;
  pausedAt: number | null;
  pausedDurationMs: number;
}

export interface VoiceRecordingResult {
  blob: Blob;
  durationMs: number;
}

export interface VoiceRecordingHandlers {
  onSubmit: (result: VoiceRecordingResult) => void;
  onCancel: () => void;
}

const IDLE_SNAPSHOT: VoiceRecordingSnapshot = {
  phase: "idle",
  roomId: null,
  startedAt: null,
  pausedAt: null,
  pausedDurationMs: 0,
};

const EMPTY_WAVEFORM: readonly number[] = [];
// 512 samples at 20 Hz covers a waveform wider than the largest supported
// composer while keeping long recordings bounded in memory.
const MAX_WAVEFORM_SAMPLES = 512;

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const mime of [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
  ]) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "";
}

function abortError(): DOMException {
  return new DOMException("Voice recording was cancelled", "AbortError");
}

function recordingId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * One browser-tab-wide recorder. RoomView is intentionally keyed by room and
 * unmounts on navigation, so MediaRecorder cannot live in a chat component if
 * recording must continue while the user visits another chat.
 */
class VoiceRecordingSession {
  private snapshot: VoiceRecordingSnapshot = IDLE_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private waveform: readonly number[] = EMPTY_WAVEFORM;
  private readonly waveformListeners = new Set<() => void>();
  private previewUrl: string | null = null;
  private readonly previewListeners = new Set<() => void>();
  private waveformTimer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private chunks: BlobPart[] = [];
  private mime = "audio/webm";
  private startedAt = 0;
  private pausedAt = 0;
  private pausedDurationMs = 0;
  private clientId = "";
  private chunkSequence = 0;
  private stopIntent: "send" | "cancel" = "cancel";
  private stopPromise: Promise<VoiceRecordingResult | null> | null = null;
  private resolveStop: ((result: VoiceRecordingResult | null) => void) | null = null;
  private rejectStop: ((error: unknown) => void) | null = null;
  private handlers: VoiceRecordingHandlers | null = null;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): VoiceRecordingSnapshot => this.snapshot;
  readonly getServerSnapshot = (): VoiceRecordingSnapshot => IDLE_SNAPSHOT;
  readonly subscribeWaveform = (listener: () => void): (() => void) => {
    this.waveformListeners.add(listener);
    return () => this.waveformListeners.delete(listener);
  };
  readonly getWaveformSnapshot = (): readonly number[] => this.waveform;
  readonly getWaveformServerSnapshot = (): readonly number[] => EMPTY_WAVEFORM;
  readonly subscribePreview = (listener: () => void): (() => void) => {
    this.previewListeners.add(listener);
    return () => this.previewListeners.delete(listener);
  };
  readonly getPreviewSnapshot = (): string | null => this.previewUrl;
  readonly getPreviewServerSnapshot = (): string | null => null;

  /** A playable snapshot of every encoded slice received so far. */
  previewBlob(): Blob | null {
    if (this.snapshot.phase !== "paused" || this.chunks.length === 0) return null;
    return new Blob(this.chunks, { type: this.mime || "audio/webm" });
  }

  async start(roomId: string, handlers: VoiceRecordingHandlers): Promise<void> {
    if (!roomId) throw new Error("A room is required to record a voice note");
    if (this.snapshot.phase !== "idle") {
      throw new Error("A voice note is already being recorded");
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new Error("Voice recording is not supported in this browser");
    }

    const generation = ++this.generation;
    this.handlers = handlers;
    this.setWaveform(EMPTY_WAVEFORM);
    this.setSnapshot({
      phase: "requesting",
      roomId,
      startedAt: null,
      pausedAt: null,
      pausedDurationMs: 0,
    });

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (generation !== this.generation || this.snapshot.roomId !== roomId) {
        throw abortError();
      }
      this.resetState();
      throw error;
    }

    // The user may discard while the permission prompt is still open. A late
    // permission grant must not create an invisible recorder.
    const current = this.getSnapshot();
    if (
      generation !== this.generation ||
      current.phase !== "requesting" ||
      current.roomId !== roomId
    ) {
      stream.getTracks().forEach((track) => track.stop());
      throw abortError();
    }

    this.stream = stream;
    const requestedMime = pickMime();
    try {
      const recorder = requestedMime
        ? new MediaRecorder(stream, { mimeType: requestedMime })
        : new MediaRecorder(stream);
      this.recorder = recorder;
      this.mime = recorder.mimeType || requestedMime || "audio/webm";
      this.chunks = [];
      this.clientId = recordingId();
      this.chunkSequence = 0;
      this.pausedAt = 0;
      this.pausedDurationMs = 0;
      this.stopIntent = "cancel";

      recorder.ondataavailable = (event) => {
        if (!event.data?.size) return;
        this.chunks.push(event.data);
        if (this.snapshot.phase === "paused") this.refreshPreviewUrl();
        const sequence = this.chunkSequence++;
        void appendLiveVoiceChunk({
          roomId,
          clientId: this.clientId,
          sequence,
          startedAt: this.startedAt,
          durationMs: this.durationMs(),
          mime: this.mime,
          blob: event.data,
        });
      };
      recorder.onstop = () => this.handleStopped(recorder);
      recorder.onerror = () => this.handleRecorderError(new Error("Voice recorder failed"));

      this.startedAt = Date.now();
      await beginLiveVoiceDraft(roomId);
      recorder.start(200);
      this.startAnalyser(stream);
      this.startWaveformSampling();
      this.setSnapshot({
        phase: "recording",
        roomId,
        startedAt: this.startedAt,
        pausedAt: null,
        pausedDurationMs: 0,
      });
      vibrate(8);
    } catch (error) {
      this.releaseMedia();
      this.resetState();
      throw error;
    }
  }

  /** Finalize once and deliver to the callbacks captured by the origin room. */
  async submit(): Promise<void> {
    if (this.snapshot.phase !== "recording" && this.snapshot.phase !== "paused") {
      throw new Error("Voice recording is not ready to send");
    }
    const handlers = this.handlers;
    try {
      const result = await this.stop("send");
      if (!result || result.blob.size === 0) throw new Error("Voice recording was empty");
      handlers?.onSubmit(result);
    } catch (error) {
      handlers?.onCancel();
      throw error;
    }
  }

  async cancel(): Promise<void> {
    if (this.snapshot.phase === "idle") return;
    const onCancel = this.handlers?.onCancel;
    const roomId = this.snapshot.roomId;
    const clientId = this.clientId;

    if (this.snapshot.phase === "requesting") {
      // Invalidate the pending getUserMedia request. If it resolves later,
      // start() stops every returned track before rejecting with AbortError.
      this.generation += 1;
      this.resetState();
      onCancel?.();
      return;
    }

    try {
      if (this.snapshot.phase === "stopping") {
        await this.stopPromise;
        return;
      }
      await this.stop("cancel");
    } finally {
      if (roomId) void clearLiveVoiceDraft(roomId, clientId || undefined);
      onCancel?.();
    }
  }

  pause(): void {
    const recorder = this.recorder;
    if (this.snapshot.phase !== "recording" || !recorder || recorder.state !== "recording") return;
    recorder.requestData();
    recorder.pause();
    this.pausedAt = Date.now();
    if (this.waveformTimer) clearInterval(this.waveformTimer);
    this.waveformTimer = null;
    this.setSnapshot({
      ...this.snapshot,
      phase: "paused",
      pausedAt: this.pausedAt,
      pausedDurationMs: this.pausedDurationMs,
    });
    this.refreshPreviewUrl();
  }

  resume(): void {
    const recorder = this.recorder;
    if (this.snapshot.phase !== "paused" || !recorder || recorder.state !== "paused") return;
    const now = Date.now();
    if (this.pausedAt) this.pausedDurationMs += now - this.pausedAt;
    this.pausedAt = 0;
    this.clearPreviewUrl();
    recorder.resume();
    this.startWaveformSampling();
    this.setSnapshot({
      ...this.snapshot,
      phase: "recording",
      pausedAt: null,
      pausedDurationMs: this.pausedDurationMs,
    });
  }

  durationMs(now = Date.now()): number {
    if (!this.startedAt) return 0;
    const activePause = this.pausedAt ? Math.max(0, now - this.pausedAt) : 0;
    return Math.max(0, now - this.startedAt - this.pausedDurationMs - activePause);
  }

  /** Current normalized microphone amplitude. */
  private getLevel(): number {
    const analyser = this.analyser;
    if (!analyser) return 0;
    const samples = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(samples);
    let sumSquares = 0;
    for (const sample of samples) {
      const value = (sample - 128) / 128;
      sumSquares += value * value;
    }
    return Math.min(1, Math.sqrt(sumSquares / samples.length) * 4);
  }

  private stop(intent: "send" | "cancel"): Promise<VoiceRecordingResult | null> {
    if (this.stopPromise) return this.stopPromise;
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") {
      return Promise.reject(new Error("Voice recorder is not active"));
    }

    this.stopIntent = intent;
    this.setSnapshot({ ...this.snapshot, phase: "stopping" });
    const stopPromise = new Promise<VoiceRecordingResult | null>((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
    });
    this.stopPromise = stopPromise;

    try {
      recorder.stop();
    } catch (error) {
      this.handleRecorderError(error);
    }
    return stopPromise;
  }

  private handleStopped(recorder: MediaRecorder): void {
    if (recorder !== this.recorder) return;
    const intent = this.stopIntent;
    const result: VoiceRecordingResult = {
      blob: new Blob(this.chunks, { type: this.mime || "audio/webm" }),
      durationMs: this.durationMs(),
    };
    const resolve = this.resolveStop;
    this.releaseMedia();
    this.resetState();
    resolve?.(intent === "send" ? result : null);
  }

  private handleRecorderError(error: unknown): void {
    const stoppedByUser = this.stopPromise !== null;
    const reject = this.rejectStop;
    const onCancel = this.handlers?.onCancel;
    this.releaseMedia();
    this.resetState();
    reject?.(error);
    if (!stoppedByUser) onCancel?.();
  }

  private startAnalyser(stream: MediaStream): void {
    try {
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      this.audioContext = context;
      this.analyser = analyser;
    } catch {
      // Recording remains valid when visualization is unavailable.
      this.audioContext = null;
      this.analyser = null;
    }
  }

  private startWaveformSampling(): void {
    if (this.waveformTimer) clearInterval(this.waveformTimer);
    this.waveformTimer = setInterval(() => {
      const now = Date.now();
      const measured = this.getLevel();
      const idleFloor = 0.06 + 0.04 * Math.abs(Math.sin(now / 350));
      const amplitude = Math.max(idleFloor, measured);
      const retained = this.waveform.slice(-(MAX_WAVEFORM_SAMPLES - 1));
      this.setWaveform([...retained, amplitude]);
    }, 50);
  }

  private releaseMedia(): void {
    if (this.waveformTimer) clearInterval(this.waveformTimer);
    this.waveformTimer = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.audioContext?.close().catch(() => undefined);
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      this.recorder.onerror = null;
    }
    this.recorder = null;
    this.stream = null;
    this.audioContext = null;
    this.analyser = null;
    this.clearPreviewUrl();
    this.chunks = [];
    this.mime = "audio/webm";
    this.startedAt = 0;
    this.pausedAt = 0;
    this.pausedDurationMs = 0;
    this.clientId = "";
    this.chunkSequence = 0;
  }

  private resetState(): void {
    this.stopPromise = null;
    this.resolveStop = null;
    this.rejectStop = null;
    this.stopIntent = "cancel";
    this.handlers = null;
    this.setSnapshot(IDLE_SNAPSHOT);
  }

  private setSnapshot(snapshot: VoiceRecordingSnapshot): void {
    this.snapshot = snapshot;
    setVoiceRecordingActive(snapshot.phase !== "idle");
    for (const listener of this.listeners) listener();
  }

  private setWaveform(waveform: readonly number[]): void {
    this.waveform = waveform;
    for (const listener of this.waveformListeners) listener();
  }

  private refreshPreviewUrl(): void {
    const blob = this.previewBlob();
    if (!blob || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
    const next = URL.createObjectURL(blob);
    const previous = this.previewUrl;
    this.previewUrl = next;
    if (previous) URL.revokeObjectURL(previous);
    for (const listener of this.previewListeners) listener();
  }

  private clearPreviewUrl(): void {
    if (!this.previewUrl) return;
    URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = null;
    for (const listener of this.previewListeners) listener();
  }
}

type VoiceSessionGlobal = typeof globalThis & {
  __siliconVoiceRecordingSession?: VoiceRecordingSession;
};

const sessionGlobal = globalThis as VoiceSessionGlobal;
export const voiceRecordingSession =
  sessionGlobal.__siliconVoiceRecordingSession ?? new VoiceRecordingSession();
sessionGlobal.__siliconVoiceRecordingSession = voiceRecordingSession;

export function hasActiveVoiceRecording(): boolean {
  return recordingActivityActive();
}

export function useVoiceRecordingSession(): VoiceRecordingSnapshot {
  return React.useSyncExternalStore(
    voiceRecordingSession.subscribe,
    voiceRecordingSession.getSnapshot,
    voiceRecordingSession.getServerSnapshot,
  );
}

export function useVoiceRecordingWaveform(): readonly number[] {
  return React.useSyncExternalStore(
    voiceRecordingSession.subscribeWaveform,
    voiceRecordingSession.getWaveformSnapshot,
    voiceRecordingSession.getWaveformServerSnapshot,
  );
}

export function useVoiceRecordingPreviewUrl(): string | null {
  return React.useSyncExternalStore(
    voiceRecordingSession.subscribePreview,
    voiceRecordingSession.getPreviewSnapshot,
    voiceRecordingSession.getPreviewServerSnapshot,
  );
}
