/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, mount } from "r-state-tree";
import { SessionUpdateEntry } from "../../../src/renderer/components/session-update-entry";
import { SessionUpdateEntryStore } from "../../../src/renderer/stores/SessionUpdateEntryStore";
import { ProjectTodosStore } from "../../../src/renderer/stores/ProjectTodosStore";
import { MarkdownLinkProvider } from "../../../src/renderer/components/ai-elements/markdown";
import { emptyProjectTodos, type ProjectTodo } from "../../../src/contracts/projects/project-todos";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  formatSessionDigestReminder,
  sessionNotificationEntries,
  sessionDigestReceiptIds,
} from "../../../src/contracts/cake-chats/session-digest-reminder";
import {
  autoMergeOutcomeLabel,
  type AutoMergeOutcome,
} from "../../../src/contracts/worktrees/auto-merge";
import { projectSessionEntries } from "../../../src/services/pi/runtime/session-projection";
import { readMessageReference } from "../../../src/services/pi/runtime/message-references";
import { renderChatSurface } from "./chat-surface-workflow-fixture";

const title = "Exclude Project Chat from working-session badge";
const base = {
  targetBranch: "main",
  landedCommit: "a".repeat(40),
  message: "Auto-merged and resolved",
};
const reminder = (
  outcome?: AutoMergeOutcome,
  summary = "Backend update",
  status: "completed" | "blocked" = "completed",
) =>
  formatSessionDigestReminder({
    lines: [
      {
        reference: "8d0e8bf3",
        sessionId: "producer",
        title,
        status,
        summary,
        ...(outcome ? { autoMergeOutcome: outcome } : {}),
      },
    ],
    receiptIds: ["exact-receipt"],
  })!;
function show(text: string) {
  const parent = SessionManager.inMemory("/project");
  parent.appendMessage({ role: "user", timestamp: 1, content: text });
  const parts = projectSessionEntries(parent.getEntries());
  return { ...renderChatSurface({ parts }), parent, parts };
}
afterEach(cleanup);

it.each([
  [true, true, "Merged and resolved"],
  [true, false, "Merged · resolution failed"],
  [false, false, "Merge blocked"],
  [false, true, "Merge blocked"],
] as const)(
  "projects typed merged=%s resolved=%s without inferring lifecycle from prose",
  async (merged, resolutionSucceeded, label) => {
    const outcome = {
      ...base,
      merged,
      resolutionSucceeded,
      message:
        merged && resolutionSucceeded ? base.message : "Resolve the conflict before continuing.",
    };
    const text = reminder(outcome);
    expect(autoMergeOutcomeLabel(outcome)).toBe(label);
    const [entry] = sessionNotificationEntries(text);
    expect(entry?.autoMergeOutcome).toEqual(outcome);
    expect(sessionDigestReceiptIds(text)).toEqual(["exact-receipt"]);
    using fixture = show(text);
    const batch = screen.getByRole("status", { name: "Session results" });
    expect(within(batch).getByText(title)).toBeTruthy();
    expect(within(batch).getByText(label)).toBeTruthy();
    expect(batch.querySelector('[data-slot="session-message"]')).toBeNull();
    expect(within(batch).getByRole("link", { name: title }).getAttribute("href")).toBe(
      "cake://session/producer",
    );
    expect(within(batch).getByRole("link", { name: "Open session" }).getAttribute("href")).toBe(
      "cake://session/producer",
    );
    expect(batch.textContent).not.toContain("merged=true");
    expect(batch.textContent).not.toContain(base.landedCommit);
    expect(batch.textContent).not.toContain("8d0e8bf3");
    if (!merged || !resolutionSucceeded)
      expect(within(batch).getByText(outcome.message)).toBeTruthy();
    expect(within(batch).queryByRole("button", { name: "System details" })).toBeNull();
    expect(batch.querySelector('[data-slot="result-todo-done"]')).toBeNull();
    const sessionLink = within(batch).getByRole("link", { name: "Open session" });
    expect(sessionLink.textContent).toBe("");
    expect(sessionLink.querySelector("svg")).not.toBeNull();
    expect(batch.textContent).not.toMatch(/Open session|View to-do|To-do ·/);
    expect(projectSessionEntries(fixture.parent.getEntries())).toEqual(fixture.parts);
  },
);

it.each([
  ["merged=true; resolutionSucceeded=true", "completed", false],
  ["merged=true; resolutionSucceeded=false", "completed", true],
  ["Conflict requires manual recovery", "blocked", true],
] as const)(
  "keeps legacy failures visible without claiming resolution: %s",
  async (payload, status, needsReview) => {
    const text = reminder(undefined, `Auto-merge backend outcome: ${payload}`, status);
    const [entry] = sessionNotificationEntries(text);
    expect(entry?.autoMergeOutcome).toBeUndefined();
    expect(entry?.needsReview).toBe(needsReview);
    using fixture = show(text);
    const batch = screen.getByRole("status", { name: "Session results" });
    expect(batch.textContent).not.toContain("Merged and resolved");
    if (needsReview) {
      expect(within(batch).getByText("Auto-merge needs review")).toBeTruthy();
      expect(batch.textContent).toContain(payload);
    } else expect(batch.textContent).not.toContain(payload);
    expect(within(batch).queryByRole("button", { name: "System details" })).toBeNull();
  },
);

