import { Schema } from "effect";
import {
  STARTUP_TIMING_PREFIX,
  RendererStartupTiming,
  type RendererStartupPhase,
} from "../../contracts/desktop/startup-timing";

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(RendererStartupTiming));

/** Only the first desktop window's main-frame, bounded metadata is retained. */
export function makeRendererStartupReceiver(report: (timing: RendererStartupTiming) => void) {
  const seen = new Set<RendererStartupPhase>();
  return (message: string) => {
    if (message.length > 256 || !message.startsWith(STARTUP_TIMING_PREFIX)) return;
    const decoded = decode(message.slice(STARTUP_TIMING_PREFIX.length));
    if (decoded._tag === "None" || seen.has(decoded.value.phase)) return;
    seen.add(decoded.value.phase);
    // Deliberately project only the allowlisted fields, even if input had extras.
    report({
      phase: decoded.value.phase,
      rendererElapsedMs: decoded.value.rendererElapsedMs,
    });
  };
}
