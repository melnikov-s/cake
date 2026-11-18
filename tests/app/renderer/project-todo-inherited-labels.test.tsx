/** @vitest-environment jsdom */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { expect, it } from "vitest";
import {
  defaultApplicationState,
  type SessionLabel,
} from "../../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { emptyProjectTodos, type ProjectTodo } from "../../../src/contracts/projects/project-todos";
import { ProjectTodosPanel } from "../../../src/renderer/components/project-todos-panel";
import { TaskSectionRail } from "../../../src/renderer/components/task-section-rail";
import { mergedSessionLabelColor } from "../../../src/utils/session-label-color";
import { sessionLabelPalette } from "../../../src/utils/session-label-palette";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const defaults = defaultApplicationState().globalSessionLabels;
const feature = defaults.find((label) => label.name === "Feature")!;
const bug = defaults.find((label) => label.name === "Bug")!;
const maintenance = defaults.find((label) => label.name === "Maintenance")!;
const item: ProjectTodo = {
  id: "00000000-0000-4000-8000-000000000011",
  title: "Check startup",
  description: "Check startup",
  status: "",
  state: "open",
  revision: 0,
  associations: [],
};
const link = (sessionId: string) => ({ kind: "session" as const, sessionId, title: sessionId });
const swatch = (trigger: HTMLElement) =>
  trigger.querySelector("[data-session-label-color]")?.getAttribute("data-session-label-color");

it("updates row and transcript labels as links, assignments, resolution and label metadata change", () => {
  const first = sessionSummary({ projectPath: "/alpha", sessionId: "first" });
  const second = sessionSummary({ projectPath: "/alpha", sessionId: "second" });
  const assignment = (sessionId: string, ...labels: SessionLabel[]) => ({
    sessionId,
    labelIds: labels.map((label) => label.id),
  });
  const evidence = {
    kind: "source" as const,
    ref: "cake://session/second?message=response",
    title: "Report",
  };
  const project = (
    todo: ProjectTodo,
    assignments = [assignment("first", bug), assignment("second", bug)],
  ) => ({
    ...projectRecord({ path: "/alpha", workflow: { assignments, labels: [], sessionDetails: [] } }),
    todos: { ...emptyProjectTodos(), items: [todo] },
  });
  let todo: ProjectTodo = { ...item, associations: [evidence, link("missing")] };
  using fixture = createRendererStoreFixture({ projects: [project(todo)] });
  const globalLabels = fixture.root.settingsStore.globalLabels;
  globalLabels.applyApplicationState(0, defaultApplicationState());
  // Task-only views use the lightweight signals, without opening the Sessions tab.
  applySnapshot(fixture.models.sessionCatalog.signals, { loaded: true, sessions: [first, second] });
  const chatId = "project-chat:/alpha";
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: chatId, title: "Project Chat", projectPath: "/alpha" }],
  });
  const store = fixture.root.cakeChatCollectionStore.registry.load(chatId).todos;
  const view = render(
    <StoreProvider store={fixture.root}>
      <TaskSectionRail todoId={item.id} start todos={store} expanded />
      <ProjectTodosPanel store={store} />
    </StoreProvider>,
  );
  const checkBoth = (name: string, color?: string) => {
    const triggers = screen.getAllByRole("button", {
      name: `Change label for ${item.title}. Current ${name}`,
    });
    expect(triggers).toHaveLength(2);
    expect(triggers.map(swatch)).toEqual([color, color]);
  };
  const update = (changes: Partial<ProjectTodo>, assignments?: ReturnType<typeof assignment>[]) => {
    todo = { ...todo, ...changes, revision: todo.revision + 1 };
    act(() => applySnapshot(fixture.models.projects, { projects: [project(todo, assignments)] }));
  };
  try {
    checkBoth("label: Unlabelled");
    update({ associations: [link("first"), evidence] });
    checkBoth("label: Bug (from linked sessions)", sessionLabelPalette.rose);
    update({ associations: [link("first"), link("first"), link("second"), evidence] });
    checkBoth("label: Bug (from linked sessions)", sessionLabelPalette.rose);
    const assignments = [
      assignment("first", bug, feature),
      assignment("second", maintenance, feature),
    ];
    const alpha = fixture.models.projects.find("/alpha")!;
    act(() => {
      alpha.workflow = { ...alpha.workflow, assignments };
    });
    checkBoth(
      "labels: Bug, Feature, Maintenance (from linked sessions)",
      mergedSessionLabelColor(["rose", "blue", "amber"]),
    );
    update({ associations: [link("second"), link("first")] }, assignments);
    const archivedNames = "labels: Maintenance, Feature, Bug (from linked sessions)";
    const archivedColor = mergedSessionLabelColor(["amber", "blue", "rose"]);
    checkBoth(archivedNames, archivedColor);
    update({ labelId: feature.id }, assignments);
    checkBoth("label: Feature", sessionLabelPalette.blue);
    update({ labelId: undefined }, assignments);
    checkBoth(archivedNames, archivedColor);

    // Resolution removes active signals. The archive's known IDs and retained assignments
    // suffice without fetching any resolved list rows or changing the sidebar lookup.
    act(() => {
      applySnapshot(fixture.models.sessionCatalog.signals, {
        loaded: true,
        sessions: [],
        resolvedSessionIds: ["first", "second"],
      });
      store.doneExpanded = true;
    });
    update({ state: "done" }, assignments);
    checkBoth(archivedNames, archivedColor);
    act(() =>
      applySnapshot(fixture.models.sessionCatalog, { sessions: [{ ...first, resolved: true }] }),
    );
    expect(fixture.root.sessionMetadataStore.sessionLabelIds("first")).toEqual([]);
    checkBoth(archivedNames, archivedColor);
    act(() => {
      const state = defaultApplicationState();
      globalLabels.applyApplicationState(1, {
        ...state,
        globalSessionLabels: state.globalSessionLabels.map((label) =>
          label.id === bug.id ? { ...label, name: "Regression", color: "pink" } : label,
        ),
      });
    });
    checkBoth(
      "labels: Maintenance, Feature, Regression (from linked sessions)",
      mergedSessionLabelColor(["amber", "blue", "pink"]),
    );
    act(() => {
      alpha.workflow = { ...alpha.workflow, assignments: [] };
    });
    checkBoth("label: Unlabelled");
  } finally {
    view.unmount();
  }
});

