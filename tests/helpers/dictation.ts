import type { DictationState } from "../../src/contracts/dictation/dictation-data";

export const installedDictationState: DictationState = {
  supported: true,
  status: "installed",
  modelPath: "/fixture/model",
  managedModelPath: "/fixture/model",
  engineAvailable: true,
  downloadedBytes: 0,
  totalBytes: 0,
};
