/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  parentSessionId,
  renderSubagentActivity,
  workerActivity,
  workerTranscript,
} from "./subagent-activity-workflow-fixture";

afterEach(cleanup);

// Real parent Chat/Root/Subagent catalog -> compact outcome -> real side chat.
// This replaces SSR-only subagent presentation and a manually mounted Store;
// no source waits or synthetic peer Stores are needed for live authority.
it("shows live worker activity without a wait call and keeps completed details in its side chat", async () => {
  const running = workerActivity({
    task: "Inspect the live boundary",
    resolvedModel: {
      requested: "exact",
      source: "exact",
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "max",
      fallbacks: [],
    },
    parts: [
      {
        id: "child-read",
        kind: "tool",
        name: "read",
        input: "src/main.ts",
        state: "running",
      },
    ],
  });
  const spawn = workerTranscript()[0]!;
  const start = {
    ...spawn,
    input: JSON.stringify({
      task: running.task,
      instructions: "Focus on runtime validation.",
      model: {
        prefer: "exact",
        provider: running.resolvedModel.provider,
        modelId: running.resolvedModel.modelId,
        thinkingLevel: running.resolvedModel.thinkingLevel,
      },
    }),
  };
  using fixture = renderSubagentActivity({ activity: running, parts: [start] });
  const summary = (await screen.findByText("Work log")).closest("summary");
  if (!summary) throw new Error("Missing work log disclosure");
  await fixture.user.click(summary);
  expect(screen.getByText("Inspect the live boundary")).toBeDefined();
  expect(screen.getByText(/Running read/).textContent).toContain("openai-codex/gpt-5.6-sol");
  expect(document.querySelector('[data-slot="subagent-call"]')?.getAttribute("data-status")).toBe(
    "running",
  );
  expect(screen.queryByText("Focus on runtime validation.")).toBeNull();

  const completed = workerActivity({
    ...running,
    revision: 2,
    status: "complete",
    streaming: false,
    parts: [
      {
        id: "child-read",
        kind: "tool",
        name: "read",
        input: "src/main.ts",
        state: "success",
      },
      {
        id: "child-answer",
        kind: "text",
        role: "assistant",
        text: "The boundary is correctly isolated.",
        status: "complete",
      },
    ],
  });
  fixture.publish({ _tag: "Activity", revision: 2, parentSessionId, activity: completed }, [
    start,
    ...workerTranscript(completed).slice(1),
  ]);
  expect(screen.getByText(/Last activity: read/).textContent).toContain("openai-codex/gpt-5.6-sol");
  expect(document.querySelector('[data-slot="subagent-call"]')?.getAttribute("data-status")).toBe(
    "complete",
  );
  // The parent outcome remains compact; detail becomes visible only when opened.
  expect(screen.queryByText("The boundary is correctly isolated.")).toBeNull();
  await fixture.user.click(screen.getByRole("button", { name: "Open subagent chat" }));
  const panel = within(screen.getByRole("complementary", { name: "Subagent" }));
  expect(await panel.findByText("The boundary is correctly isolated.")).toBeDefined();
  await fixture.user.click(panel.getByRole("button", { name: "Close Subagent" }));
  expect(screen.queryByText("The boundary is correctly isolated.")).toBeNull();
  expect(screen.getByText("Inspect the live boundary")).toBeDefined();
});
