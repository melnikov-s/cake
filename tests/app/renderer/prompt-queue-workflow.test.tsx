/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { queuePart, queueSessionId, renderQueue } from "./prompt-queue-workflow-fixture";
import { renderChatSurface } from "./chat-surface-workflow-fixture";

const turnId = TurnId.make("10000000-0000-4000-8000-000000000001");
const commandOptions = expect.objectContaining({ signal: expect.any(AbortSignal) });
function queuedTexts() {
  return within(screen.getByRole("list", { name: "Queued prompts" }))
    .getAllByRole("listitem")
    .map((item) => within(item).getByRole("button", { name: /^View queued message:/ }).textContent);
}
async function enqueue(fixture: ReturnType<typeof renderQueue>, text: string) {
  await fixture.user.type(screen.getByRole("combobox"), text);
  await fixture.user.click(screen.getByRole("button", { name: "Send" }));
}
afterEach(cleanup);

// Real Root/Models/Chat and delivery policy, with typed SessionChats authority
// snapshots. Pi queue execution/abort/command semantics stay in service tests.
describe("Prompt queue workflow", () => {
  it.each([false, true])(
    "keeps text and an attachment together through pending admission, queueing, steering (%s), and delivery",
    async (promote) => {
      const text = "Review this attached log";
      const log = "QUEUED_LOG\n" + "details\n".repeat(50);
      const name = "Pasted text · 52 lines";
      const reference = {
        kind: "input" as const,
        id: "20000000-0000-4000-8000-000000000001",
        name,
        mimeType: "text/plain",
        byteLength: new TextEncoder().encode(log).byteLength,
      };
      const queued = queuePart(1, text, { attachments: [reference] });
      let release!: () => void;
      const admission = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => {
        await admission;
        return turnId;
      });
      const steer = vi.fn<Client["sessionChats"]["steerQueuedMessage"]>(async () => {
        fixture.publish([{ ...queued, deliveryState: "steering" }], true);
        return { steering: [text], followUp: [] };
      });
      using fixture = renderChatSurface({
        snapshot: { streaming: true },
        client: { sessionChats: { prompt, steerQueuedMessage: steer } },
      });
      await fixture.user.click(screen.getByRole("combobox"));
      await fixture.user.paste(log);
      await fixture.user.type(screen.getByRole("combobox"), text);
      await fixture.user.click(screen.getByRole("button", { name: "Send" }));
      expect(prompt).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          text,
          attachments: [{ kind: "text", name, text: log }],
        }),
        commandOptions,
      );
      const conversation = () => within(screen.getByLabelText("Conversation"));
      expect(conversation().queryByText(name, { exact: true })).toBeNull();
      expect(conversation().queryByText(text, { exact: true })).toBeNull();
      expect(queuedTexts()).toEqual([text]);
      const queue = within(screen.getByRole("list", { name: "Queued prompts" }));
      expect(queue.getByRole("status").textContent).toBe("Sending…");
      fixture.publish([queued], true);
      await act(async () => {
        release();
        await admission;
      });
      expect(queuedTexts()).toEqual([text]);
      expect(conversation().queryByText(name, { exact: true })).toBeNull();
      if (promote) {
        await fixture.user.click(
          screen.getByRole("button", { name: `Send now as steering: ${text}` }),
        );
        expect(steer).toHaveBeenCalledExactlyOnceWith(
          { sessionId: queueSessionId, partId: queued.id },
          commandOptions,
        );
        expect(queue.getByRole("status").textContent).toBe("Waiting for agent");
        expect(conversation().queryByText(name, { exact: true })).toBeNull();
      }
      fixture.publish(
        [
          {
            id: "delivered-text",
            entryId: "delivered",
            kind: "text",
            role: "user",
            text,
            status: "complete",
          },
          {
            id: "delivered-input",
            kind: "attachment",
            name,
            mediaType: "text/plain",
            attachmentKind: "file",
            inputReference: reference,
          },
        ],
        true,
      );
      expect(screen.queryByRole("list", { name: "Queued prompts" })).toBeNull();
      expect(conversation().getAllByText(text, { exact: true })).toHaveLength(1);
      expect(conversation().getAllByText(name, { exact: true })).toHaveLength(1);
      expect(prompt).toHaveBeenCalledOnce();
    },
  );

  it("reorders and cancels authority-projected commands without offering message-only actions", async () => {
    const next = queuePart(1, "Next task");
    const command = queuePart(2, "/toolcompact", { command: "/toolcompact" });
    const reorder = vi.fn<Client["sessionChats"]["reorderQueuedMessage"]>(async () =>
      fixture.publish([command, next]),
    );
    const remove = vi.fn<Client["sessionChats"]["removeQueuedMessage"]>(async () =>
      fixture.publish([next]),
    );
    using fixture = renderQueue([next, command], {
      sessionChats: { reorderQueuedMessage: reorder, removeQueuedMessage: remove },
    });
    expect(screen.getByRole("button", { name: "Send now as steering: Next task" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Edit queued prompt: Next task" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Send now as steering: /toolcompact" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit queued prompt: /toolcompact" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Move up: /toolcompact" }));
    expect(queuedTexts()).toEqual(["/toolcompact", "Next task"]);
    expect(reorder).toHaveBeenCalledExactlyOnceWith(
      { sessionId: queueSessionId, itemId: command.queuedInput!.itemId, position: 1 },
      commandOptions,
    );
    await fixture.user.click(
      screen.getByRole("button", { name: "Cancel queued message: /toolcompact" }),
    );
    expect(queuedTexts()).toEqual(["Next task"]);
    expect(remove).toHaveBeenCalledExactlyOnceWith(
      { sessionId: queueSessionId, partId: command.id },
      commandOptions,
    );
  });

  it("keeps agent/user ordering lane-local and follows promotion and individual cancellation", async () => {
    const first = queuePart(1, "First steer", { lane: "steering" });
    const agentSteer = queuePart(2, "Agent steer", { lane: "steering", agent: true });
    const agent = queuePart(3, "Agent queued", { agent: true });
    const user = queuePart(4, "User queued");
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => {
      fixture.publish([first, agentSteer, agent, user]);
      return turnId;
    });
    const reorder = vi
      .fn<Client["sessionChats"]["reorderQueuedMessage"]>()
      .mockImplementationOnce(async () => fixture.publish([first, agentSteer, user, agent]))
      .mockImplementationOnce(async () => fixture.publish([agentSteer, first, user, agent]));
    const promoted = { ...agent, deliveryState: "steering" as const };
    const steer = vi.fn<Client["sessionChats"]["steerQueuedMessage"]>(async () =>
      fixture.publish([agentSteer, first, promoted, user]),
    );
    const remove = vi.fn<Client["sessionChats"]["removeQueuedMessage"]>(async () =>
      fixture.publish([agentSteer, first, user]),
    );
    using fixture = renderQueue([first, agentSteer, agent], {
      sessionChats: {
        prompt,
        reorderQueuedMessage: reorder,
        steerQueuedMessage: steer,
        removeQueuedMessage: remove,
      },
    });
    await enqueue(fixture, "User queued");
    expect(queuedTexts()).toEqual(["First steer", "Agent steer", "Agent queued", "User queued"]);
    await fixture.user.click(screen.getByRole("button", { name: "Move up: User queued" }));
    await fixture.user.click(screen.getByRole("button", { name: "Move up: Agent steer" }));
    expect(queuedTexts()).toEqual(["Agent steer", "First steer", "User queued", "Agent queued"]);
    expect(reorder.mock.calls.map(([input]) => input)).toEqual([
      { sessionId: queueSessionId, itemId: user.queuedInput!.itemId, position: 1 },
      { sessionId: queueSessionId, itemId: agentSteer.queuedInput!.itemId, position: 1 },
    ]);
    expect(screen.getByRole("button", { name: "Move up: User queued" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Move down: First steer" })).toHaveProperty(
      "disabled",
      true,
    );
    await fixture.user.click(
      screen.getByRole("button", { name: "Send now as steering: Agent queued" }),
    );
    expect(steer).toHaveBeenCalledExactlyOnceWith(
      { sessionId: queueSessionId, partId: agent.id },
      commandOptions,
    );
    expect(
      within(screen.getByRole("group", { name: "Steering" })).getAllByRole("listitem"),
    ).toHaveLength(3);
    expect(queuedTexts()).toEqual(["Agent steer", "First steer", "Agent queued", "User queued"]);
    await fixture.user.click(screen.getByRole("button", { name: "Cancel steering: Agent queued" }));
    expect(remove).toHaveBeenCalledExactlyOnceWith(
      { sessionId: queueSessionId, partId: agent.id },
      commandOptions,
    );
    expect(queuedTexts()).toEqual(["Agent steer", "First steer", "User queued"]);
  });

  it("expands status only on steering promotion and sends the chosen item while retaining the queue", async () => {
    const steering = queuePart(1, "Keep steering", { lane: "steering" });
    const queued = queuePart(2, "Keep queued");
    const agent = queuePart(3, "Send agent now", { agent: true });
    const steer = vi.fn<Client["sessionChats"]["steerQueuedMessage"]>(async () =>
      fixture.publish([steering, { ...agent, deliveryState: "steering" }, queued]),
    );
    const sendNow = vi.fn<Client["sessionChats"]["sendQueuedMessageNow"]>(async () =>
      fixture.publish([steering, queued]),
    );
    using fixture = renderQueue([steering, queued, agent], {
      sessionChats: { steerQueuedMessage: steer, sendQueuedMessageNow: sendNow },
    });
    const queuedGroup = screen.getByRole("group", { name: "Queued" });
    expect(within(queuedGroup).queryByRole("status")).toBeNull();
    expect(within(queuedGroup).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Stop and send now: Send agent now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop and send now: Keep queued" })).toBeNull();
    await fixture.user.click(
      screen.getByRole("button", { name: "Send now as steering: Send agent now" }),
    );
    expect(sendNow).not.toHaveBeenCalled();
    expect(queuedTexts()).toEqual(["Keep steering", "Send agent now", "Keep queued"]);
    expect(
      within(screen.getByRole("group", { name: "Steering" }))
        .getAllByRole("status")
        .map((status) => status.textContent),
    ).toEqual(["Waiting for agent", "Waiting for agent"]);
    expect(within(queuedGroup).queryByRole("status")).toBeNull();
    expect(within(queuedGroup).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Stop and send now: Keep queued" })).toBeNull();
    await fixture.user.click(
      screen.getByRole("button", { name: "Stop and send now: Send agent now" }),
    );
    expect(sendNow).toHaveBeenCalledExactlyOnceWith(
      { sessionId: queueSessionId, partId: agent.id },
      commandOptions,
    );
    expect(queuedTexts()).toEqual(["Keep steering", "Keep queued"]);
  });

  it("restores an admitted payload for editing and resubmits at the authoritative queue tail", async () => {
    const first = queuePart(1, "# First", {
      markdown: true,
      attachments: [
        { kind: "image", name: "diagram.png", mimeType: "image/png", data: "aW1hZ2U=" },
      ],
    });
    const second = queuePart(2, "Second");
    const revised = queuePart(3, "# First revised", {
      markdown: true,
      attachments: first.queuedInput!.attachments,
    });
    const remove = vi.fn<Client["sessionChats"]["removeQueuedMessage"]>(async () =>
      fixture.publish([second]),
    );
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => {
      fixture.publish([second, revised]);
      return turnId;
    });
    using fixture = renderQueue([first, second], {
      sessionChats: { removeQueuedMessage: remove, prompt },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Edit queued prompt: # First" }));
    expect(screen.getByRole<HTMLTextAreaElement>("combobox").value).toBe("# First");
    expect(screen.getByAltText("diagram.png")).toBeDefined();
    expect(queuedTexts()).toEqual(["Second"]);
    await fixture.user.type(screen.getByRole("combobox"), " revised");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "# First revised",
        attachments: first.queuedInput!.attachments,
        renderUserMessageAsMarkdown: true,
      }),
      commandOptions,
    );
    expect(queuedTexts()).toEqual(["Second", "# First revised"]);
  });

  it("withholds mutation positions for optimistic admissions until the canonical item arrives", async () => {
    const first = queuePart(1, "First");
    const admitted = queuePart(2, "Pending");
    let release!: () => void;
    const admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => {
      await admission;
      fixture.publish([first, admitted]);
      return turnId;
    });
    const reorder = vi.fn<Client["sessionChats"]["reorderQueuedMessage"]>(async () =>
      fixture.publish([admitted, first]),
    );
    using fixture = renderQueue([first], {
      sessionChats: { prompt, reorderQueuedMessage: reorder },
    });
    await enqueue(fixture, "Pending");
    expect(queuedTexts()).toEqual(["First", "Pending"]);
    expect(screen.getByRole("button", { name: "Move down: First" })).toHaveProperty(
      "disabled",
      true,
    );
    const cancel = screen.getByRole("button", { name: "Cancel queued message: Pending" });
    expect(cancel).toHaveProperty("disabled", true);
    await fixture.user.click(cancel);
    expect(queuedTexts()).toEqual(["First", "Pending"]);
    const pendingRow = screen
      .getByRole("button", { name: "View queued message: Pending" })
      .closest<HTMLElement>('[role="listitem"]')!;
    expect(within(pendingRow).getByRole("status").textContent).toBe("Sending…");
    for (const button of within(pendingRow).getAllByRole<HTMLButtonElement>("button")) {
      if (button.getAttribute("aria-label") !== "View queued message: Pending") {
        expect(button.disabled).toBe(true);
      }
    }
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Move down: First" }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Cancel queued message: Pending" })
        .disabled,
    ).toBe(true);
    await act(async () => {
      release();
      await admission;
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Move down: First" })).toHaveProperty(
        "disabled",
        false,
      ),
    );

    expect(
      within(screen.getByRole("group", { name: "Queued" })).queryAllByRole("status"),
    ).toHaveLength(0);
    await fixture.user.click(screen.getByRole("button", { name: "Move up: Pending" }));
    expect(queuedTexts()).toEqual(["Pending", "First"]);
    expect(reorder).toHaveBeenCalledExactlyOnceWith(
      { sessionId: queueSessionId, itemId: admitted.queuedInput!.itemId, position: 1 },
      commandOptions,
    );
  });

  it("restores failed admissions for retry and preserves queue order through mutation failure and retry", async () => {
    const first = queuePart(1, "First");
    const retry = queuePart(2, "Retry this");
    const prompt = vi
      .fn<Client["sessionChats"]["prompt"]>()
      .mockRejectedValueOnce(new Error("Runtime unavailable"))
      .mockImplementationOnce(async () => {
        fixture.publish([first, retry]);
        return turnId;
      });
    const reorder = vi
      .fn<Client["sessionChats"]["reorderQueuedMessage"]>()
      .mockRejectedValueOnce(new Error("Queue unavailable"))
      .mockImplementationOnce(async () => fixture.publish([retry, first]));
    using fixture = renderQueue([first], {
      sessionChats: { prompt, reorderQueuedMessage: reorder },
    });
    await enqueue(fixture, "Retry this");
    expect(await screen.findByText("Runtime unavailable")).toBeDefined();
    expect(screen.getByRole<HTMLTextAreaElement>("combobox").value).toBe("Retry this");
    expect(queuedTexts()).toEqual(["First"]);
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(queuedTexts()).toEqual(["First", "Retry this"]));
    expect(prompt).toHaveBeenCalledTimes(2);
    await fixture.user.click(screen.getByRole("button", { name: "Move up: Retry this" }));
    expect(await screen.findByText("Queue unavailable")).toBeDefined();
    expect(queuedTexts()).toEqual(["First", "Retry this"]);
    await fixture.user.click(screen.getByRole("button", { name: "Move up: Retry this" }));
    expect(queuedTexts()).toEqual(["Retry this", "First"]);
    expect(reorder).toHaveBeenCalledTimes(2);
  });
});
