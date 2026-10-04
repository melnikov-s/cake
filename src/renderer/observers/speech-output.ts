import type { Runtime } from "../runtime";
import type { SpeechSettingsStore } from "../stores/SpeechSettingsStore";

export const observeSpeechOutput = (runtime: Runtime, store: SpeechSettingsStore) =>
  runtime.observe(
    (client) => client.speechOutput.observeSettings(),
    (settings) => store.applySettings(settings),
    {
      reportFailure: (error) => {
        store.error = error instanceof Error ? error.message : "Speech settings unavailable";
      },
    },
  );
