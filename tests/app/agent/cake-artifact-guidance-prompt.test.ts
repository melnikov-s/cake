import { describe, expect, it } from "vitest";
import { coordinatorSystemPrompt } from "../../../src/services/pi-durable/coordinator-system-prompt";
import artifactDocumentation from "../../../docs/agent/artifacts.md?raw";
import presentationDocumentation from "../../../docs/agent/presentation.md?raw";

const projectGuidance = `${artifactDocumentation}\n\n${presentationDocumentation}`;

it("requires Cake Chat to read the exact-revision visual handoff rules before acting", () => {
  const prompt = coordinatorSystemPrompt("", "/cake/docs");
  expect(prompt).toContain("Read before acting");
  expect(prompt).toContain("`artifacts.md` for publishing/sharing/design implementation");
  expect(prompt).toContain("`presentation.md` for rich output/images/files/links/selected text");
});

describe("shared artifact guidance required by Project Sessions and Cake Chat", () => {
  const prompt = projectGuidance;
  it("keeps investigations and ordinary task communication in chat unless explicitly requested", () => {
    expect(prompt).toContain(
      "Keep investigations, explanations, ordinary implementation details, progress, and reports in chat by default",
    );
    expect(prompt).toContain(
      "Create text/Markdown artifacts only when the user explicitly requests them",
    );
    expect(prompt).toContain("Do not create repository Markdown files or duplicate artifacts");
  });

  it("allows only shared-reference specs without an explicit artifact request", () => {
    expect(prompt).toContain(
      "with one exception: a spec may become a text artifact without an explicit artifact request",
    );
    expect(prompt).toContain("when it serves as a shared, durable reference");
    expect(prompt).toContain("this session can read after compaction");
    expect(prompt).toContain("child sessions can read for coordinated implementation");
    expect(prompt).toContain(
      "Shared-reference usefulness—not length, formatting, or merely being an investigation—is the purpose of these artifacts",
    );
  });

  it("shares readable revisions across sessions rather than assuming shared files or context", () => {
    expect(prompt).toContain("Share artifact references with other sessions");
    expect(prompt).toContain(
      "recipients must discover or link the artifact and inspect the relevant exact revision",
    );
    expect(prompt).toContain("Revise the same artifact");
    expect(prompt).toContain("use an exact revision for an approved spec or assignment baseline");
    expect(prompt).toContain("If your tools cannot publish artifacts");
    expect(prompt).toContain("have the owning Project Session publish the document");
  });

  it("requires approved visual evidence while keeping dynamic behavior and private history distinct", () => {
    expect(prompt).toContain("accepted review PNG as a native image to the caller");
    expect(prompt).toContain("live interactive rendering shown to the user is a separate surface");
    expect(prompt).toContain("inspect the approved exact @rN preview");
    expect(prompt).toContain("The brief describes intent; it is not the approved visual design");
    expect(prompt).toContain("source.tsx.txt/source.html.txt selectively");
    expect(prompt).toContain("do not import private generation conversation history");
    expect(prompt).toContain(
      "Compare the implementation's real screenshot against the same approved revision",
    );
    expect(prompt).toContain("verify relevant interactions");
    expect(prompt).toContain("A matching revision is not enough");
    expect(prompt).toContain(
      "request a screenshot and confirm its artifact revision and selected state",
    );
    expect(prompt).toContain(
      "Never claim visual verification from source or an image description alone",
    );
    expect(prompt).toContain("disclose missing pixels");
  });

  it("preserves ordinary chat, maintained project docs, and requested files", () => {
    expect(prompt).toContain(
      "This text/Markdown policy does not restrict non-text visual artifacts or explicitly requested file deliverables",
    );
    expect(prompt).toContain("maintained project documentation, executable code/tests");
    expect(prompt).toContain("an explicitly requested file deliverable");
  });
});

it("Project Session documentation preserves publication and child-assignment guidance", () => {
  expect(projectGuidance).toContain(
    "Use these inline for ordinary conversation regardless of length or formatting",
  );
  expect(projectGuidance).toContain(
    "When the user requests a text artifact or a spec qualifies as a shared durable reference",
  );
  expect(projectGuidance).toContain("publish Markdown directly with `artifacts.create`");
  expect(projectGuidance).toContain(
    "Revise it with `artifacts.update` for targeted Markdown edits",
  );
  expect(projectGuidance).toContain("Use `artifacts.replace` for full Markdown rewrites");
  expect(projectGuidance).toContain("Both require `expectedRevision`");
  expect(projectGuidance).toContain(
    "artifact reference and relevant revision in child-session assignments",
  );
  expect(projectGuidance).toContain("ask recipients to read it before implementing the spec");
  expect(projectGuidance).toContain("For explicitly requested file-format deliverables");
});
