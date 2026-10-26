/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { renderTranscriptContent as render } from "./render-transcript-content";
import userEvent from "@testing-library/user-event";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageOperations } from "../../../src/domain/conversations/cake-message-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { readMessageReference } from "../../../src/services/pi/runtime/message-references";
import {
  projectSessionEntries,
  promptText,
} from "../../../src/services/pi/runtime/session-projection";
import { attachmentLink } from "../../../src/contracts/conversations/message-reference";
import type { Client } from "../../../src/renderer/client/Client";
import { messageNavigationTarget } from "../../../src/contracts/conversations/message-reference";
import {
  encodeCrossSessionMessage,
  formatCrossSessionReportText,
} from "../../../src/contracts/conversations/cross-session-message";
import { formatSessionDigestReminder } from "../../../src/contracts/cake-chats/session-digest-reminder";
import { appendMessageReferences } from "../../../src/contracts/conversations/message-reference-forwarding";
import { protectedResponseNotice } from "../../../src/contracts/conversations/reference-notification";
import { Chat } from "../../../src/renderer/components/chat";
import { MarkdownLinkProvider } from "../../../src/renderer/components/ai-elements/markdown";
import { Message } from "../../../src/renderer/models/Message";
import { messageSnapshots } from "../../../src/renderer/reducers/SessionPartReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { isWorkLogPart } from "../../../src/utils/work-log-groups";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("exact response presentation", () => {
  it("consolidates a batch into title-only disclosures while preserving distinct reports and batch-only notes", async () => {
    const source = SessionManager.inMemory("/producer");
    const report = (text: string) =>
      source.appendMessage({
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-responses",
        provider: "openai",
        model: "fixture",
        timestamp: 1,
        usage,
        stopReason: "stop",
      });
    const landedId = report("Landed 8 workstreams through Cake and resolved their owners.");
    const promptId = report(
      "Committed as d58aa9b5. Worktree clean; ready for review. No merge, resolution, or restart.",
    );
    const landedRef = readMessageReference(source, { entryId: landedId }).message.ref;
    const promptRef = readMessageReference(source, { entryId: promptId }).message.ref;
    const line = {
      reference: "worker",
      sessionId: source.getSessionId(),
      status: "completed" as const,
      kind: "ready" as const,
      decisions: ["review"] as const,
    };
    const parent = SessionManager.inMemory("/project");
    // Historical running-only inputs must not become an empty disclosure or context pill.
    parent.appendMessage({
      role: "user",
      timestamp: 1,
      content:
        "<system-reminder>\nCake session updates\n2 sessions you launched are still running.\n</system-reminder>",
    });
    parent.appendMessage({
      role: "user",
      timestamp: 2,
      content: formatSessionDigestReminder({
        lines: [
          {
            ...line,
            title: "Review and land ready Cake changes",
            summary: "Landed",
            resultMessageRef: landedRef,
          },
          {
            ...line,
            title: "Duplicate merge result",
            summary: "Same exact report",
            resultMessageRef: landedRef,
          },
          {
            ...line,
            title: "Simplify Cake prompts [progressive disclosure]",
            summary: "Ready",
            resultMessageRef: promptRef,
          },
          {
            ...line,
            title: "Keyboard navigation review",
            summary: "Focus order is still being checked. No final report yet.",
          },
        ],
        interruptedReport: false,
        receiptIds: ["private-delivery-receipt"],
      })!.replace(
        "\n</system-reminder>",
        "\n1 session you launched is still running.\n</system-reminder>",
      ),
    });
    const persisted = projectSessionEntries(parent.getEntries());
    const inspect = vi.fn(async (request: { sessionId: string; entryId?: string }) => {
      expect(request.sessionId).toBe(source.getSessionId());
      return readMessageReference(source, request);
    });
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [
        sessionSummary({
          sessionId: "parent",
          projectPath: "/project",
          workingDirectory: "/project",
        }),
      ],
      client: { sessionChats: { inspect } },
    });
    const session = fixture.root.sessionRegistry.load("parent", "/project");
    session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
      kind: "top",
    });
    applyConversationUpdate(session.model, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId: "parent",
        sessionFile: "/parent.jsonl",
        parts: persisted,
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        streaming: false,
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
      },
    });
    const openSession = vi.fn();
    const view = render(
      <MarkdownLinkProvider actions={{ openSession, openExternalUrl: () => {} }}>
        <Chat
          store={session.conversationSessionStore.chatStore}
          compact
          composerFocusEnabled={false}
        />
      </MarkdownLinkProvider>,
    );
    const batch = screen.getByRole("status", { name: "Session results" });
    const titles = [
      "Review and land ready Cake changes",
      "Simplify Cake prompts [progressive disclosure]",
      "Keyboard navigation review",
    ];
    expect(
      within(batch)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(titles);
    expect(
      within(batch).getAllByRole("region", { name: "Message from another session" }),
    ).toHaveLength(3);
    // Each card names its session once; the title is never repeated as a second header.
    for (const title of titles) expect(batch.textContent!.split(title)).toHaveLength(2);
    expect(screen.getAllByRole("status", { name: "Session results" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Cake · session updates" })).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
    const user = userEvent.setup();
    const prompts = within(batch).getByRole("button", { name: titles[1] });
    await user.click(prompts);
    expect(await within(batch).findByText(/Committed as d58aa9b5/)).toBeTruthy();
    const expanded = document.getElementById(prompts.getAttribute("aria-controls")!)!;
    expect(expanded.textContent).toBe(
      "Committed as d58aa9b5. Worktree clean; ready for review. No merge, resolution, or restart.",
    );
    const promptCard = within(prompts.closest<HTMLElement>('[data-slot="session-message"]')!);
    const fullResponse = promptCard.getByRole("link", { name: "Full response" });
    expect(fullResponse.getAttribute("href")).toBe(promptRef);
    await user.click(fullResponse);
    expect(openSession).toHaveBeenCalledWith(source.getSessionId(), promptId);
    await user.click(promptCard.getByRole("button", { name: "Copy message" }));
    expect(await navigator.clipboard.readText()).toBe(
      "Committed as d58aa9b5. Worktree clean; ready for review. No merge, resolution, or restart.",
    );
    expect(inspect).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: source.getSessionId(), entryId: promptId, offset: 0 }),
      expect.anything(),
    );
    await user.click(prompts);
    await user.click(within(batch).getByRole("button", { name: titles[2] }));
    expect(within(batch).getByText(/Focus order is still being checked/)).toBeTruthy();
    expect(inspect).toHaveBeenCalledTimes(1);
    await user.click(within(batch).getByRole("button", { name: titles[0] }));
    expect(
      await within(batch).findByText(
        "Landed 8 workstreams through Cake and resolved their owners.",
      ),
    ).toBeTruthy();
    expect(
      within(batch)
        .getAllByRole("link", { name: "Full response" })
        .map((link) => link.getAttribute("href")),
    ).toContain(landedRef);
    expect(projectSessionEntries(parent.getEntries())).toEqual(persisted);
    view.unmount();
  });

  it.each(["assistant", "receipt"] as const)(
    "loads %s report images lazily in the producer's workspace and attachment context, including after reopening",
    async (delivery) => {
      const source = SessionManager.inMemory("/producer-worktree");
      const attachment = {
        kind: "input" as const,
        id: crypto.randomUUID(),
        name: "Attached evidence.png",
        mimeType: "image/png",
        byteLength: 3,
      };
      const deniedId = crypto.randomUUID();
      const entryId = source.appendMessage({
        role: "user",
        timestamp: 1,
        content: promptText(
          [
            "## Image evidence",
            "![Screenshot](.visual-captures/screen.png)",
            "![Absolute screenshot](/producer-worktree/screen.png)",
            "![Missing](missing.png)",
            `![Linked attachment](${attachmentLink(source.getSessionId(), attachment.id)})`,
            `![Denied attachment](${attachmentLink(source.getSessionId(), deniedId)})`,
            `![Wrong session](${attachmentLink("viewer", attachment.id)})`,
          ].join("\n\n"),
          [attachment],
        ),
      });
      const original = readMessageReference(source, { entryId });
      const parent = SessionManager.inMemory("/viewer");
      if (delivery === "receipt")
        parent.appendMessage({
          role: "user",
          timestamp: 2,
          content: encodeCrossSessionMessage(
            appendMessageReferences(protectedResponseNotice, [original.message.ref]),
            {
              version: 1,
              messageId: crypto.randomUUID(),
              threadId: crypto.randomUUID(),
              replyToMessageId: crypto.randomUUID(),
              sequence: 1,
              expectsResponse: false,
              sender: {
                sessionId: source.getSessionId(),
                title: "Source media report",
                kind: "project-session",
              },
            },
          ),
        });
      else
        parent.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: `[Report](${original.message.ref})` }],
          api: "openai-responses",
          provider: "openai",
          model: "fixture",
          timestamp: 2,
          usage,
          stopReason: "stop",
        });
      const lookup = vi.fn<Client["projectSessions"]["lookup"]>(async () =>
        sessionSummary({
          sessionId: source.getSessionId(),
          projectPath: "/project",
          workingDirectory: "/producer-worktree",
        }),
      );
      const readImage = vi.fn<Client["filesystem"]["readImage"]>(async (_directory, path) => {
        if (path === "missing.png") throw new Error("Screenshot no longer exists");
        return { data: "AQID", mimeType: "image/png" };
      });
      const readAttachment = vi.fn<Client["sessionChats"]["readAttachment"]>(
        async ({ reference }) => {
          if (reference !== attachment.id)
            throw new Error("Attachment unavailable or unauthorized");
          return { kind: "image", reference: attachment, data: "BAUG", mimeType: "image/png" };
        },
      );
      using fixture = createRendererStoreFixture({
        projects: [projectRecord({ path: "/project" })],
        sessions: [
          sessionSummary({
            sessionId: "viewer",
            projectPath: "/project",
            workingDirectory: "/viewer",
          }),
        ],
        client: {
          projectSessions: { lookup },
          filesystem: { readImage },
          sessionChats: { inspect: async () => original, readAttachment },
        },
      });
      const session = fixture.root.sessionRegistry.load("viewer", "/viewer");
      session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
        kind: "top",
      });
      applyConversationUpdate(session.model, {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          sessionId: "viewer",
          sessionFile: "/viewer.jsonl",
          parts: projectSessionEntries(parent.getEntries()),
          models: [],
          thinkingLevel: "off",
          availableThinkingLevels: ["off"],
          streaming: false,
          diagnostics: [],
          commands: [],
          compatibility: { resources: [], diagnostics: [] },
          extensionUi: { statuses: [] },
          tree: [],
        },
      });
      const view = render(
        <Chat
          store={session.conversationSessionStore.chatStore}
          compact
          composerFocusEnabled={false}
        />,
      );
      const user = userEvent.setup();
      const disclosure = view.container.querySelector<HTMLButtonElement>(
        '[data-slot="response-disclosure"]',
      )!;
      expect(readImage).not.toHaveBeenCalled();
      expect(readAttachment).not.toHaveBeenCalled();
      for (let opening = 0; opening < 2; opening++) {
        await user.click(disclosure);
        expect(await screen.findByRole("heading", { name: "Image evidence" })).toBeTruthy();
        for (const name of [
          "Screenshot",
          "Absolute screenshot",
          "Linked attachment",
          attachment.name,
        ])
          expect((await screen.findByRole("img", { name })).getAttribute("src")).toMatch(
            /^data:image\/png;base64,/,
          );
        expect(await screen.findByText("Image not available: Missing")).toHaveProperty(
          "title",
          "Screenshot no longer exists",
        );
        expect(await screen.findByText("Image not available: Denied attachment")).toHaveProperty(
          "title",
          "Attachment unavailable or unauthorized",
        );
        expect(await screen.findByText("Image not available: Wrong session")).toHaveProperty(
          "title",
          "Image attachment must belong to the original session",
        );
        await user.click(disclosure);
        expect(screen.queryByRole("img", { name: "Screenshot" })).toBeNull();
      }
      const readsBeforeUnavailableSource = readImage.mock.calls.length;
      lookup.mockRejectedValue(new Error("Producer workspace unavailable"));
      await user.click(disclosure);
      expect(await screen.findByText("Image not available: Screenshot")).toHaveProperty(
        "title",
        "Producer workspace unavailable",
      );
      expect(readImage).toHaveBeenCalledTimes(readsBeforeUnavailableSource);
      expect(lookup).toHaveBeenCalledWith(
        { sessionId: source.getSessionId() },
        { signal: expect.any(AbortSignal) },
      );
      expect(readImage.mock.calls.every(([directory]) => directory === "/producer-worktree")).toBe(
        true,
      );
      expect(
        readAttachment.mock.calls.every(([request]) => request.sessionId === source.getSessionId()),
      ).toBe(true);
      expect(readAttachment.mock.calls.some(([request]) => request.reference === deniedId)).toBe(
        true,
      );
      view.unmount();
    },
  );

  it("persists only source metadata, lazily renders original formatting and pages without opening the producer", async () => {
    const source = SessionManager.inMemory("/producer");
    const originalText =
      "## Detailed result\n\n**Original substance**\n\n![source image](https://example.invalid/private.png)\n\n" +
      "x".repeat(20_000) +
      "\n\nFinal original detail";
    const entryId = source.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: originalText }],
      api: "openai-responses",
      provider: "openai",
      model: "fixture",
      timestamp: 1,
      usage,
      stopReason: "stop",
    });
    const full = readMessageReference(source, { entryId });
    const ref = full.message.ref;
    const read = vi.fn(async ({ ref: inputRef, maxChars }: { ref: string; maxChars?: number }) => {
      const target = messageNavigationTarget(inputRef);
      if (target.sessionId !== source.getSessionId()) throw new Error("Source inaccessible");
      return readMessageReference(source, { entryId: target.messageId, maxChars });
    });
    const operations = new CakeOperationRegistry(
      createMessageOperations({
        read,
        list: async () => {
          throw new Error("Unexpected list");
        },
        open: async () => {
          throw new Error("Presentation must not navigate");
        },
      }),
    );
    const result = await operations.invoke(
      { command: "messages.present", input: { ref } },
      {
        signal: new AbortController().signal,
        toolCallId: "present",
        runtime: { sessionId: "parent" },
      },
    );
    expect(read).toHaveBeenCalledWith({ ref, maxChars: 1 }, expect.any(AbortSignal));
    expect(JSON.stringify(result)).not.toContain("Original substance");

    const parent = SessionManager.inMemory("/project");
    parent.appendMessage({
      role: "toolResult",
      toolName: "cake",
      toolCallId: "present",
      content: result.content,
      details: result.details,
      isError: false,
      timestamp: 2,
    });
    parent.appendMessage({
      role: "user",
      timestamp: 3,
      content: encodeCrossSessionMessage(appendMessageReferences("Worker summary", [ref]), {
        version: 1,
        messageId: crypto.randomUUID(),
        threadId: crypto.randomUUID(),
        replyToMessageId: crypto.randomUUID(),
        sequence: 1,
        expectsResponse: false,
        sender: {
          sessionId: source.getSessionId(),
          title: "Delegated review",
          kind: "project-session",
        },
      }),
    });
    const parts = projectSessionEntries(parent.getEntries());
    expect(parts[0]).toMatchObject({ kind: "tool", messageReference: ref });
    expect(isWorkLogPart(parts[0]!)).toBe(false);
    const model = Message.create(messageSnapshots(parts, "parent")[0]);
    expect(model.update(parts[0]!)).toBe(true);
    expect(model.value).toMatchObject({ messageReference: ref });

    const inspect = vi.fn(
      async (request: { entryId?: string; offset?: number; maxChars?: number }) =>
        readMessageReference(source, request),
    );
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [
        sessionSummary({
          sessionId: "parent",
          projectPath: "/project",
          workingDirectory: "/project",
        }),
      ],
      client: { sessionChats: { inspect } },
    });
    const session = fixture.root.sessionRegistry.load("parent", "/project");
    session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
      kind: "top",
    });
    applyConversationUpdate(session.model, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId: "parent",
        sessionFile: "/parent.jsonl",
        parts,
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        streaming: false,
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
      },
    });
    const show = () =>
      render(
        <Chat
          store={session.conversationSessionStore.chatStore}
          compact
          composerFocusEnabled={false}
        />,
      );
    const user = userEvent.setup();
    let view = show();
    expect(inspect).not.toHaveBeenCalled();
    const delivered = screen.getByRole("region", { name: "Message from another session" });
    expect(delivered.textContent).toContain("Worker summary");
    expect(delivered.textContent).not.toContain("Referenced Cake messages");
    expect(delivered.textContent).not.toContain("messages.read");
    expect(delivered.textContent).not.toContain("Full original message");
    const message = within(delivered.closest("article")!);
    expect(
      message.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Delegated review", null, "Copy response"]);
    const original = () => screen.getByRole("button", { name: "Original response" });
    await user.click(message.getByRole("button", { name: "Copy response" }));
    expect(await navigator.clipboard.readText()).toBe("Worker summary");
    expect(inspect).not.toHaveBeenCalled();
    await user.click(original());
    expect(await screen.findByRole("heading", { name: "Detailed result" })).toBeTruthy();
    expect(screen.getByText("Original substance").getAttribute("data-streamdown")).toBe("strong");
    expect(await screen.findByRole("img", { name: "source image" })).toBeTruthy();
    expect(inspect).toHaveBeenLastCalledWith(
      expect.objectContaining({ entryId, maxChars: 20_000, offset: 0 }),
      expect.anything(),
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/Final original detail/)).toBeTruthy();
    expect(inspect).toHaveBeenLastCalledWith(
      expect.objectContaining({ entryId, offset: 20_000 }),
      expect.anything(),
    );
    // Copying from a later page still copies the whole original, not a truncated page.
    inspect.mockRejectedValueOnce(new Error("Source temporarily unavailable"));
    await user.click(screen.getByRole("button", { name: "Copy message" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not copy original message: Source temporarily unavailable",
    );
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy message" }));
    expect(await screen.findByRole("button", { name: "Copied message" })).toBeTruthy();
    expect(await navigator.clipboard.readText()).toBe(originalText);
    expect(screen.getByText(/Final original detail/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Detailed result" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    // A clipboard failure must not claim success or hide the original.
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("Clipboard unavailable"));
    await user.click(screen.getByRole("button", { name: "Copied message" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Clipboard unavailable"),
    );
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(screen.getByText(/Final original detail/)).toBeTruthy();
    write.mockRestore();
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByRole("heading", { name: "Detailed result" })).toBeTruthy();
    await user.click(original());
    view.unmount();
    // Reprojecting the persisted original tool result reconstructs the same reference.
    expect(projectSessionEntries(parent.getEntries())[0]).toMatchObject({ messageReference: ref });
    view = show();
    expect(original()).toBeTruthy();
    view.unmount();
  });

  it.each(["assistant", "reply", "protected", "notice", "notification"] as const)(
    "automatically presents the exact %s source once, without reading until expansion or sending a turn",
    async (delivery) => {
      const receipt = delivery === "protected" || delivery === "notice";
      const source = SessionManager.inMemory("/producer");
      const entryId = source.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "## Original report\n\n**Exact earlier result**" }],
        api: "openai-responses",
        provider: "openai",
        model: "fixture",
        timestamp: 1,
        usage,
        stopReason: "stop",
      });
      const ref = readMessageReference(source, { entryId }).message.ref;
      // The current/latest source is not the correlated result.
      source.appendMessage({
        role: "user",
        content: "A later unrelated source message",
        timestamp: 2,
      });
      const links = `[Review findings](${ref}) and [same original](${ref}).\n\n[Producer session](cake://session/${source.getSessionId()}) · [Website](https://example.com)`;
      const parent = SessionManager.inMemory("/project");
      if (delivery === "assistant") {
        parent.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: links }],
          api: "openai-responses",
          provider: "openai",
          model: "fixture",
          timestamp: 3,
          usage,
          stopReason: "stop",
        });
      } else {
        parent.appendMessage({
          role: "user",
          timestamp: 3,
          content:
            delivery === "reply" || receipt
              ? encodeCrossSessionMessage(
                  formatCrossSessionReportText(
                    source.getSessionId(),
                    "completed",
                    receipt ? appendMessageReferences(protectedResponseNotice, [ref]) : links,
                  ),
                  {
                    version: 1,
                    messageId: crypto.randomUUID(),
                    threadId: crypto.randomUUID(),
                    ...(delivery === "notice"
                      ? { generatedNotice: true }
                      : { replyToMessageId: crypto.randomUUID() }),
                    sequence: 1,
                    expectsResponse: false,
                    sender: {
                      sessionId: source.getSessionId(),
                      title: "Producer session",
                      kind: "project-session",
                    },
                  },
                )
              : `${formatSessionDigestReminder({
                  lines: [
                    {
                      reference: "worker",
                      sessionId: source.getSessionId(),
                      title: "Producer session",
                      summary: "Ready",
                      status: "completed",
                      resultMessageRef: ref,
                    },
                  ],
                  interruptedReport: false,
                })}\n\nMy next real question`,
        });
      }
      const parts = projectSessionEntries(parent.getEntries());
      const inspect = vi.fn(async (request: { sessionId: string; entryId?: string }) => {
        expect(request.sessionId).toBe(source.getSessionId());
        return readMessageReference(source, request);
      });
      using fixture = createRendererStoreFixture({
        projects: [projectRecord({ path: "/project" })],
        sessions: [
          sessionSummary({
            sessionId: "parent",
            projectPath: "/project",
            workingDirectory: "/project",
          }),
        ],
        client: { sessionChats: { inspect } },
      });
      const session = fixture.root.sessionRegistry.load("parent", "/project");
      session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
        kind: "top",
      });
      applyConversationUpdate(session.model, {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          sessionId: "parent",
          sessionFile: "/parent.jsonl",
          parts,
          models: [],
          thinkingLevel: "off",
          availableThinkingLevels: ["off"],
          streaming: false,
          diagnostics: [],
          commands: [],
          compatibility: { resources: [], diagnostics: [] },
          extensionUi: { statuses: [] },
          tree: [],
        },
      });
      const view = render(
        <Chat
          store={session.conversationSessionStore.chatStore}
          compact
          composerFocusEnabled={false}
        />,
      );
      expect(inspect).not.toHaveBeenCalled();
      const toggle = view.container.querySelector<HTMLButtonElement>(
        '[data-slot="session-message"] [data-slot="response-disclosure"]',
      )!;
      expect(toggle.getAttribute("aria-label")).toBe(
        delivery === "assistant" ? "Untitled session" : "Producer session",
      );
      // A reply keeps its own text open; its exact original sits behind a nested disclosure.
      expect(toggle.getAttribute("aria-expanded")).toBe(String(delivery === "reply"));
      const disclosure =
        delivery === "reply" ? screen.getByRole("button", { name: "Original response" }) : toggle;
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(view.container.querySelectorAll('[data-slot="session-message"]')).toHaveLength(1);
      expect(view.container.querySelectorAll('[data-slot="message-source"]')).toHaveLength(0);
      const user = userEvent.setup();
      if (receipt || delivery === "reply") {
        const delivered = screen.getByRole("region", {
          name:
            delivery === "notice" ? "Notice about another session" : "Message from another session",
        });
        expect(delivered.textContent).not.toContain("cake-session-message");
        expect(delivered.textContent).not.toContain("Referenced Cake messages");
        expect(delivered.textContent).not.toContain(protectedResponseNotice);
        const message = within(delivered.closest("article")!);
        if (receipt) {
          expect(within(delivered).getByRole("button", { name: "Producer session" })).toBe(
            disclosure,
          );
          expect(message.queryByRole("button", { name: "Copy response" })).toBeNull();
          expect(disclosure.textContent).toBe("Producer sessionCompleted");
        } else {
          expect(
            message.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
          ).toEqual(["Producer session", null, "Copy response"]);
          await user.click(message.getByRole("button", { name: "Copy response" }));
          expect(await navigator.clipboard.readText()).toBe(links);
        }
        expect(inspect).not.toHaveBeenCalled();
      }
      if (delivery === "assistant") {
        inspect.mockRejectedValueOnce(new Error("Source inaccessible"));
        inspect.mockResolvedValueOnce({
          ...readMessageReference(source, { entryId }),
          message: {
            ...readMessageReference(source, { entryId }).message,
            ref: ref + "-different",
          },
        });
      }
      await user.click(disclosure);
      if (delivery === "assistant") {
        expect((await screen.findByRole("alert")).textContent).toContain("Source inaccessible");
        expect(screen.queryByRole("heading", { name: "Original report" })).toBeNull();
        await user.click(screen.getByRole("button", { name: "Retry source" }));
        await waitFor(() =>
          expect(screen.getByRole("alert").textContent).toContain("different message or page"),
        );
        expect(screen.queryByRole("heading", { name: "Original report" })).toBeNull();
        await user.click(screen.getByRole("button", { name: "Retry source" }));
      }
      expect(await screen.findByRole("heading", { name: "Original report" })).toBeTruthy();
      expect(screen.getByText("Exact earlier result")).toBeTruthy();
      expect(screen.queryByText("A later unrelated source message")).toBeNull();
      expect(inspect).toHaveBeenCalledTimes(delivery === "assistant" ? 3 : 1);
      expect(inspect).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: source.getSessionId(),
          entryId,
          offset: 0,
          maxChars: 20_000,
        }),
        expect.anything(),
      );
      // Expansion/collapse creates no transcript entry or completion notice.
      await user.click(disclosure);
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("heading", { name: "Original report" })).toBeNull();

      await user.click(disclosure);
      expect(await screen.findByRole("heading", { name: "Original report" })).toBeTruthy();
      expect(inspect).toHaveBeenCalledTimes(delivery === "assistant" ? 3 : 1);
      await user.click(disclosure);
      expect(projectSessionEntries(parent.getEntries())).toEqual(parts);
      expect(view.container.querySelectorAll('[data-slot="session-message"]')).toHaveLength(1);
      if (delivery === "assistant") {
        expect(screen.getByRole("link", { name: "Producer session" }).getAttribute("href")).toBe(
          `cake://session/${source.getSessionId()}`,
        );
        expect(screen.getByRole("link", { name: "Website" }).getAttribute("href")).toBe(
          "https://example.com/",
        );
      }
      view.unmount();
    },
  );

  it.each(["ready", "unavailable", "empty", "missing"] as const)(
    "opens a title-only receipt lazily with honest %s content, including after reload",
    async (state) => {
      const source = SessionManager.inMemory("/producer");
      const report = state === "empty" ? "" : "Implemented compact To-do tools.";
      const entryId = source.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: report }],
        api: "openai-responses",
        provider: "openai",
        model: "fixture",
        timestamp: 1,
        usage,
        stopReason: "stop",
      });
      const ref = readMessageReference(source, { entryId }).message.ref;
      const title = "Implement compact To-do tools and metadata lifecycle contracts";
      const parent = SessionManager.inMemory("/project");
      parent.appendMessage({
        role: "user",
        timestamp: 3,
        content: encodeCrossSessionMessage(
          state === "missing"
            ? protectedResponseNotice
            : appendMessageReferences(protectedResponseNotice, [ref]),
          {
            version: 1,
            messageId: crypto.randomUUID(),
            threadId: crypto.randomUUID(),
            replyToMessageId: crypto.randomUUID(),
            sequence: 1,
            expectsResponse: false,
            sender: { sessionId: source.getSessionId(), title, kind: "project-session" },
          },
        ),
      });
      const inspect = vi.fn(async (request: { sessionId: string; entryId?: string }) => {
        expect(request).toMatchObject({ sessionId: source.getSessionId(), entryId });
        if (state === "unavailable") throw new Error("Exact original was removed");
        return readMessageReference(source, request);
      });
      const persisted = projectSessionEntries(parent.getEntries());
      for (let opening = 0; opening < 2; opening++) {
        using fixture = createRendererStoreFixture({
          projects: [projectRecord({ path: "/project" })],
          sessions: [
            sessionSummary({
              sessionId: "parent",
              projectPath: "/project",
              workingDirectory: "/project",
            }),
          ],
          client: { sessionChats: { inspect } },
        });
        const session = fixture.root.sessionRegistry.load("parent", "/project");
        session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition(
          { kind: "top" },
        );
        applyConversationUpdate(session.model, {
          _tag: "Snapshot",
          revision: 1,
          snapshot: {
            sessionId: "parent",
            sessionFile: "/parent.jsonl",
            parts: persisted,
            models: [],
            thinkingLevel: "off",
            availableThinkingLevels: ["off"],
            streaming: false,
            diagnostics: [],
            commands: [],
            compatibility: { resources: [], diagnostics: [] },
            extensionUi: { statuses: [] },
            tree: [],
          },
        });
        const view = render(
          <Chat
            store={session.conversationSessionStore.chatStore}
            compact
            composerFocusEnabled={false}
          />,
        );
        const card = screen.getByRole("region", { name: "Message from another session" });
        const reads = inspect.mock.calls.length;
        if (state === "missing") {
          expect(card.textContent).toContain("no exact source reference was recorded");
        } else {
          const trigger = within(card).getByRole("button", { name: title });
          expect(trigger.textContent).toBe(title);
          expect(trigger.getAttribute("aria-expanded")).toBe("false");
          expect(inspect).toHaveBeenCalledTimes(reads);
          const user = userEvent.setup();
          await user.click(trigger);
          if (state === "unavailable") {
            expect((await screen.findByRole("alert")).textContent).toContain(
              "Exact original was removed",
            );
            await user.click(screen.getByRole("button", { name: "Retry source" }));
            await waitFor(() => expect(inspect).toHaveBeenCalledTimes(reads + 2));
          } else {
            expect(await screen.findByText(report || "No textual content.")).toBeTruthy();
            expect(screen.getAllByText(report || "No textual content.")).toHaveLength(1);
          }
          await user.click(trigger);
          // Once read, the collapsed row previews the original after its one title.
          expect(trigger.textContent).toBe(
            `${title}${report && state !== "unavailable" ? report : ""}`,
          );
          expect(trigger.getAttribute("aria-expanded")).toBe("false");
        }
        expect(projectSessionEntries(parent.getEntries())).toEqual(persisted);
        view.unmount();
      }
    },
  );

  it("rejects missing, inaccessible and non-exact sources rather than falling back", async () => {
    const read = vi.fn(async () => {
      throw new Error("Original source inaccessible");
    });
    const operations = new CakeOperationRegistry(
      createMessageOperations({
        read,
        list: async () => null,
        open: async () => null,
      }),
    );
    const context = {
      signal: new AbortController().signal,
      toolCallId: "present",
      runtime: { sessionId: "parent" },
    };
    await expect(
      operations.invoke(
        { command: "messages.present", input: { ref: "cake://session/source" } },
        context,
      ),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    await expect(
      operations.invoke(
        { command: "messages.present", input: { ref: "cake://session/source?message=missing" } },
        context,
      ),
    ).rejects.toThrow("Original source inaccessible");
  });
});
