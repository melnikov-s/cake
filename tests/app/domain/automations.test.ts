import { describe, it } from "vitest";

describe("automation lifecycle and execution", () => {
  it.todo(
    "creates a definition with an independent memory identity and explicit execution settings",
  );
  it.todo("starts a real AutomationSession identity from a manual trigger without a fake project");
  it.todo(
    "loads global resources at home and project resources at the selected trusted project root",
  );
  it.todo("does not create a worktree or session family merely by starting an automation run");
  it.todo("keeps configuration edits out of running sessions and already accepted queued work");
  it.todo(
    "pauses new automatic admission, lets active sessions finish, and holds existing queued work",
  );
  it.todo("resumes queued occurrences FIFO after activation without replaying skipped triggers");
  it.todo("archives future triggers and cancels queued work while honoring let-finish versus stop");
  it.todo("keeps a single failed run visible without suspending the entire automation");
  it.todo(
    "suspends an unavailable project automation with a reason and validates before activation",
  );
  it.todo(
    "archives a one-time automation after its execution attempt and retains memory and history",
  );
  it.todo("auto-resolves successful sessions only when configured and retains failures for review");
  it.todo("lets keep-for-review sessions remain unresolved after successful execution");
  it.todo("unresolves a historical session without rerunning or reactivating its automation");
  it.todo(
    "cancels a run without pausing its automation and cancels queued work without creating a session",
  );
});

describe("automation triggers and recovery", () => {
  it.todo("fires once, fixed-interval, and timezone-aware calendar schedules using backend time");
  it.todo("does not backfill every missed interval when the backend restarts");
  it.todo("persists definitions, queued occurrences and session links across restart");
  it.todo("uses existing Pi recovery outcomes rather than blindly rerunning interrupted work");
  it.todo(
    "emits response-completed only for a successful final reply, never tools or intermediate text",
  );
  it.todo("emits user-message-received only for genuine user input, not internal notices");
  it.todo("evaluates source events without requiring a renderer to observe the source session");
});
