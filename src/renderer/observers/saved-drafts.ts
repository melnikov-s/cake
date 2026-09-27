import type { SavedDraft } from "../../domain/project-sessions/saved-draft-data";
import type { Runtime } from "../runtime";

/** One authoritative backend snapshot at subscription and after each committed mutation. */
export const observeSavedDrafts = (
  runtime: Runtime,
  apply: (records: ReadonlyArray<SavedDraft>) => void,
  reportFailure: (error: unknown) => void,
) => runtime.observe((client) => client.savedDrafts.observe(), apply, { reportFailure });
