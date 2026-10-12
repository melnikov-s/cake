import { Schema } from "effect";

/** The user-visible presentation selected for a Project Session. */
export const ProjectSessionPresentationMode = Schema.Literals([
  "normal",
  "vscode",
  "draw",
  "browser",
]);
export type ProjectSessionPresentationMode = typeof ProjectSessionPresentationMode.Type;
