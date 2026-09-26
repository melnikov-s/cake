import { createStore, mount } from "r-state-tree";
import { DictationStore } from "../../src/renderer/stores/DictationStore";
import type { Client } from "../../src/renderer/client/Client";
import type { Microphone } from "../../src/renderer/dictation/microphone";
import type { DictationState } from "../../src/domain/dictation/dictation-data";

export const installedDictationState: DictationState = {
  supported: true,
  status: "installed",
  modelPath: "/fixture/model",
  managedModelPath: "/fixture/model",
  engineAvailable: true,
  downloadedBytes: 0,
  totalBytes: 0,
};
export function createDictationStore(
  client: Partial<Client["dictation"]> = {},
  microphone: Partial<Microphone> = {},
) {
  return mount(
    createStore(DictationStore, {
      client: {
        install: async () => {},
        setModelPath: async () => {},
        remove: async () => {},
        prepare: async () => {},
        release: async () => {},
        transcribe: async () => "",
        ...client,
      },
      microphone: {
        open: async () => ({ stop() {}, finish: async () => {} }),
        devices: async () => [],
        ...microphone,
      },
    }),
  );
}
