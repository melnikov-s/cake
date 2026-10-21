import { Effect } from "effect";
import type { ProjectSessionTarget } from "../../contracts/project-sessions/project-session-data";
import * as lifecycle from "./projectSessionLifecycle";

/** Renderer intent shares the native lifecycle's persistence and to-do policy with tools. */
export const setResolved = Effect.fn("ProjectSessions.setResolvedFromUser")(function* (
  target: ProjectSessionTarget,
  resolved: boolean,
) {
  yield* resolved ? lifecycle.resolve(target) : lifecycle.restore(target);
});
