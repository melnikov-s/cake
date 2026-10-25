/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { InterviewRecord, InterviewResult } from "../../../src/contracts/interviews/interview";
import type { Client } from "../../../src/renderer/client/Client";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { Interview } from "../../../src/renderer/components/interview";
import { BlockingInterviews } from "../../../src/renderer/components/blocking-interviews";
import { TranscriptPart } from "../../../src/renderer/components/chat-transcript-part";
import { applyPartUpdate } from "../../../src/renderer/reducers/SessionPartReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import type { TestClientOverrides } from "./test-client";

function interview(id = "call-1", sessionId = "session"): InterviewRecord {
  return {
    id,
    sessionId,
    request: {
      protocol: "cake.request/v1",
      id: "same-readable-id",
      title: "Interview",
      responseSchema: { type: "object" },
      view: {
        type: "form",
        fields: [
          {
            id: "region",
            label: "Region",
            type: "select",
            options: [
              { value: "us", label: "US" },
              { value: "eu", label: "EU" },
            ],
          },
          { id: "name", label: "Name", type: "text" },
          { id: "notes", label: "Notes", type: "textarea" },
          { id: "count", label: "Count", type: "number" },
          { id: "enabled", label: "Enabled", type: "checkbox" },
        ],
      },
      fallback: { markdown: "Answer these questions." },
    },
  };
}

function setup(client: TestClientOverrides = {}) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/work/cake" })],
    sessions: [
      sessionSummary({ sessionId: "session", projectPath: "/work/cake" }),
      sessionSummary({ sessionId: "other-session", projectPath: "/work/cake" }),
    ],
    client,
  });
  const session = fixture.root.sessionRegistry.load("session", "/work/cake");
  const receive = (record: InterviewRecord) =>
    session.receive({
      type: "interview-requested",
      operationId: "operation",
      interviewRequestId: "request",
      record,
    });
  const project = (record: InterviewRecord, result?: InterviewResult) =>
    applyPartUpdate(
      session.model.parts,
      {
        id: `tool-${record.id}`,
        kind: "tool",
        name: "cake",
        command: "interview.open",
        input: "",
        state: result ? "success" : "running",
        interview: record,
        interviewResult: result,
      },
      session.sessionId,
    );
  const user = userEvent.setup();
  return {
    ...fixture,
    session,
    receive,
    project,
    user,
    click: (name: string) => user.click(screen.getByRole("button", { name })),
    [Symbol.dispose]() {
      fixture[Symbol.dispose]();
    },
  };
}
const responder = () => vi.fn<Client["interviews"]["respond"]>(async () => {});
afterEach(cleanup);

it("restores all answers, blank Other selection, and review step after unmount, with distinct invocation and session identities", async () => {
  const respond = responder();
  using fixture = setup({ interviews: { respond } });
  const record = interview();
  fixture.receive(record);
  fixture.project(record);
  const surface = () => (
    <TranscriptPart
      part={fixture.session.canonicalParts[0]!}
      behavior={{
        store: fixture.session.conversationSessionStore.chatStore,
        interviews: fixture.session.conversationSessionStore.interviewStore.interviews,
      }}
    />
  );
  const view = render(surface());
  const remount = () => {
    view.rerender(null);
    view.rerender(surface());
  };
  try {
    await fixture.user.click(screen.getByRole("radio", { name: "Other" }));
    remount();
    expect((screen.getByRole("radio", { name: "Other" }) as HTMLInputElement).checked).toBe(true);
    await fixture.user.type(
      screen.getByRole("textbox", { name: "Region other option" }),
      "Pacific",
    );
    await fixture.click("Next");
    await fixture.user.type(screen.getByRole("textbox", { name: "Name" }), "Cake");
    remount();
    expect(screen.getByText("Question 2 of 5")).toBeDefined();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLTextAreaElement).value).toBe(
      "Cake",
    );
    await fixture.click("Next");
    await fixture.user.type(screen.getByRole("textbox", { name: "Notes" }), "Keep my notes");
    await fixture.click("Next");
    await fixture.user.type(screen.getByRole("spinbutton", { name: "Count" }), "7");
    await fixture.click("Next");
    await fixture.user.click(screen.getByRole("checkbox", { name: "Enabled" }));
    await fixture.click("Review");
    remount();
    for (const text of ["Review answers", "Pacific", "Keep my notes", "7", "Yes"])
      expect(screen.getByText(text)).toBeDefined();
    expect(respond).not.toHaveBeenCalled();

    const otherRecord = interview("call-2");
    act(() => {
      fixture.receive(otherRecord);
      fixture.project(otherRecord);
    });
    const otherSession = fixture.root.sessionRegistry.load("other-session", "/work/cake");
    const sameCallInOtherSession = interview("call-1", "other-session");
    otherSession.receive({
      type: "interview-requested",
      operationId: "other-operation",
      interviewRequestId: "other-request",
      record: sameCallInOtherSession,
    });
    for (const other of [
      fixture.session.conversationSessionStore.interviewStore.find("call-2")!,
      otherSession.conversationSessionStore.interviewStore.find("call-1")!,
    ]) {
      view.rerender(<Interview store={other} />);
      expect(screen.getByText("Question 1 of 5")).toBeDefined();
      expect((screen.getByRole("radio", { name: "US" }) as HTMLInputElement).checked).toBe(true);
    }
    view.rerender(null);
    view.rerender(surface());
    await fixture.click("Submit");
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        value: { region: "Pacific", name: "Cake", notes: "Keep my notes", count: 7, enabled: true },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    remount();
    expect(screen.getByText("Submitted")).toBeDefined();
    expect(respond).toHaveBeenCalledTimes(1);
    const completed = fixture.session.conversationSessionStore.interviewStore.find(record.id)!;
    expect(completed.values).toEqual({});
    expect(completed.customRows.size).toBe(0);
    expect(completed.step).toBe(0);
  } finally {
    view.unmount();
  }
});

