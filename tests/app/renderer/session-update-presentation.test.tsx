/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
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
    expect(within(batch).queryByRole("link", { name: title })).toBeNull();
    expect(within(batch).getByRole("link", { name: "Open session" }).getAttribute("href")).toBe(
      "cake://session/producer",
    );
    expect(batch.textContent).not.toContain("merged=true");
    expect(batch.textContent).not.toContain(base.landedCommit);
    expect(batch.textContent).not.toContain("8d0e8bf3");
    if (!merged || !resolutionSucceeded)
      expect(within(batch).getByText(outcome.message)).toBeTruthy();
    const toggle = within(batch).getByRole("button", { name: "System details" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await fixture.user.click(toggle);
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)?.textContent).toBe(
      entry?.text,
    );
    expect(projectSessionEntries(fixture.parent.getEntries())).toEqual(fixture.parts);
  },
);

it.each([
  ["merged=true; resolutionSucceeded=true", "completed", false],
  ["merged=true; resolutionSucceeded=false", "completed", true],
  ["Conflict requires manual recovery", "blocked", true],
] as const)(
  "keeps legacy telemetry inspectable without claiming resolution: %s",
  async (payload, status, needsReview) => {
    const text = reminder(undefined, `Auto-merge backend outcome: ${payload}`, status);
    const [entry] = sessionNotificationEntries(text);
    expect(entry?.autoMergeOutcome).toBeUndefined();
    expect(entry?.needsReview).toBe(needsReview);
    using fixture = show(text);
    const batch = screen.getByRole("status", { name: "Session results" });
    expect(batch.textContent).not.toContain(payload);
    expect(batch.textContent).not.toContain("Merged and resolved");
    if (needsReview) expect(within(batch).getByText("Auto-merge needs review")).toBeTruthy();
    await fixture.user.click(within(batch).getByRole("button", { name: "System details" }));
    expect(batch.textContent).toContain(payload);
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

it("keeps unlinked legacy backend diagnostics in raw system details", async () => {
  const raw = "Auto-merge backend outcome: merged=true; resolutionSucceeded=true";
  using fixture = show(`<system-reminder>\nCake session updates\n${raw}\n</system-reminder>`);
  const batch = screen.getByRole("status", { name: "Session results" });
  expect(batch.textContent).not.toContain(raw);
  expect(within(batch).getByText("Session update")).toBeTruthy();
  await fixture.user.click(within(batch).getByRole("button", { name: "System details" }));
  expect(batch.textContent).toContain(raw);
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
