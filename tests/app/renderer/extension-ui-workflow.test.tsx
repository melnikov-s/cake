/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CakeEvent } from "../../../src/contracts/application/cake-rpc-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { toStoreEvent } from "../../../src/renderer/events/StoreEvent";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { checkpoint } from "../helpers/workflowFixture";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { applyExperimentalFeaturesProjection } from "../../../src/renderer/reducers/ExperimentalFeaturesReducer";

const requestId = "00000000-0000-4000-8000-000000000001";
const uiRequestId = "00000000-0000-4000-8000-000000000002";
type UiRequest = Extract<CakeEvent, { type: "ui-request" }>;

function renderExtensionUi(
  respondToUi: Client["artifacts"]["respondToUi"],
  withSession = false,
  dynamicWorkflows = false,
) {
  const fixture = createRendererStoreFixture({
    projects: withSession ? [projectRecord({ path: "/project", name: "Project" })] : [],
    sessions: withSession
      ? [sessionSummary({ sessionId: "session-1", projectPath: "/project" })]
      : [],
    client: {
      projectSessions: { open: async () => undefined },
      workspaces: { loadStagedSlashCommands: async () => [] },
      artifacts: { respondToUi, effective: async () => [] },
    },
  });
  let revision = 0;
  const setExperiments = (enabled: boolean) =>
    applyExperimentalFeaturesProjection(fixture.models.experimentalFeatures, {
      revision: ++revision,
      state: { ...defaultApplicationState(), experimentalFeatures: { dynamicWorkflows: enabled } },
    });
  setExperiments(dynamicWorkflows);
  if (withSession) {
    fixture.root.sessionRegistry.load("session-1", "/project");
    applyConversationUpdate(fixture.models.projectConversation("session-1", "/project"), {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId: "session-1",
        sessionFile: "/sessions/one.jsonl",
        parts: [],
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
    fixture.root.navigationStore.selectProjectSession("session-1");
    fixture.root.projectWorkbenchStore.showLoadedSession("session-1");
    fixture.root.sessionLayoutStore.ensureSession("session-1");
  }
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  async function publish(event: CakeEvent) {
    await act(async () => {
      const translated = toStoreEvent(event);
      if (!translated) throw new Error(`Unsupported extension event: ${event.type}`);
      fixture.root.extensionUiStore.receive(translated);
    });
  }
  return {
    user: userEvent.setup(),
    async setExperiments(enabled: boolean) {
      await act(async () => setExperiments(enabled));
    },
    publish,
    request(overrides: Partial<UiRequest> = {}) {
      return publish({
        type: "ui-request",
        requestId,
        uiRequestId,
        sessionId: "provider-settings:1",
        kind: "secret",
        title: "Provider authentication",
        message: "Enter your API key",
        ...overrides,
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

beforeEach(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    media: query,
    matches: query === "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

const response = (value: string | undefined, cancelled = false) => ({
  operationId: requestId,
  uiRequestId,
  sessionId: "provider-settings:1",
  value,
  cancelled,
});

describe("Extension UI workflow", () => {
  it("never displays a workflow dialog when disabled, while ordinary extension dialogs still work", async () => {
    const respond = vi.fn<Client["artifacts"]["respondToUi"]>(async () => undefined);
    using fixture = renderExtensionUi(respond, true);
    await fixture.request({
      kind: "workflow-choice",
      workflow: { ownerSessionId: "session-1", program: checkpoint().run.program },
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run workflow" })).toBeNull();
    expect(respond).not.toHaveBeenCalled();
    await fixture.request();
    expect(screen.getByRole("alertdialog", { name: "Provider authentication" })).toBeDefined();
  });
  it("hides an already displayed execution choice as soon as the authoritative feature projection turns off", async () => {
    const respond = vi.fn<Client["artifacts"]["respondToUi"]>(async () => undefined);
    using fixture = renderExtensionUi(respond, true, true);
    await fixture.request({
      kind: "workflow-choice",
      workflow: { ownerSessionId: "session-1", program: checkpoint().run.program },
    });
    expect(screen.getByRole("button", { name: "Run workflow" })).toBeDefined();
    await fixture.setExperiments(false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await fixture.publish({
      type: "ui-request-settled",
      uiRequestId,
      sessionId: "provider-settings:1",
    });
    await fixture.setExperiments(true);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(respond).not.toHaveBeenCalled();
  });
  for (const [label, value, cancelled] of [
    ["Run workflow", "workflow", false],
    ["Continue normally", "normal", false],
    ["Cancel", undefined, true],
  ] as const) {
    it(`shows frozen workflow source and phases, then returns ${label} exactly once`, async () => {
      const respond = vi.fn<Client["artifacts"]["respondToUi"]>(async () => undefined);
      using fixture = renderExtensionUi(respond, true, true);
      const program = {
        ...checkpoint().run.program,
        meta: {
          name: "audit-auth",
          description: "Audit the route authentication",
          phases: ["Inspect", "Report"],
        },
        args: { task: "audit" },
      };
      await fixture.request({
        kind: "workflow-choice",
        workflow: { ownerSessionId: "session-1", program },
      });
      expect(screen.getByRole("alertdialog", { name: "audit-auth" })).toBeDefined();
      expect(screen.getByText("Audit the route authentication")).toBeDefined();
      expect(screen.getByRole("list", { name: "Proposed phases" }).textContent).toBe(
        "InspectReport",
      );
      expect(respond).not.toHaveBeenCalled();
      await fixture.user.click(screen.getByRole("button", { name: "View script" }));
      for (const line of program.source.split("\n"))
        expect(
          screen.getByRole("region", { name: "Proposed workflow script" }).textContent,
        ).toContain(line);
      expect(respond).not.toHaveBeenCalled();
      await fixture.user.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(respond).toHaveBeenCalledExactlyOnceWith(response(value, cancelled));
    });
  }
  it("removes a cancelled workflow request from authority, but ignores settlement for a different request", async () => {
    const respond = vi.fn<Client["artifacts"]["respondToUi"]>(async () => undefined);
    using fixture = renderExtensionUi(respond, true, true);
    await fixture.request({
      kind: "workflow-choice",
      workflow: { ownerSessionId: "session-1", program: checkpoint().run.program },
    });
    await fixture.publish({
      type: "ui-request-settled",
      uiRequestId: requestId,
      sessionId: "provider-settings:1",
    });
    expect(screen.getByRole("button", { name: "Run workflow" })).toBeDefined();
    await fixture.publish({
      type: "ui-request-settled",
      uiRequestId,
      sessionId: "provider-settings:1",
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(respond).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
  });
  it("submits session-less provider credentials and dismisses the request", async () => {
    const respond = vi.fn<Client["artifacts"]["respondToUi"]>(async () => undefined);
    using fixture = renderExtensionUi(respond);
    await fixture.request();
    expect(screen.getByRole("alertdialog", { name: "Provider authentication" })).toBeDefined();
    expect(screen.getByText("Enter your API key")).toBeDefined();
    const input = screen.getByLabelText("Provider authentication", { selector: "input" });
    expect(input.getAttribute("type")).toBe("password");
    await fixture.user.type(input, "secret-key");
    await fixture.user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(respond).toHaveBeenCalledExactlyOnceWith(response("secret-key"));
  });

  it("returns selected option IDs and edited multiline text rather than presentation labels", async () => {
    const respond = vi.fn<Client["artifacts"]["respondToUi"]>(async () => undefined);
    using fixture = renderExtensionUi(respond);
    await fixture.request({
      kind: "select",
      title: "Deployment target",
      options: [
        { id: "staging", label: "Preview environment" },
        { id: "prod", label: "Production" },
      ],
    });
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Deployment target" }),
      "staging",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Continue" }));
    expect(respond).toHaveBeenLastCalledWith(response("staging"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await fixture.request({
      kind: "editor",
      title: "Release notes",
      initialValue: "Initial notes",
      multiline: true,
    });
    const editor = screen.getByRole("textbox", { name: "Release notes" });
    expect(editor.getAttribute("placeholder")).toBeNull();
    await fixture.user.clear(editor);
    await fixture.user.type(editor, "Summary\nChanges");
    await fixture.user.click(screen.getByRole("button", { name: "Continue" }));
    expect(respond).toHaveBeenLastCalledWith(response("Summary\nChanges"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it.each([
    ["Confirm", "true", false],
    ["Decline", "false", false],
    ["Cancel", undefined, true],
  ] as const)(
    "distinguishes %s from the other confirmation responses",
    async (action, value, cancelled) => {
      const respond = vi.fn<Client["artifacts"]["respondToUi"]>(async () => undefined);
      using fixture = renderExtensionUi(respond);
      await fixture.request({
        kind: "confirm",
        title: "Publish changes",
        message: "Publish this release?",
      });
      await fixture.user.click(screen.getByRole("button", { name: action }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(respond).toHaveBeenCalledExactlyOnceWith(response(value, cancelled));
    },
  );

  it("shows a failed response and accepts a subsequent request", async () => {
    const respond = vi
      .fn<Client["artifacts"]["respondToUi"]>()
      .mockRejectedValueOnce(new Error("Authentication service unavailable"))
      .mockResolvedValue(undefined);
    using fixture = renderExtensionUi(respond);
    await fixture.request({ kind: "text", title: "Account" });
    await fixture.user.type(screen.getByRole("textbox", { name: "Account" }), "first");
    await fixture.user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Authentication service unavailable");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await fixture.request({ kind: "manual_code", title: "Verification code" });
    await fixture.user.type(screen.getByRole("textbox", { name: "Verification code" }), "123456");
    await fixture.user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.queryByText("Authentication service unavailable")).toBeNull(),
    );
    expect(respond).toHaveBeenLastCalledWith(response("123456"));
  });

  it("applies editor intents only to the active composer and dismisses extension notifications", async () => {
    using fixture = renderExtensionUi(async () => undefined, true);
    const composer = screen.getByRole("combobox", { name: "Message" });
    await fixture.user.type(composer, "existing");
    await fixture.publish({
      type: "extension-ui-intent",
      sessionId: "session-1",
      intent: { kind: "editor-text", text: " appended", mode: "insert" },
    });
    await fixture.publish({
      type: "extension-ui-intent",
      sessionId: "other",
      intent: { kind: "editor-text", text: "wrong", mode: "replace" },
    });
    expect(screen.getByDisplayValue("existing appended")).toBe(composer);
    await fixture.publish({
      type: "extension-ui-intent",
      sessionId: "session-1",
      intent: { kind: "notify", id: "notice", message: "Connected", tone: "info" },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Extension Connected" }));
    expect(screen.queryByText("Connected")).toBeNull();
  });
});
