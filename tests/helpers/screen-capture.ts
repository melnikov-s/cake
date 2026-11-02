import type { CapturePreferences } from "../../src/contracts/desktop/screen-capture-data";

export const captureRouting: CapturePreferences = {
  annotationColor: "yellow",
  appearance: {
    theme: "dark",
  },
  dictation: {
    enabled: false,
    deviceId: "",
    textProcessingMode: "raw",
    recognition: {
      thresholds: { start: 0.6, continuation: 0.4 },
      minimumSpeechMs: 200,
      prerollMs: 600,
      maximumUtteranceSeconds: 30,
    },
  },
};
