"use client";

import * as React from "react";

import { vibrate } from "@/lib/sounds";

export type VoiceRecordingPhase = "idle" | "requesting" | "recording" | "stopping";

export interface VoiceRecordingSnapshot {
  phase: VoiceRecordingPhase;
  roomId: string | null;
  startedAt: number | null;
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
};

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

/**
 * One browser-tab-wide recorder. RoomView is intentionally keyed by room and
 * unmounts on navigation, so MediaRecorder cannot live in a chat component if
 * recording must continue while the user visits another chat.
 */
class VoiceRecordingSession {
  private snapshot: VoiceRecordingSnapshot = IDLE_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private chunks: BlobPart[] = [];
  private mime = "audio/webm";
  private startedAt = 0;
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
    this.setSnapshot({ phase: "requesting", roomId, startedAt: null });

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
      this.stopIntent = "cancel";

      recorder.ondataavailable = (event) => {
        if (event.data?.size) this.chunks.push(event.data);
      };
      recorder.onstop = () => this.handleStopped(recorder);
      recorder.onerror = () => this.handleRecorderError(new Error("Voice recorder failed"));

      this.startedAt = Date.now();
      recorder.start(200);
      this.startAnalyser(stream);
      this.setSnapshot({ phase: "recording", roomId, startedAt: this.startedAt });
      vibrate(8);
    } catch (error) {
      this.releaseMedia();
      this.resetState();
      throw error;
    }
  }

  /** Finalize once and deliver to the callbacks captured by the origin room. */
  async submit(): Promise<void> {
    if (this.snapshot.phase !== "recording") {
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
      onCancel?.();
    }
  }

  /** Current normalized microphone amplitude for the mounted waveform UI. */
  getLevel(): number {
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
      durationMs: Math.max(0, Date.now() - this.startedAt),
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

  private releaseMedia(): void {
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
    this.chunks = [];
    this.mime = "audio/webm";
    this.startedAt = 0;
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
    for (const listener of this.listeners) listener();
  }
}

type VoiceSessionGlobal = typeof globalThis & {
  __siliconVoiceRecordingSession?: VoiceRecordingSession;
};

const sessionGlobal = globalThis as VoiceSessionGlobal;
export const voiceRecordingSession =
  sessionGlobal.__siliconVoiceRecordingSession ?? new VoiceRecordingSession();
sessionGlobal.__siliconVoiceRecordingSession = voiceRecordingSession;

export function useVoiceRecordingSession(): VoiceRecordingSnapshot {
  return React.useSyncExternalStore(
    voiceRecordingSession.subscribe,
    voiceRecordingSession.getSnapshot,
    voiceRecordingSession.getServerSnapshot,
  );
}