it("moves a live interview from its fallback into the projected tool without losing input or its step", async () => {
  using fixture = setup();
  const record = interview();
  fixture.receive(record);
  const surface = () => (
    <>
      <BlockingInterviews
        interviews={fixture.session.conversationSessionStore.interviewStore.interviews}
        parts={fixture.session.canonicalParts}
        inlineWidgets={fixture.root.inlineWidgetStore}
      />
      {fixture.session.canonicalParts.map((part) => (
        <TranscriptPart
          key={part.id}
          part={part}
          behavior={{
            store: fixture.session.conversationSessionStore.chatStore,
            interviews: fixture.session.conversationSessionStore.interviewStore.interviews,
          }}
        />
      ))}
    </>
  );
  const view = render(surface());
  try {
    await fixture.click("Next");
    await fixture.user.type(screen.getByRole("textbox", { name: "Name" }), "Retain me");
    act(() => fixture.project(record));
    view.rerender(surface());
    expect(view.container.querySelectorAll("[data-interview-id]")).toHaveLength(1);
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLTextAreaElement).value).toBe(
      "Retain me",
    );
    expect(screen.getByText("Question 2 of 5")).toBeDefined();
  } finally {
    view.unmount();
  }
});

it("preserves editable answers on failure and prevents duplicate submissions while a response is pending", async () => {
  let reject!: (error: Error) => void;
  const respond = responder().mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  using fixture = setup({ interviews: { respond } });
  const record = interview();
  fixture.receive(record);
  fixture.project(record);
  const view = render(
    <Interview store={fixture.session.conversationSessionStore.interviewStore.find(record.id)!} />,
  );
  try {
    await fixture.click("Next");
    await fixture.user.type(screen.getByRole("textbox", { name: "Name" }), "Keep this on failure");
    await fixture.user.click(screen.getByRole("button", { name: "Review answers" }));
    await fixture.click("Submit");
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => reject(new Error("Try again")));
    expect(screen.getByText("Try again")).toBeDefined();
    expect(
      fixture.session.conversationSessionStore.interviewStore.find(record.id)!.values.name,
    ).toBe("Keep this on failure");
    expect(fixture.session.conversationSessionStore.interviewStore.find(record.id)!.step).toBe(5);
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await fixture.click("Submit");
    await waitFor(() => expect(screen.getByText("Submitted")).toBeDefined());
    expect(respond).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
  }
});

it("renders historical submitted answers from the authoritative projection without a live request", () => {
  using fixture = setup();
  const record = interview();
  fixture.project(record, {
    interviewId: record.id,
    cancelled: false,
    value: { region: "eu", name: "From history" },
  });
  const view = render(
    <Interview store={fixture.session.conversationSessionStore.interviewStore.find(record.id)!} />,
  );
  try {
    expect(screen.getByText("Submitted")).toBeDefined();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLTextAreaElement).value).toBe(
      "From history",
    );
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLTextAreaElement).disabled).toBe(
      true,
    );
  } finally {
    view.unmount();
  }
});

