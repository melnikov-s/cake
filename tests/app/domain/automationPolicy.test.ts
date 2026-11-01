import { describe, it } from "vitest";

describe("automation admission", () => {
  it.todo("starts an active idle automation and records its trigger occurrence");
  it.todo("skips a busy automation without replay when overlap is skip");
  it.todo("queues busy occurrences FIFO without creating Pi sessions before execution");
  it.todo("starts parallel sessions only for the same automation's parallel policy");
  it.todo("does not let another automation's activity block admission");
  it.todo("skips automatic triggers while paused without building a missed-trigger backlog");
  it.todo("allows manual Run now while paused without activating the automation");
  it.todo("applies overlap to manual Run now as well as automatic triggers");
  it.todo("blocks execution while suspended or archived with a concrete reason");
  it.todo("admits at most one session when simultaneous triggers use skip or queue");
});

describe("scoped event matching", () => {
  it.todo("matches the configured event, project, source kind, exact session and content together");
  it.todo("distinguishes standalone sessions, family roots, and recursive family children");
  it.todo("distinguishes permanent global Cake Chat from a Project Chat");
  it.todo("does not infer family roots from a missing parent or from creator provenance");
  it.todo("does not match an otherwise identical event from another project or session");
  it.todo("does not match content filters against session-created events with no message");
});
