import { expect, it } from "vitest";
import artifacts from "../../../docs/agent/artifacts.md?raw";
import presentation from "../../../docs/agent/presentation.md?raw";
it("keeps artifacts chat-first and revision-scoped", () => {
  for (const rule of [
    "ordinary work/reports in chat",
    "request or shared durable spec",
    "no repository task records",
    "share exact revisions",
    "Content is not preloaded",
    "expectedRevision",
    "projection files are read-only",
  ])
    expect(artifacts).toContain(rule);
});
it("requires matching visual evidence, not source descriptions", () => {
  for (const rule of [
    "exact @rN preview pixels",
    "confirm selected state",
    "Compare real implementation pixels",
    "not visual proof",
    "no latest/all-options fallback",
  ])
    expect(artifacts).toContain(rule);
  expect(presentation).toContain("Presentation is not inspection");
  expect(presentation).toContain("Requested file deliverables remain files");
});