it("does not promote historical fallback IDs or unlinked telemetry into a title", () => {
  const text = reminder({ ...base, merged: true, resolutionSucceeded: true }).replace(
    title,
    "Session producer",
  );
  using fixture = show(text);
  const batch = screen.getByRole("status", { name: "Session results" });
  expect(within(batch).getByText("Untitled session")).toBeTruthy();
  expect(batch.textContent).not.toContain("Session producer");
});

it("keeps successful unlinked telemetry quiet without a misleading navigation target", () => {
  const raw = "Auto-merge backend outcome: merged=true; resolutionSucceeded=true";
  using fixture = show(`<system-reminder>\nCake session updates\n${raw}\n</system-reminder>`);
  const batch = screen.getByRole("status", { name: "Session results" });
  expect(batch.textContent).not.toContain(raw);
  expect(within(batch).getByText("Session update")).toBeTruthy();
  expect(within(batch).queryByRole("link")).toBeNull();
  expect(within(batch).queryByRole("button")).toBeNull();
});

it("opens the associated to-do from the compact title without selecting context or mutating completion", async () => {
  const item: ProjectTodo = {
    id: "linked-todo",
    title: "Sticky transcript to-do labels",
    description: "Review this task",
    state: "done",
    status: "Completed",
    revision: 1,
    associations: [{ kind: "session", sessionId: "producer", title }],
  };
  const pane = { visible: false, open: vi.fn(), close: vi.fn() };
  const replyContext = vi.fn();
  using todos = mount(
    createStore(ProjectTodosStore, {
      list: () => ({
        scope: "/project",
        chat: "Project Chat",
        owner: { todos: { ...emptyProjectTodos(), items: [item] }, todoCreationRevision: 0 },
      }),
      pane: () => pane,
      replyContext,
    }),
  );
  using store = mount(
    createStore(SessionUpdateEntryStore, {
      partId: "update",
      entry: sessionNotificationEntries(
        reminder({ ...base, merged: true, resolutionSucceeded: true }),
      )[0]!,
    }),
  );
  render(<SessionUpdateEntry store={store} todos={todos} />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: `View linked to-do: ${item.title}` }));
  expect(todos.inspectedItemId).toBe(item.id);
  expect(todos.doneExpanded).toBe(true);
  expect(pane.open).toHaveBeenCalledOnce();
  expect(todos.focusedItemIds).toEqual([]);
  expect(replyContext).not.toHaveBeenCalled();
  expect(item.state).toBe("done");
  expect(document.querySelector("footer")).toBeNull();
  expect(document.body.textContent).not.toContain(item.title);
});

it("uses session navigation when no associated to-do exists", async () => {
  const openSession = vi.fn();
  using store = mount(
    createStore(SessionUpdateEntryStore, {
      partId: "update",
      entry: sessionNotificationEntries(
        reminder({ ...base, merged: true, resolutionSucceeded: true }),
      )[0]!,
    }),
  );
  render(
    <MarkdownLinkProvider actions={{ openSession, openExternalUrl: vi.fn() }}>
      <SessionUpdateEntry store={store} />
    </MarkdownLinkProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("link", { name: title }));
  expect(openSession).toHaveBeenLastCalledWith("producer");
  const link = screen.getByRole("link", { name: "Open session" });
  expect(link.textContent).toBe("");
  await user.click(link);
  expect(openSession).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: /to-do/ })).toBeNull();
});

it("keeps an interrupted report explanation visible without system details", () => {
  const note =
    "The user sent this message while you were handling a session report, so that turn was stopped. Answer the user first and fold in anything important from the report.";
  using fixture = show(`<system-reminder>\nCake session updates\n${note}\n</system-reminder>`);
  expect(screen.getByText("Report interrupted")).toBeTruthy();
  expect(screen.getByText(note)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "System details" })).toBeNull();
});

it("falls back safely on malformed typed metadata", () => {
  const text = reminder(
    undefined,
    'Auto-merge backend outcome: unknown <cake-auto-merge-outcome>{"merged":true}</cake-auto-merge-outcome>',
  );
  const [entry] = sessionNotificationEntries(text);
  expect(entry?.autoMergeOutcome).toBeUndefined();
  expect(entry?.systemDetail).toBe(true);
});

it("does not demote a genuine referenced worker report containing backend diagnostic examples", async () => {
  const source = SessionManager.inMemory("/producer");
  const entryId = source.appendMessage({
    role: "user",
    timestamp: 1,
    content:
      "Real finding: Auto-merge backend outcome: is only an example. A conflict still blocks landing.",
  });
  const ref = readMessageReference(source, { entryId }).message.ref;
  const text = formatSessionDigestReminder({
    lines: [
      {
        reference: "producer",
        sessionId: "producer",
        title,
        status: "blocked",
        summary: "Investigated telemetry",
        resultMessageRef: ref,
      },
    ],
  })!;
  const inspect = vi.fn(async () => readMessageReference(source, { entryId }));
  const parent = SessionManager.inMemory("/project");
  parent.appendMessage({ role: "user", timestamp: 1, content: text });
  using fixture = renderChatSurface({
    parts: projectSessionEntries(parent.getEntries()),
    client: { sessionChats: { inspect } },
  });
  const card = screen.getByRole("region", { name: "Message from another session" });
  expect(card.querySelector('[data-slot="response-header"] a')).toBeNull();
  await fixture.user.click(within(card).getByRole("button", { name: title }));
  expect(await within(card).findByText(/Real finding:/)).toBeTruthy();
  expect(within(card).getByRole("link", { name: "Open source" }).getAttribute("href")).toBe(ref);
});
