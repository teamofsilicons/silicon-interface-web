let voiceRecordingActive = false;

export function setVoiceRecordingActive(active: boolean): void {
  voiceRecordingActive = active;
}

export function hasActiveVoiceRecording(): boolean {
  return voiceRecordingActive;
}
