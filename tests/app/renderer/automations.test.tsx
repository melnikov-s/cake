/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreProvider } from "r-state-tree/react";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import {
  AutomationOccurrenceId,
  AutomationRunId,
  type Automation,
  type AutomationDefinition,
} from "../../../src/contracts/automations/automation-data";
import type { AutomationInspection } from "../../../src/contracts/automations/automation-control";
import {
  TurnId,
  type ConversationUpdate,
} from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { applyAutomationCatalogUpdate } from "../../../src/renderer/reducers/AutomationReducer";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";
import {
  projectRecord,
  sessionSummary,
  type SessionSummaryFixture,
} from "./fixtures/catalog-fixtures";
import {
  automation,
  automationDefinition,
  automationId,
  automationOccurrence,
  automationRun,
  automationSession,
  automationSummary,
  occurrenceId,
  secondAutomationId,
} from "./fixtures/automation-fixtures";

const projectPath = "/work/cake";
const conversationUpdate = (sessionId: string, streaming = false): ConversationUpdate => ({
  _tag: "Snapshot",
  revision: 1,
  snapshot: {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts: [
      { id: "reply", kind: "text", role: "assistant", text: "Review complete", status: "complete" },
    ],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: [],
    streaming,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  },
});
function setup(
  options: {
    client?: TestClientOverrides;
    unresolved?: boolean;
    second?: boolean;
    activity?: { runningSessions: number; queuedOccurrences: number };
    sessions?: readonly SessionSummaryFixture[];
  } = {},
) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: projectPath, name: "Cake" })],
    sessions: options.sessions,
    client: {
      ...options.client,
      automations: {
        inspect: async ({ automationId: id }) => ({
          automation: automation({ id }),
          activity: { runningSessions: 2, queuedOccurrences: 3 },
        }),
        ...options.client?.automations,
      },
    },
  });
  const { root, models } = fixture;
  root.settingsStore.applyApplicationState(1, {
    ...defaultApplicationState(),
    modelPresets: [
      {
        id: "50000000-0000-4000-8000-000000000001",
        name: "Test",
        provider: "test",
        modelId: "test",
        thinkingLevel: "off",
        fastMode: false,
      },
    ],
    defaultModelPresetId: "50000000-0000-4000-8000-000000000001",
  });
  applyAutomationCatalogUpdate(models.automations, {
    _tag: "Snapshot",
    snapshot: {
      revision: 1,
      automations: [
        automationSummary(
          options.activity
            ? { activity: options.activity }
            : options.unresolved === false
              ? { activity: { runningSessions: 0, queuedOccurrences: 0 } }
              : {},
        ),
        ...(options.second
          ? [
              automationSummary({
                id: secondAutomationId,
                name: "Project review",
                context: { _tag: "Project", projectPath },
                state: { _tag: "suspended", reason: "Project is no longer registered" },
                activity: { runningSessions: 0, queuedOccurrences: 1 },
              }),
            ]
          : []),
      ],
      unresolvedSessions:
        options.unresolved === false
          ? []
          : [
              automationSession({ running: false }),
              automationSession({
                identity: {
                  ...automationSession().identity,
                  sessionId: "automation-run-2",
                  runId: AutomationRunId.make("20000000-0000-4000-8000-000000000002"),
                },
              }),
              automationSession({
                identity: {
                  ...automationSession().identity,
                  sessionId: "automation-run-3",
                  runId: AutomationRunId.make("20000000-0000-4000-8000-000000000003"),
                },
              }),
            ],
    },
  });
  root.navigationStore.showAutomations();
  const view = render(
    <>
      <StoreProvider store={root}>
        <App />
      </StoreProvider>
    </>,
  );
  return {
    ...fixture,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
const table = () => screen.getByRole("table", { name: "Automations" });
async function openDefinition(user: ReturnType<typeof userEvent.setup>, name = "Daily review") {
  await user.click(within(table()).getByRole("button", { name }));
  await screen.findByRole("textbox", { name: "Automation name" });
}
afterEach(cleanup);

describe("automation product workflows", () => {
  it("opens the global hub, distinguishes activity counts, and filters project/lifecycle with suspension reasons", async () => {
    using fixture = setup({ second: true });
    expect(screen.getByLabelText("Automation totals").textContent).toBe(
      "1 automations running2 active sessions4 queued occurrences",
    );
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by project" }),
      projectPath,
    );
    expect(within(table()).queryByRole("button", { name: "Daily review" })).toBeNull();
    expect(within(table()).getByText("Project is no longer registered")).toBeTruthy();
    await fixture.user.click(screen.getByRole("button", { name: "Active" }));
    expect(screen.getByText("No matching automations.")).toBeTruthy();
    await fixture.user.click(screen.getByRole("button", { name: "Suspended" }));
    expect(within(table()).getByRole("button", { name: "Project review" })).toBeTruthy();
    expect(fixture.models.sessionCatalog.sessions).toHaveLength(0);
  });

  it("cancels creation, discards the draft, and returns to the list", async () => {
    const create = vi.fn<Client["automations"]["create"]>();
    const update = vi.fn<Client["automations"]["update"]>();
    using fixture = setup({ client: { automations: { create, update } } });
    await fixture.user.click(screen.getByRole("button", { name: "New automation" }));
    const name = screen.getByRole("textbox", { name: "Automation name" });
    await fixture.user.clear(name);
    await fixture.user.type(name, "Discard this automation");
    await fixture.user.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(within(table()).getByRole("button", { name: "Daily review" })).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    await fixture.user.click(screen.getByRole("button", { name: "New automation" }));
    expect(screen.getByRole("textbox", { name: "Automation name" })).toHaveProperty(
      "value",
      "New automation",
    );
    expect(screen.getByRole("combobox", { name: "Project" })).toBeTruthy();
  });

  it("creates with project-bound event filters, a shared prompt composer and visible run choices", async () => {
    let saved: Automation | undefined;
    const create = vi.fn<Client["automations"]["create"]>(async ({ definition, initialState }) => {
      saved = automation({ definition, state: { _tag: initialState } });
      applyAutomationCatalogUpdate(fixture.models.automations, {
        _tag: "Event",
        revision: 2,
        event: {
          _tag: "Upserted",
          summary: automationSummary({
            name: definition.name,
            context: definition.context,
            state: saved.state,
          }),
        },
      });
      return saved;
    });
    using fixture = setup({
      sessions: [
        sessionSummary({
          sessionId: "source-session",
          title: "Review implementation",
          projectPath,
          familyId: "family",
          familyParentSessionId: "parent",
        }),
        sessionSummary({
          sessionId: "other-project",
          title: "Other project child",
          projectPath: "/work/other",
          familyId: "other-family",
          familyParentSessionId: "other-parent",
        }),
        sessionSummary({ sessionId: "standalone", title: "Standalone work", projectPath }),
      ],
      client: {
        automations: { create },
        filesystem: {
          chooseAttachments: async () => [{ kind: "file", name: "guide.md", path: "/guide.md" }],
        },
      },
    });
    await fixture.user.click(screen.getByRole("button", { name: "New automation" }));
    await fixture.user.clear(screen.getByRole("textbox", { name: "Automation name" }));
    await fixture.user.type(
      screen.getByRole("textbox", { name: "Automation name" }),
      "Review replies",
    );
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Project" }),
      projectPath,
    );
    await fixture.user.click(screen.getByRole("button", { name: "Event" }));
    await fixture.user.click(screen.getByRole("button", { name: "Filter events" }));
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Automation event" }),
      "user-message-received",
    );
    for (const kind of ["Project Chat", "Standalone", "Family root"])
      await fixture.user.click(screen.getByRole("button", { name: kind }));
    const source = screen.getByRole("combobox", { name: "From session" });
    expect(
      within(source)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Any matching session", "Review implementation"]);
    await fixture.user.selectOptions(source, "source-session");
    await fixture.user.type(screen.getByRole("textbox", { name: "Message contains" }), "ready");
    await fixture.user.type(
      screen.getByRole("textbox", { name: "Automation task" }),
      "Review the response",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Attach" }));
    await fixture.user.click(screen.getByRole("radio", { name: "Run in parallel" }));
    await fixture.user.click(screen.getByRole("radio", { name: "Auto-resolve" }));
    await fixture.user.click(screen.getByRole("radio", { name: "Paused" }));
    await fixture.user.click(screen.getByRole("button", { name: "Create automation" }));
    await screen.findByRole("button", { name: "Save changes" });
    expect(saved?.definition).toMatchObject({
      name: "Review replies",
      context: { _tag: "Project", projectPath },
      trigger: {
        _tag: "Event",
        filter: {
          event: "user-message-received",
          scope: { _tag: "Project", projectPath },
          sessionKinds: ["family-child"],
          sessionId: "source-session",
          contentContains: "ready",
        },
      },
      task: {
        prompt: "Review the response",
        configuration: { provider: "test", modelId: "test" },
        attachments: [{ kind: "file", name: "guide.md", path: "/guide.md" }],
      },
      overlap: "parallel",
      completion: "auto-resolve",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ initialState: "paused" }),
      expect.anything(),
    );
  });

  it("edits a saved automation with visible run choices and clears message matching for non-message events", async () => {
    const update = vi.fn<Client["automations"]["update"]>(async ({ definition }) =>
      automation({ definition }),
    );
    using fixture = setup({ client: { automations: { update } } });
    await openDefinition(fixture.user);
    await fixture.user.click(screen.getByRole("button", { name: "Event" }));
    await fixture.user.click(screen.getByRole("button", { name: "Filter events" }));
    await fixture.user.type(screen.getByRole("textbox", { name: "Message contains" }), "ready");
    await fixture.user.click(screen.getByRole("radio", { name: "Queue" }));
    await fixture.user.click(screen.getByRole("radio", { name: "Auto-resolve" }));
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Automation event" }),
      "session-created",
    );
    expect(screen.queryByRole("textbox", { name: "Message contains" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]![0].definition).toMatchObject({
      overlap: "queue",
      completion: "auto-resolve",
      trigger: { _tag: "Event", filter: { event: "session-created" } },
      task: automationDefinition().task,
    });
    const trigger = update.mock.calls[0]![0].definition.trigger;
    expect(trigger._tag === "Event" && trigger.filter.contentContains).toBeUndefined();
  });

  it.each(["global", projectPath])(
    "creates an event automation bound to its selected project: %s",
    async (project) => {
      const create = vi.fn<Client["automations"]["create"]>(async ({ definition }) =>
        automation({ definition }),
      );
      using fixture = setup({ client: { automations: { create } } });
      await fixture.user.click(screen.getByRole("button", { name: "New automation" }));
      await fixture.user.selectOptions(screen.getByRole("combobox", { name: "Project" }), project);
      await fixture.user.click(screen.getByRole("button", { name: "Event" }));
      await fixture.user.type(
        screen.getByRole("textbox", { name: "Automation task" }),
        "Review replies",
      );
      await fixture.user.click(screen.getByRole("button", { name: "Create automation" }));
      await screen.findByRole("button", { name: "Save changes" });
      const context =
        project === "global" ? { _tag: "Global" } : { _tag: "Project", projectPath: project };
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          definition: expect.objectContaining({
            context,
            trigger: {
              _tag: "Event",
              filter: {
                event: "assistant-response-completed",
                scope: context,
                sessionKinds:
                  project === "global"
                    ? ["cake-chat"]
                    : ["project-chat", "standalone-project-session", "family-root", "family-child"],
              },
            },
          }),
        }),
        expect.anything(),
      );
    },
  );

  it("binds existing event definitions to their project and updates scope and session kinds when the project changes", async () => {
    const definitions: AutomationDefinition[] = [];
    const definition = automationDefinition({
      context: { _tag: "Project", projectPath },
      trigger: {
        _tag: "Event",
        filter: {
          event: "user-message-received",
          scope: { _tag: "Any" },
          sessionKinds: ["cake-chat", "family-child"],
          sessionId: "project-child",
          contentContains: "ready",
        },
      },
    });
    using fixture = setup({
      client: {
        automations: {
          inspect: async () => ({
            automation: automation({ definition }),
            activity: { runningSessions: 0, queuedOccurrences: 0 },
          }),
          update: async ({ definition }) => {
            definitions.push(definition);
            return automation({ definition });
          },
        },
      },
    });
    await openDefinition(fixture.user);
    await fixture.user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(definitions).toHaveLength(1));
    expect(definitions[0]?.trigger).toEqual({
      _tag: "Event",
      filter: {
        event: "user-message-received",
        scope: { _tag: "Project", projectPath },
        sessionKinds: ["family-child"],
        sessionId: "project-child",
        contentContains: "ready",
      },
    });
    await fixture.user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "global");
    await fixture.user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(definitions).toHaveLength(2));
    expect(definitions[1]).toMatchObject({
      context: { _tag: "Global" },
      trigger: {
        _tag: "Event",
        filter: {
          event: "user-message-received",
          scope: { _tag: "Global" },
          sessionKinds: ["cake-chat"],
          contentContains: "ready",
        },
      },
    });
    expect(
      definitions[1]?.trigger._tag === "Event" && definitions[1].trigger.filter.sessionId,
    ).toBeUndefined();
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Project" }),
      projectPath,
    );
    await fixture.user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(definitions).toHaveLength(3));
    expect(definitions[2]).toMatchObject({
      context: { _tag: "Project", projectPath },
      trigger: {
        _tag: "Event",
        filter: {
          scope: { _tag: "Project", projectPath },
          sessionKinds: [
            "project-chat",
            "standalone-project-session",
            "family-root",
            "family-child",
          ],
        },
      },
    });
  });

  it("edits once, fixed interval and timezone-aware friendly calendar controls without exposing cron", async () => {
    const definitions: AutomationDefinition[] = [];
    const update = vi.fn<Client["automations"]["update"]>(async ({ definition }) => {
      definitions.push(definition);
      return automation({ definition });
    });
    using fixture = setup({
      client: {
        automations: {
          inspect: async () => ({
            automation: automation(),
            activity: { runningSessions: 0, queuedOccurrences: 0 },
          }),
          update,
        },
      },
    });
    await openDefinition(fixture.user);
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Schedule repeat" }),
      "Once",
    );
    fireEvent.change(screen.getByLabelText("Schedule start"), {
      target: { value: "2035-01-01T10:00" },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Save changes" }));
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Schedule repeat" }),
      "Interval",
    );
    await fixture.user.selectOptions(screen.getByRole("combobox", { name: "Repeat unit" }), "3600");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Repeat amount" }), {
      target: { value: "2" },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Save changes" }));
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Schedule repeat" }),
      "Calendar",
    );
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Calendar recurrence" }),
      "weekly",
    );
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Calendar weekday" }),
      "1",
    );
    fireEvent.change(screen.getByLabelText("Calendar time"), { target: { value: "09:30" } });
    await fixture.user.clear(screen.getByRole("textbox", { name: "Calendar time zone" }));
    await fixture.user.type(
      screen.getByRole("textbox", { name: "Calendar time zone" }),
      "America/Los_Angeles",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      definitions.map((definition) =>
        definition.trigger._tag === "Schedule" ? definition.trigger.schedule._tag : "Event",
      ),
    ).toEqual(["Once", "Interval", "Calendar"]);
    expect(definitions[1]?.trigger).toMatchObject({ schedule: { everySeconds: 7200 } });
    expect(definitions[2]?.trigger).toMatchObject({
      schedule: { expression: "30 9 * * 1", timeZone: "America/Los_Angeles" },
    });
  });

  it("pauses without stopping active work, keeps accepted queue, runs manually and asks an archive decision", async () => {
    const pause = vi.fn<Client["automations"]["pause"]>(async () => {
      applyAutomationCatalogUpdate(fixture.models.automations, {
        _tag: "Event",
        revision: 2,
        event: { _tag: "Upserted", summary: automationSummary({ state: { _tag: "paused" } }) },
      });
      return automation({ state: { _tag: "paused" } });
    });
    const trigger = vi.fn<Client["automations"]["trigger"]>(async () => ({
      _tag: "queued",
      occurrenceId,
    }));
    const archive = vi.fn<Client["automations"]["archive"]>(async () => {
      applyAutomationCatalogUpdate(fixture.models.automations, {
        _tag: "Event",
        revision: 3,
        event: {
          _tag: "Upserted",
          summary: automationSummary({
            state: { _tag: "archived" },
            activity: { runningSessions: 2, queuedOccurrences: 0 },
          }),
        },
      });
      return automation({ state: { _tag: "archived" } });
    });
    using fixture = setup({
      client: {
        automations: {
          inspect: async () => ({
            automation: automation(),
            activity: { runningSessions: 2, queuedOccurrences: 3 },
          }),
          pause,
          trigger,
          archive,
        },
      },
    });
    await openDefinition(fixture.user);
    await fixture.user.click(screen.getByRole("button", { name: "Pause automation" }));
    expect(await screen.findByRole("button", { name: "Resume automation" })).toBeTruthy();
    await fixture.user.click(screen.getByRole("button", { name: "Run now" }));
    expect(await screen.findByText("Occurrence queued")).toBeTruthy();
    await fixture.user.click(screen.getByRole("button", { name: "Archive" }));
    const dialog = screen.getByRole("dialog", { name: "Archive automation" });
    expect(archive).not.toHaveBeenCalled();
    await fixture.user.click(within(dialog).getByRole("button", { name: "Let finish" }));
    expect(archive).toHaveBeenCalledWith(
      { automationId, runningSessions: "let-finish" },
      expect.anything(),
    );
    await fixture.user.click(screen.getByRole("button", { name: "All automations" }));
    expect(screen.getByLabelText("Automation totals").textContent).toContain(
      "2 active sessions0 queued occurrences",
    );
  });

  it("pages global provenance then opens and unresolves a real past run without firing or Project lookup", async () => {
    const run = automationRun({
      status: { _tag: "completed", finishedAt: "2030-01-01T09:01:00.000Z" },
    });
    const history = vi.fn<Client["automations"]["history"]>(async ({ offset }) => {
      applyConversationUpdate(
        fixture.models.automationConversation(run.sessionId),
        conversationUpdate(run.sessionId),
      );
      return offset
        ? {
            occurrences: [
              automationOccurrence({
                id: AutomationOccurrenceId.make("30000000-0000-4000-8000-000000000002"),
                disposition: { _tag: "blocked", reason: "Model unavailable" },
              }),
            ],
            runs: [],
            total: 2,
            nextOffset: null,
          }
        : { occurrences: [automationOccurrence()], runs: [run], total: 2, nextOffset: 1 };
    });
    const restore = vi.fn<Client["projectSessions"]["restore"]>(async () => {
      applyAutomationCatalogUpdate(fixture.models.automations, {
        _tag: "Event",
        revision: 2,
        event: { _tag: "SessionUpserted", summary: automationSession({ running: false }) },
      });
      applyConversationUpdate(
        fixture.models.automationConversation(run.sessionId),
        conversationUpdate(run.sessionId),
      );
    });
    const lookup = vi.fn<Client["projectSessions"]["lookup"]>(async () => {
      throw new Error("No Project lookup for automation runs");
    });
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("60000000-0000-4000-8000-000000000001"),
    );
    using fixture = setup({
      unresolved: false,
      client: {
        automations: { history },
        projectSessions: { restore, lookup },
        sessionChats: { prompt },
      },
    });
    await fixture.user.click(screen.getByRole("button", { name: "History" }));
    await screen.findByRole("button", { name: "Open run" });
    await fixture.user.click(screen.getByRole("button", { name: "Load more occurrences" }));
    expect(await screen.findByText("Model unavailable")).toBeTruthy();
    expect(history).toHaveBeenNthCalledWith(1, { offset: 0, limit: 20 }, expect.anything());
    expect(history).toHaveBeenLastCalledWith({ offset: 1, limit: 20 }, expect.anything());
    await fixture.user.click(screen.getByRole("button", { name: "Open run" }));
    expect(await screen.findByText("Automation Session")).toBeTruthy();
    await fixture.user.click(screen.getByRole("button", { name: "Unresolve" }));
    await screen.findByRole("button", { name: "Resolve" });
    const composer = screen.getByRole("combobox", { name: "Message automation run" });
    await fixture.user.type(composer, "Continue reviewing");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: run.sessionId, text: "Continue reviewing" }),
        expect.anything(),
      ),
    );
    expect(restore).toHaveBeenCalledWith(
      { sessionId: run.sessionId, userInitiated: true },
      expect.anything(),
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(fixture.models.projectConversations).toHaveLength(0);
  });

  it("shows queued/skipped/blocked/canceled provenance and cancels a queued occurrence without inventing a session", async () => {
    let canceled = false;
    const queuedId = AutomationOccurrenceId.make("30000000-0000-4000-8000-000000000005");
    const history = vi.fn<Client["automations"]["history"]>(async () => ({
      occurrences: [
        automationOccurrence({
          id: queuedId,
          disposition: canceled
            ? { _tag: "canceled", reason: "Canceled by user" }
            : { _tag: "queued" },
        }),
        automationOccurrence({
          id: AutomationOccurrenceId.make("30000000-0000-4000-8000-000000000006"),
          disposition: { _tag: "skipped", reason: "Overlap policy" },
        }),
        automationOccurrence({
          id: AutomationOccurrenceId.make("30000000-0000-4000-8000-000000000007"),
          disposition: { _tag: "blocked", reason: "Project unavailable" },
        }),
        automationOccurrence({
          id: AutomationOccurrenceId.make("30000000-0000-4000-8000-000000000008"),
          disposition: { _tag: "canceled", reason: "Archived" },
        }),
      ],
      runs: [],
      total: 4,
      nextOffset: null,
    }));
    const cancelQueued = vi.fn<Client["automations"]["cancelQueued"]>(async () => {
      canceled = true;
      applyAutomationCatalogUpdate(fixture.models.automations, {
        _tag: "Event",
        revision: 2,
        event: {
          _tag: "Upserted",
          summary: automationSummary({ activity: { runningSessions: 0, queuedOccurrences: 0 } }),
        },
      });
    });
    using fixture = setup({
      unresolved: false,
      activity: { runningSessions: 0, queuedOccurrences: 1 },
      client: { automations: { history, cancelQueued } },
    });
    await fixture.user.click(screen.getByRole("button", { name: "History" }));
    expect(await screen.findByText("Overlap policy")).toBeTruthy();
    expect(screen.getByText("Project unavailable")).toBeTruthy();
    expect(screen.getByText("Archived")).toBeTruthy();
    await fixture.user.click(screen.getByRole("button", { name: "Cancel queued" }));
    expect(await screen.findByText("Canceled by user")).toBeTruthy();
    expect(cancelQueued).toHaveBeenCalledWith({ occurrenceId: queuedId }, expect.anything());
    expect(screen.queryByRole("button", { name: "Cancel queued" })).toBeNull();
  });

  it("zooms shared memory to paged originals and navigates back without losing its automation", async () => {
    const readMemory = vi.fn<Client["automations"]["readMemory"]>(async () => ({
      lines: [{ range: { id: 0, n: 2 }, text: "Summary", depth: 1 }],
      bytes: 7,
      budgetBytes: 10000,
      sourceCount: 2,
    }));
    const zoomMemory = vi.fn<Client["automations"]["zoomMemory"]>(async ({ range, offset }) =>
      range.n === 2
        ? { _tag: "Branch", children: [{ range: { id: 0, n: 1 }, text: "First note", depth: 0 }] }
        : {
            _tag: "Original",
            sourceId: "note-0",
            text: offset ? "world" : "Hello ",
            offset: offset ?? 0,
            totalChars: 11,
            nextOffset: offset ? null : 6,
          },
    );
    using fixture = setup({
      client: {
        automations: {
          inspect: async () => ({
            automation: automation(),
            activity: { runningSessions: 0, queuedOccurrences: 0 },
          }),
          readMemory,
          zoomMemory,
        },
      },
    });
    await openDefinition(fixture.user);
    await fixture.user.click(
      within(screen.getByRole("navigation", { name: "Automation panes" })).getByRole("button", {
        name: "Memory",
      }),
    );
    await fixture.user.click(await screen.findByRole("button", { name: "Zoom" }));
    expect(await screen.findByText("First note")).toBeTruthy();
    await fixture.user.click(screen.getByRole("button", { name: "Zoom" }));
    await fixture.user.click(await screen.findByRole("button", { name: "Load more original" }));
    expect(await screen.findByText("Hello world")).toBeTruthy();
    await fixture.user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("First note")).toBeTruthy();
    await fixture.user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Summary")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Daily review" })).toBeTruthy();
    expect(zoomMemory).toHaveBeenLastCalledWith(
      { automationId, range: { id: 0, n: 1 }, offset: 6, maxChars: 8000 },
      expect.anything(),
    );
  });

  it("preselects a registered Project from its actual native context-menu action", async () => {
    const menu = vi.fn<Client["electron"]["showProjectContextMenu"]>(async () => "new-automation");
    using fixture = setup({ client: { electron: { showProjectContextMenu: menu } } });
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    fireEvent.contextMenu(screen.getByRole("button", { name: "Open Project Chat for Cake" }), {
      clientX: 10,
      clientY: 20,
    });
    expect(await screen.findByRole("heading", { name: "New automation" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveProperty("value", projectPath);
    expect(menu).toHaveBeenCalledWith(expect.objectContaining({ path: projectPath }));
    expect(screen.getByRole("combobox", { name: "Schedule repeat" })).toBeTruthy();
    await fixture.user.click(screen.getByRole("button", { name: "Event" }));
    await fixture.user.click(screen.getByRole("button", { name: "Filter events" }));
    expect(screen.getByRole("button", { name: "Project Chat" })).toBeTruthy();
  });

  it("keeps a newly selected definition when an earlier inspection finishes late", async () => {
    const first = Promise.withResolvers<AutomationInspection>();
    const inspect = vi.fn<Client["automations"]["inspect"]>(async ({ automationId: id }) =>
      id === automationId
        ? first.promise
        : {
            automation: automation({
              id: secondAutomationId,
              definition: automationDefinition({ name: "Project review" }),
              state: { _tag: "suspended", reason: "Model unavailable" },
            }),
            activity: { runningSessions: 0, queuedOccurrences: 0 },
          },
    );
    using fixture = setup({ second: true, client: { automations: { inspect } } });
    await fixture.user.click(within(table()).getByRole("button", { name: "Daily review" }));
    await fixture.user.click(screen.getByRole("button", { name: "All automations" }));
    await openDefinition(fixture.user, "Project review");
    await act(async () =>
      first.resolve({
        automation: automation(),
        activity: { runningSessions: 0, queuedOccurrences: 0 },
      }),
    );
    expect(screen.getByRole("heading", { name: "Project review" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Daily review" })).toBeNull();
  });
});
