import type { Client } from "../../src/renderer/client/Client";

/** Deterministic external detector fake. Tests use constant-valued PCM, not real model accuracy. */
export const detectFixtureSpeech: Client["dictation"]["detectSpeech"] = async ({ pcm }) => {
  const bytes = Buffer.from(pcm, "base64");
  let speechSamples = 0;
  for (let offset = 0; offset < bytes.length; offset += 4)
    if (Math.abs(bytes.readFloatLE(offset)) >= 0.015) speechSamples++;
  return speechSamples > bytes.length / 8;
};
