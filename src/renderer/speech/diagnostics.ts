import type { SpeechInputPreferences } from "../../utils/speech-input-settings";

type VoiceDiagnosticEvent =
  | "enter"
  | "active"
  | "input-mute"
  | "capture-start"
  | "capture-ready"
  | "capture-stop"
  | "input-audio"
  | "input-speech"
  | "recognition-start"
  | "recognition-complete"
  | "exit"
  | "interrupt"
  | "reply"
  | "synthesis-start"
  | "first-audio"
  | "synthesis-complete"
  | "output-complete"
  | "error"
  | "playback-start"
  | "playback-ready"
  | "playback-state"
  | "playback-stop"
  | "playback-chunk";

interface VoiceDiagnosticMetadata {
  preferences?: SpeechInputPreferences;
  provider?: string;
  state?: string;
  phase?: string;
  status?: string;
  characters?: number;
  phrases?: number;
  chunks?: number;
  samples?: number;
  peak?: number;
  elapsedMillis?: number;
  queuedSeconds?: number;
}

// Window-local logging infrastructure, not transcript/application state. Bounded,
// metadata only: never accept speech text, credentials, paths, IDs or raw errors.
const events: {
  timestamp: string;
  event: VoiceDiagnosticEvent;
  metadata: VoiceDiagnosticMetadata;
}[] = [];

export function recordVoiceDiagnostic(
  event: VoiceDiagnosticEvent,
  metadata: VoiceDiagnosticMetadata = {},
): void {
  const entry = { timestamp: new Date().toISOString(), event, metadata };
  events.push(entry);
  if (events.length > 100) events.shift();
  console.info(`[cake.voice] ${JSON.stringify(entry)}`);
}

export function voiceDiagnosticReport(): string {
  return JSON.stringify({ version: 1, events }, null, 2);
}
