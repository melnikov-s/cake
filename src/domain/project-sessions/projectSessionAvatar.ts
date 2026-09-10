import { createHash } from "node:crypto";

/** Produces an opaque, stable DiceBear seed without persisting prompt contents. */
export function avatarSeedFromInitialPrompt(initialPrompt: string) {
  return createHash("sha256").update(initialPrompt).digest("hex");
}
