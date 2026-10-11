/* global process, console */
import { rm } from "node:fs/promises";

export function nativeBuildMode(environment = process.env) {
  const mode = environment.CAKE_BUILD_MODE ?? "full";
  if (mode !== "full" && mode !== "slim")
    throw new Error(`Invalid CAKE_BUILD_MODE: ${mode}. Choose full or slim.`);
  return mode;
}

/** Slim output never retains native assets from a preceding full build. */
export async function buildNativeAssets(output, runScript, environment = process.env) {
  if (nativeBuildMode(environment) === "slim") {
    await rm(output, { recursive: true, force: true });
    console.log(
      "[cake] Slim build: native speech omitted; no Swift compilation or model downloads",
    );
    return;
  }
  for (const script of ["build-dictation.mjs", "build-speech.mjs"]) await runScript(script, output);
}
