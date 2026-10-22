/** @vitest-environment jsdom */
import { screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { emptyProjectTodos } from "../../../src/contracts/projects/project-todos";
import { subagentLink } from "../../../src/contracts/subagents/subagent-reference";
import {
  handleId,
  parentSessionId,
  renderSubagentActivity,
  workerActivity,
  workerTranscript,
} from "./subagent-activity-workflow-fixture";

it("matches a subagent by public handle AND parent, changes/clears the shared cue, and opens its real chat", async () => {
  const first = "00000000-0000-4000-8000-000000000011";
  using fixture = renderSubagentActivity({
    activity: workerActivity(),
    parts: workerTranscript(),
    todos: {
      ...emptyProjectTodos(),
      items: [
        {
          id: first,
          title: "Review worker",
          description: "Review the investigation.",
          state: "open",
          status: "",
          revision: 0,
          associations: [
            { kind: "subagent", parentSessionId, handleId, title: "Investigation worker" },
          ],
        },
        {
          id: "00000000-0000-4000-8000-000000000012",
          title: "Other parent",
          description: "Another worker.",
          state: "open",
          status: "",
          revision: 0,
          associations: [
            { kind: "subagent", parentSessionId: "other-parent", handleId, title: "Other worker" },
          ],
        },
      ],
    },
  });
  await fixture.user.click((await screen.findByText("Work log")).closest("summary")!);
  const row = () => fixture.container.querySelector(`[data-subagent-handle="${handleId}"]`)!;
  const title = screen.getByRole("button", { name: "Review worker" });
  expect(row().hasAttribute("data-associated")).toBe(false);
  await fixture.user.click(title);
  expect(title.getAttribute("aria-pressed")).toBe("true");
  expect(row().getAttribute("data-associated")).toBe("true");
  expect(row().className).toContain("outline-dashed");
  const link = screen.getByRole("link", { name: "Investigation worker" });
  expect(link.getAttribute("href")).toBe(subagentLink(parentSessionId, handleId));
  await fixture.user.click(screen.getByRole("button", { name: "Other parent" }));
  expect(row().hasAttribute("data-associated")).toBe(false);
  await fixture.user.click(title);
  expect(row().getAttribute("data-associated")).toBe("true");
  await fixture.user.click(title);
  expect(row().hasAttribute("data-associated")).toBe(false);
  await fixture.user.click(link);
  expect(await screen.findByRole("complementary", { name: "Inspect the boundary" })).toBeDefined();
  expect(await screen.findByText("Inspecting now")).toBeDefined();
  expect(title.getAttribute("aria-pressed")).toBe("false");
});
