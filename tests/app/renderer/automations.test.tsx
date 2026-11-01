import { describe, it } from "vitest";

describe("automation management workflow", () => {
  // Implement with the real Root/Models/Stores and a typed external Client fake.
  it.todo(
    "opens the global hub and distinguishes running automations, active sessions and queued occurrences",
  );
  it.todo("filters definitions by global or project context and lifecycle state");
  it.todo("creates an automation through Context, Trigger and Task with explicit settings");
  it.todo("preselects the project from its New automation context-menu action");
  it.todo("shows simultaneous running and queued activity even after pausing");
  it.todo("opens a suspended automation with its concrete reason and recovery action");
  it.todo("keeps definition, runs and memory navigation separate within the selected automation");
  it.todo(
    "shows active global automation sessions below Automations and project runs under their project",
  );
  it.todo("opens runs in the existing chat surface with a distinct automation identity");
  it.todo("removes an auto-resolved session from the active sidebar but retains it in run history");
  it.todo("opens and unresolves a past run without firing the automation");
  it.todo(
    "zooms memory branches to originals and navigates back without losing the selected automation",
  );
});
