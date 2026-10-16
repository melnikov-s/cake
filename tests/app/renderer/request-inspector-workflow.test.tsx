/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type {
  RequestInspectionEntry,
  RequestInspectionPayload,
  RequestInspectionResult,
} from "../../../src/contracts/conversations/request-inspection";
import { RequestInspector } from "../../../src/renderer/components/request-inspector";
import { SidebarCakeChatGroup } from "../../../src/renderer/components/sidebar-cake-chat-group";
import type { Client } from "../../../src/renderer/client/Client";
import type { RootStore } from "../../../src/renderer/stores/RootStore";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const Surface = observer(function Surface({ root }: { root: RootStore }) {
  const chat = root.cakeChatCollectionStore.activeSession;
  return (
    <>
      <SidebarCakeChatGroup
        cakeChat={root.cakeChatCollectionStore}
        shell={root.appShellStore}
        onOpenCakeChat={(id) => void root.navigationStore.openCakeChat(id)}
      />
      {chat && <RequestInspector store={chat.requestInspectorStore} />}
    </>
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const empty = {
  history: { entries: [], evicted: 0, maxEntries: 40, maxBytes: 67108864 },
} satisfies RequestInspectionResult;
function capture(
  raw: string,
  overrides: Partial<RequestInspectionEntry> = {},
): RequestInspectionPayload {
  return {
    raw,
    entry: {
      id: "request-1",
      callId: "call-1",
      sessionId: CAKE_CHAT_SESSION_ID,
      capturedAt: "2026-04-01T12:00:00Z",
      provider: "fixture",
      modelId: "fixture",
      api: "openai-completions",
      purpose: "coordinator",
      boundary: "http-body",
      state: "completed",
      attempt: 1,
      ...(overrides.boundary === "provider-payload" ? {} : { status: 200 }),
      byteSize: new TextEncoder().encode(raw).byteLength,
      settings: '{"temperature":0.2}',
      ...overrides,
    },
  };
}
function reader(captures: () => readonly RequestInspectionPayload[]) {
  return vi.fn<Client["cakeChats"]["requestInspection"]>(async (input) => {
    const records = captures();
    const history = { ...empty.history, entries: records.map((record) => record.entry) };
    if (input.action === "history") return { history };
    if (input.action !== "payload") throw new Error("Inspector reads must not mutate history");
    const payload = records.find((record) => record.entry.id === input.id);
    if (!payload) throw new Error("Capture not found");
    return { history, payload };
  });
}

it("reads the newest immutable request as complete literal context and copies its original serialized bytes", async () => {
  const long = `<instructions>\n${"Long context. ".repeat(6000)}NEEDLE_AT_END\n</instructions>`;
  const image =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=";
  const remote = "https://example.invalid/private-image.png";
  const raw =
    JSON.stringify({
      model: "fixture",
      messages: [
        { role: "system", content: long },
        {
          role: "user",
          content: [
            { type: "text", text: "Literal **text** and <tags>." },
            { type: "image_url", image_url: { url: image, detail: "auto" } },
            { type: "image_url", image_url: { url: remote } },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "fixture-cake-tool",
            parameters: { type: "object", properties: { command: { type: "string" } } },
          },
        },
      ],
      vendor_context: { unknown: "Unknown fields remain readable" },
      ["__proto__"]: { context: "Prototype-named fields remain readable" },
    }) + "\r\n\n";
  const latest = capture(raw);
  const older = capture('{"messages":[{"role":"user","content":"Older context"}]}', {
    id: "older",
    callId: "older-call",
  });
  const inspect = reader(() => [older, latest]);
  using fixture = createRendererStoreFixture({
    client: { cakeChats: { requestInspection: inspect } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [] });
  const user = userEvent.setup();
  const view = render(<Surface root={fixture.root} />);
  try {
    await user.click(screen.getByRole("button", { name: /^Cake Chat$/ }));
    await user.click(screen.getByRole("button", { name: "Inspect context" }));
    expect((await screen.findByText(long, { normalizer: (text) => text })).textContent).toBe(long);
    expect(screen.getByText("Literal **text** and <tags>.").textContent).toBe(
      "Literal **text** and <tags>.",
    );
    expect(screen.getByRole("img", { name: "Context image" }).getAttribute("src")).toBe(image);
    expect(screen.getByText(remote).textContent).toBe(remote);
    expect(inspect.mock.calls.slice(0, 2).map(([input]) => input)).toEqual([
      { sessionId: CAKE_CHAT_SESSION_ID, action: "history" },
      { sessionId: CAKE_CHAT_SESSION_ID, action: "payload", id: latest.entry.id },
    ]);
    await user.click(screen.getByRole("button", { name: "Tools" }));
    expect(screen.getByText("fixture-cake-tool")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Parameters" }));
    expect(screen.getByText("Unknown fields remain readable")).toBeTruthy();
    expect(screen.getByText("Prototype-named fields remain readable")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy raw context" }));
    await screen.findByText("Raw context copied");
    expect(await navigator.clipboard.readText()).toBe(raw);
    expect(fixture.root.cakeChatCollectionStore.activeSession?.model.uiParts).toHaveLength(0);
  } finally {
    view.unmount();
  }
});

it("automatically follows later calls, avoids rereading unchanged bodies, and stops reading when closed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let records = [capture('{"messages":[{"role":"user","content":"First context"}]}')];
  const inspect = reader(() => records);
  using fixture = createRendererStoreFixture({
    client: { cakeChats: { requestInspection: inspect } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [] });
  // Install the clipboard stub; clock-driven UI actions avoid user-event's async timer wrapper.
  userEvent.setup();
  const view = render(<Surface root={fixture.root} />);
  try {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Cake Chat$/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Inspect context" }));
    });
    expect(screen.getByText("First context")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(inspect.mock.calls.filter(([input]) => input.action === "payload")).toHaveLength(1);
    const raw = '{"messages":[{"role":"user","content":"Newest memory-summary context"}]}\n';
    records = [
      ...records,
      capture(raw, { id: "summary", callId: "summary-call", purpose: "memory-summary" }),
    ];
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText("Newest memory-summary context")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy raw context" }));
    });
    expect(await navigator.clipboard.readText()).toBe(raw);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });
    const count = inspect.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(inspect).toHaveBeenCalledTimes(count);
  } finally {
    view.unmount();
  }
});

it("recovers from an inspection read error on reopening without invoking a model", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<RequestInspectionResult>((_resolve, fail) => {
    reject = fail;
  });
  const inspect = vi
    .fn<Client["cakeChats"]["requestInspection"]>()
    .mockReturnValueOnce(pending)
    .mockResolvedValue(empty);
  using fixture = createRendererStoreFixture({
    client: { cakeChats: { requestInspection: inspect } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [] });
  const user = userEvent.setup();
  const view = render(<Surface root={fixture.root} />);
  try {
    await user.click(screen.getByRole("button", { name: /^Cake Chat$/ }));
    await user.click(screen.getByRole("button", { name: "Inspect context" }));
    expect(screen.getByText("Loading context…")).toBeTruthy();
    reject(new Error("Captured request unavailable"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Captured request unavailable",
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Inspect context" }));
    await screen.findByText("No captured context yet.");
    expect(inspect).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
  }
});

it("invalidates a pending read on close and keeps a reopened unavailable capture from being replaced by the late body", async () => {
  let finish!: (result: RequestInspectionResult) => void;
  const pending = new Promise<RequestInspectionResult>((resolve) => {
    finish = resolve;
  });
  const old = capture('{"messages":[{"role":"user","content":"Stale payload"}]}');
  const unavailable = {
    entry: {
      ...old.entry,
      id: "oversized",
      callId: "oversized-call",
      byteSize: empty.history.maxBytes + 1,
      limitation: "Full body exceeds local retention limit and was not retained",
    },
  };
  const history = { ...empty.history, entries: [unavailable.entry] };
  const inspect = vi
    .fn<Client["cakeChats"]["requestInspection"]>()
    .mockResolvedValueOnce({ history: { ...empty.history, entries: [old.entry] } })
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce({ history })
    .mockResolvedValue({ history, payload: unavailable });
  using fixture = createRendererStoreFixture({
    client: { cakeChats: { requestInspection: inspect } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [] });
  const user = userEvent.setup();
  const view = render(<Surface root={fixture.root} />);
  try {
    await user.click(screen.getByRole("button", { name: /^Cake Chat$/ }));
    await user.click(screen.getByRole("button", { name: "Inspect context" }));
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(inspect.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    await user.click(screen.getByRole("button", { name: "Inspect context" }));
    await screen.findByText(unavailable.entry.limitation);
    await act(async () =>
      finish({ history: { ...empty.history, entries: [old.entry] }, payload: old }),
    );
    expect(screen.getByRole("button", { name: "Copy raw context" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText(unavailable.entry.limitation)).toBeTruthy();
  } finally {
    view.unmount();
  }
});

it.each([
  {
    name: "Wrapped intermediate",
    entry: {
      api: "fixture-wrapped",
      boundary: "provider-payload" as const,
      attempt: 0,
      limitation: "Only a prepared envelope was observable",
    },
    body: { request: { instructions: "Provider instructions", message: "Provider user text" } },
  },
  {
    name: "Anthropic HTTP",
    entry: { api: "anthropic-messages" },
    body: {
      messages: [{ role: "user", content: [{ type: "text", text: "Provider user text" }] }],
      system: [{ type: "text", text: "Provider instructions" }],
    },
  },
  {
    name: "Google intermediate",
    entry: {
      api: "google-generative-ai",
      boundary: "provider-payload" as const,
      attempt: 0,
      limitation: "Only a provider payload was observable",
    },
    body: {
      systemInstruction: { parts: [{ text: "Provider instructions" }] },
      contents: [{ role: "user", parts: [{ text: "Provider user text" }] }],
    },
  },
  {
    name: "Responses HTTP",
    entry: { api: "openai-responses" },
    body: {
      instructions: "Provider instructions",
      input: [
        { role: "developer", content: [{ type: "input_text", text: "Developer context" }] },
        { role: "user", content: [{ type: "input_text", text: "Provider user text" }] },
        {
          type: "function_call",
          name: "Unknown record retained",
          arguments: '{"query":"literal arguments"}',
        },
      ],
    },
  },
])("reads $name bodies without hiding provider-specific content", async ({ entry, body }) => {
  const raw = JSON.stringify(body);
  const inspect = reader(() => [capture(raw, entry)]);
  using fixture = createRendererStoreFixture({
    client: { cakeChats: { requestInspection: inspect } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [] });
  const user = userEvent.setup();
  const view = render(<Surface root={fixture.root} />);
  try {
    await user.click(screen.getByRole("button", { name: /^Cake Chat$/ }));
    await user.click(screen.getByRole("button", { name: "Inspect context" }));
    await screen.findByText("Provider instructions");
    expect(screen.getByText("Provider user text")).toBeTruthy();
    const headings = Array.from(
      document.querySelectorAll('[data-slot="readable-data"] > button'),
    ).map((button) => button.textContent);
    if ("request" in body) expect(headings).toEqual(["Content"]);
    else expect(headings.indexOf("Instructions")).toBeLessThan(headings.indexOf("Your message"));
    if (entry.limitation)
      await screen.findByText(/Intermediate capture, not the exact outbound request/);
    if ("input" in body) {
      expect(screen.getByText("Developer context")).toBeTruthy();
      expect(screen.getByText("Unknown record retained")).toBeTruthy();
      expect(screen.getByText('{"query":"literal arguments"}')).toBeTruthy();
    }
    await user.click(screen.getByRole("button", { name: "Copy raw context" }));
    expect(await navigator.clipboard.readText()).toBe(raw);
  } finally {
    view.unmount();
  }
});

it("reports clipboard failure while keeping readable context available for a successful retry", async () => {
  const raw = '{"messages":[{"role":"user","content":"Context still readable"}]}';
  const inspect = reader(() => [capture(raw)]);
  using fixture = createRendererStoreFixture({
    client: { cakeChats: { requestInspection: inspect } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [] });
  const user = userEvent.setup();
  const view = render(<Surface root={fixture.root} />);
  try {
    await user.click(screen.getByRole("button", { name: /^Cake Chat$/ }));
    await user.click(screen.getByRole("button", { name: "Inspect context" }));
    await screen.findByText("Context still readable");
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(
      new Error("Clipboard unavailable"),
    );
    await user.click(screen.getByRole("button", { name: "Copy raw context" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Clipboard unavailable");
    expect(screen.getByText("Context still readable")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy raw context" }));
    await screen.findByText("Raw context copied");
    expect(await navigator.clipboard.readText()).toBe(raw);
  } finally {
    view.unmount();
  }
});
