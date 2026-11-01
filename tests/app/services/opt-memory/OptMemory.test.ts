import { describe, it } from "vitest";

describe("shared OptMem core and automation adapter", () => {
  it.todo("uses the extracted compaction core for Durable chat and automation memory");
  it.todo("exposes a 10000-byte automation view without limiting total retained originals");
  it.todo(
    "compacts adjacent summaries into deeper branches and zooms repeatedly to exact originals",
  );
  it.todo("preserves UTF-8 budgets and the existing summarizer retry and excerpt behavior");
  it.todo(
    "preserves Durable chat source filtering, source bounds, stale handles and original recall",
  );
  it.todo("keeps the existing Durable chat memory and scheduling regression suites passing");
  it.todo("writes an intentional note with trusted automation-session provenance");
  it.todo("shares notes across fresh sessions of one automation without copying prior transcripts");
  it.todo("keeps different automations' memories separate even when both use the same project");
  it.todo("retains notes from parallel sessions through serialized persistence");
  it.todo("keeps one session's Zoom navigation from changing another session's injected view");
  it.todo("resumes persisted compaction work after restart without losing original notes");
});
