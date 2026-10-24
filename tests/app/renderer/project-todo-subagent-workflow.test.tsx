/** @vitest-environment jsdom */
import { act, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  emptyProjectTodos,
  type ProjectTodos,
} from "../../../src/contracts/projects/project-todos";
import { subagentLink } from "../../../src/contracts/subagents/subagent-reference";
import {
  handleId,
  parentSessionId,
  projectChatSessionId,
  renderSubagentActivity,
  workerActivity,
  workerTranscript,
} from "./subagent-activity-workflow-fixture";

it.each([false, true])(
  "opens an exact worker response in its retained conversation (Project Chat=%s)",
  async (projectChat) => {
    const parent = projectChat ? projectChatSessionId : parentSessionId;
    const ref = subagentLink(parent, handleId, "original-answer");
    using fixture = renderSubagentActivity({
      projectChat,
      activity: workerActivity({
        parentSessionId: parent,
        status: "complete",
        streaming: false,
        released: true,
        parts: [
          {
            id: "entry-original-answer-text-0",
            entryId: "original-answer",
            kind: "text",
            role: "assistant",
            text: "## Actual findings\n\n**Worker result**",
            status: "complete",
          },
          {
            id: "later",
            kind: "text",
            role: "assistant",
            text: "Later unrelated answer",
            status: "complete",
          },
        ],
      }),
      parts: [
        ...workerTranscript(),
        {
          id: "summary",
          kind: "text",
          role: "assistant",
          text: `Summary. [Full agent response](${ref})`,
          status: "complete",
        },
      ],
    });
    await fixture.user.click(screen.getByRole("link", { name: "Full agent response" }));
    const conversation = await screen.findByRole("complementary", { name: "Inspect the boundary" });
    expect(within(conversation).getByRole("heading", { name: "Actual findings" })).toBeDefined();
    expect(within(conversation).getByText("Worker result").getAttribute("data-streamdown")).toBe(
      "strong",
    );
    const selected = conversation.querySelector(
      '[data-slot="transcript-item"][aria-current="true"]',
    );
    expect(selected?.textContent).toContain("Worker result");
    expect(selected?.textContent).not.toContain("Later unrelated answer");
  },
);

const projectChat = projectChatSessionId;
const first = "00000000-0000-4000-8000-000000000011";
const todos = (parent: string): ProjectTodos => ({
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
        { kind: "subagent", parentSessionId: parent, handleId, title: "Investigation worker" },
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
});

it("matches a subagent by public handle AND parent, changes/clears the shared cue, and closing the panel clears the selection", async () => {
  using fixture = renderSubagentActivity({
    projectChat: true,
    activity: workerActivity({ parentSessionId: projectChat }),
    parts: workerTranscript(),
    todos: todos(projectChat),
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
  expect(link.getAttribute("href")).toBe(subagentLink(projectChat, handleId));
  await fixture.user.click(screen.getByRole("button", { name: "Other parent" }));
  expect(row().hasAttribute("data-associated")).toBe(false);
  await fixture.user.click(title);
  expect(row().getAttribute("data-associated")).toBe("true");
  await fixture.user.click(title);
  expect(row().hasAttribute("data-associated")).toBe(false);
  await fixture.user.click(title);
  expect(fixture.todos()?.selectedId).toBe(first);
  await fixture.user.click(screen.getByRole("button", { name: "Close To-do" }));
  expect(screen.queryByRole("button", { name: "Review worker" })).toBeNull();
  expect(row().hasAttribute("data-associated")).toBe(false);
  await act(async () => {});
  expect(fixture.todos()?.selectedId).toBeNull();
  act(() => fixture.root.cakeChatCollectionStore.registry.find(projectChat)!.todos.open());
  expect(screen.getByRole("button", { name: "Review worker" }).getAttribute("aria-pressed")).toBe(
    "false",
  );
});

it("shows no cue in another chat while the Project Chat's to-do panel holds a selection", async () => {
  using fixture = renderSubagentActivity({
    activity: workerActivity(),
    parts: workerTranscript(),
    todos: todos(parentSessionId),
  });
  act(() => fixture.root.cakeChatCollectionStore.registry.find(projectChat)!.todos.open());
  await fixture.user.click((await screen.findByText("Work log")).closest("summary")!);
  const title = screen.getByRole("button", { name: "Review worker" });
  await fixture.user.click(title);
  expect(title.getAttribute("aria-pressed")).toBe("true");
  expect(
    fixture.container
      .querySelector(`[data-subagent-handle="${handleId}"]`)!
      .hasAttribute("data-associated"),
  ).toBe(false);
});