it("skips a live interview with an explicit cancellation", async () => {
  const respond = responder();
  using fixture = setup({ interviews: { respond } });
  const record = interview();
  fixture.receive(record);
  fixture.project(record);
  const view = render(
    <Interview store={fixture.session.conversationSessionStore.interviewStore.find(record.id)!} />,
  );
  try {
    await fixture.click("Skip");
    await waitFor(() => expect(screen.getByText("Skipped")).toBeDefined());
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ cancelled: true }),
      expect.anything(),
    );
  } finally {
    view.unmount();
  }
});

it("disposes interview children when their owning session is removed, not when the view unmounts", () => {
  using fixture = setup();
  const record = interview();
  fixture.receive(record);
  fixture.project(record);
  const store = fixture.session.conversationSessionStore.interviewStore.find(record.id)!;
  const view = render(<Interview store={store} />);
  view.unmount();
  expect(store.signal.aborted).toBe(false);
  fixture.root.sessionRegistry.removeSession(record.sessionId);
  expect(store.signal.aborted).toBe(true);
});

it("disposes an invocation removed from the transcript and clears correlations when its tool settles", () => {
  using fixture = setup();
  const record = interview();
  fixture.receive(record);
  fixture.project(record);
  const store = fixture.session.conversationSessionStore.interviewStore.find(record.id)!;
  const view = render(<Interview store={store} />);
  expect(fixture.session.activity).toBe("waiting");
  act(() =>
    applyPartUpdate(
      fixture.session.model.parts,
      {
        id: `tool-${record.id}`,
        kind: "tool",
        name: "cake",
        command: "interview.open",
        input: "",
        state: "interrupted",
        interview: record,
      },
      fixture.session.sessionId,
    ),
  );
  expect(fixture.session.conversationSessionStore.interviewStore.waiting).toBe(false);
  expect(store.requested).toBe(false);
  view.unmount();
  fixture.session.model.parts = [];
  expect(fixture.session.conversationSessionStore.interviewStore.interviews).toHaveLength(0);
  expect(store.signal.aborted).toBe(true);
});

it("delivers an unanswered historical interview as ordinary conversation input, not an expired RPC response", async () => {
  const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
    TurnId.make("00000000-0000-4000-8000-000000000001"),
  );
  const respond = responder();
  using fixture = setup({ sessionChats: { prompt }, interviews: { respond } });
  const record = interview();
  fixture.project(record);
  const view = render(
    <Interview store={fixture.session.conversationSessionStore.interviewStore.find(record.id)!} />,
  );
  try {
    await fixture.user.click(screen.getByRole("button", { name: "Review answers" }));
    await fixture.click("Submit");
    await waitFor(() => expect(screen.getByText("Submitted")).toBeDefined());
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session",
        text: expect.stringContaining('"region":"us"'),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(respond).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it("accepts only the sandbox's token-bound submission for a widget interview", async () => {
  const token = "00000000-0000-4000-8000-000000000001";
  const respond = responder();
  const compile = vi.fn(async () => ({ token, url: `cake-widget://document/${token}` }));
  using fixture = setup({ interviews: { respond }, inlineWidgets: { compile } });
  const baseRecord = interview();
  const record: InterviewRecord = {
    ...baseRecord,
    request: {
      ...baseRecord.request,
      view: { type: "widget", language: "html", source: "<button>Choose</button>" },
    },
  };
  fixture.receive(record);
  fixture.project(record);
  const view = render(
    <Interview
      store={fixture.session.conversationSessionStore.interviewStore.find(record.id)!}
      inlineWidgets={fixture.root.inlineWidgetStore}
    />,
  );
  try {
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    const send = (token: string) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { source: "cake-inline-widget", token, type: "submit", value: { choice: "yes" } },
        }),
      );
    act(() => send("wrong-token"));
    expect(respond).not.toHaveBeenCalled();
    await act(async () => {
      send(token);
    });
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ value: { choice: "yes" } }),
      expect.anything(),
    );
    expect(compile).toHaveBeenCalledWith("html", "<button>Choose</button>", "request");
  } finally {
    view.unmount();
  }
});