it("shows cross-project locals in global to-dos but keeps both grouped pickers in their owning scopes", async () => {
  const localId = "10000000-0000-4000-8000-000000000001";
  // Local identity is project-scoped even if two catalog entries have the same id.
  const local = { id: localId, name: "Alpha only", color: "pink" } as const;
  const remote = { id: localId, name: "Beta only", color: "mint" } as const;
  const global = {
    ...item,
    id: "00000000-0000-4000-8000-000000000012",
    title: "Cross-project work",
    associations: [link("beta"), link("alpha")],
  };
  using fixture = createRendererStoreFixture({
    projects: [local, remote].map((label, index) => {
      const id = index === 0 ? "alpha" : "beta";
      return {
        ...projectRecord({
          path: `/${id}`,
          workflow: {
            labels: [label],
            assignments: [{ sessionId: id, labelIds: [label.id, bug.id] }],
            sessionDetails: [],
          },
        }),
        todos: {
          ...emptyProjectTodos(),
          items: index === 0 ? [{ ...item, associations: [link("alpha")] }] : [],
        },
      };
    }),
    sessions: [
      sessionSummary({ projectPath: "/alpha", sessionId: "alpha" }),
      sessionSummary({ projectPath: "/beta", sessionId: "beta" }),
    ],
  });
  fixture.root.settingsStore.globalLabels.applyApplicationState(0, defaultApplicationState());
  applySnapshot(fixture.models.cakeChatTodos, {
    todos: { ...emptyProjectTodos(), items: [global] },
  });
  const store = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID).todos;
  const view = render(
    <StoreProvider store={fixture.root}>
      <ProjectTodosPanel store={store} />
    </StoreProvider>,
  );
  const user = userEvent.setup();
  try {
    const globalTrigger = screen.getByRole("button", {
      name: `Change label for ${global.title}. Current labels: Beta only, Bug, Alpha only (from linked sessions)`,
    });
    expect(swatch(globalTrigger)).toBe(mergedSessionLabelColor(["mint", "rose", "pink"]));
    await user.click(globalTrigger);
    const menu = () => within(screen.getByRole("menu", { name: "Choose label" }));
    expect(menu().getByText("From linked sessions: Beta only, Bug, Alpha only")).toBeDefined();
    expect(menu().queryByRole("menuitemradio", { name: /only/ })).toBeNull();
    expect(menu().getByRole("menuitemradio", { name: bug.name }).getAttribute("aria-checked")).toBe(
      "false",
    );
    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("button", {
        name: `Change label for ${item.title}. Current labels: Alpha only, Bug (from linked sessions)`,
      }),
    );
    expect(menu().getByRole("menuitemradio", { name: local.name })).toBeDefined();
    expect(menu().queryByRole("menuitemradio", { name: remote.name })).toBeNull();
  } finally {
    view.unmount();
  }
});
