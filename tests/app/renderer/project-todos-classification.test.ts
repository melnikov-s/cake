import { applySnapshot, effect } from "r-state-tree";
import { defaultProjectSettings } from "../../../src/contracts/application/application-data";
import { describe, expect, it } from "vitest";
import { emptyProjectTodos, type ProjectTodo } from "../../../src/contracts/projects/project-todos";
import type { AutoMergeRequest } from "../../../src/contracts/worktrees/auto-merge";
import { classifyProjectTodos } from "../../../src/renderer/lib/classify-project-todos";
import { applyWorktreeOperationCatalogUpdate } from "../../../src/renderer/reducers/WorktreeOperationReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

const chat = `project-chat:${"a".repeat(64)}`;
const todo = (id: string, overrides: Partial<ProjectTodo> = {}): ProjectTodo => ({
  id,
  title: id,
  description: "",
  status: "",
  revision: 0,
  state: "open",
  associations: [],
  ...overrides,
});
const request = (
  sessionId: string,
  overrides: Partial<AutoMergeRequest> = {},
): AutoMergeRequest => ({
  id: sessionId,
  sessionId,
  workspacePath: "/cake",
  readyToMerge: true,
  epoch: "test",
  runId: "run",
  commit: "a".repeat(40),
  state: "ready",
  ...overrides,
});

function fixtureFor(items: ProjectTodo[], sessions: ReturnType<typeof sessionSummary>[] = []) {
  const fixture = createRendererStoreFixture({
    projects: [{ ...projectRecord({ path: "/cake" }), todos: { ...emptyProjectTodos(), items } }],
    sessions,
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: chat, title: "Project Chat", projectPath: "/cake" }],
  });
  const store = fixture.root.cakeChatCollectionStore.registry.load(chat).todos;
  return { ...fixture, store };
}

describe("linear Project To-dos classification", () => {
  for (const size of [600, 1000]) {
    it.each([0, 1, 3, size])(
      "visits %i focused IDs with " + size + " mostly-done items once",
      (focusCount) => {
        let stateReads = 0;
        let sortReads = 0;
        let readinessRequestReads = 0;
        const items = Array.from(
          { length: size },
          (_, index) =>
            new Proxy(
              todo(`item-${index}`, {
                state: index < 30 ? "open" : "done",
                associations: [
                  { kind: "session", sessionId: `session-${index}`, title: "Session" },
                ],
              }),
              {
                get(target, key, receiver) {
                  if (key === "state") stateReads += 1;
                  if (key === "createdAt") sortReads += 1;
                  return Reflect.get(target, key, receiver);
                },
              },
            ),
        );
        using fixture = fixtureFor(
          [],
          Array.from({ length: 30 }, (_, index) =>
            sessionSummary({
              sessionId: `session-${index}`,
              projectPath: "/cake",
              workingDirectory: "/cake",
            }),
          ),
        );
        // Install counted plain authority values, not a substitute Store/classifier.
        fixture.models.projects.find("/cake")!.todos = { ...emptyProjectTodos(), items };
        fixture.models.worktreeOperations.autoMergeRequests.push(
          ...Array.from(
            { length: size },
            (_, index) =>
              new Proxy(request(`session-${index}`), {
                get(target, key, receiver) {
                  if (key === "sessionId") readinessRequestReads += 1;
                  return Reflect.get(target, key, receiver);
                },
              }),
          ),
        );
        fixture.store.focusedItemIds = items.slice(0, focusCount).map((item) => item.id);
        stateReads = 0;
        sortReads = 0;
        readinessRequestReads = 0;
        const classified = fixture.store.classifiedItems;
        expect(stateReads).toBe(size);
        expect(sortReads).toBeLessThan(64 * size);
        expect(readinessRequestReads).toBe(focusCount < 30 ? size : 0);
        expect(classified.focused).toHaveLength(focusCount);
        expect(classified.ready).toHaveLength(Math.max(0, 30 - focusCount));
        expect(Object.values(classified).flat()).toHaveLength(size);
        // Expanded Done must not rebuild a full item Map for every row.
        let idReads = 0;
        const counted = items.map(
          (item) =>
            new Proxy(item, {
              get(target, key, receiver) {
                if (key === "id") idReads += 1;
                return Reflect.get(target, key, receiver);
              },
            }),
        );
        fixture.models.projects.find("/cake")!.todos = { ...emptyProjectTodos(), items: counted };
        idReads = 0;
        for (let index = 0; index < size; index += 1)
          expect(fixture.store.isFocused(`item-${index}`)).toBe(index < focusCount);
        expect(idReads).toBeLessThanOrEqual(2 * size);
      },
    );
  }
});

it("preserves section precedence, focus order, legacy/timestamp ties, attention sequence and search", () => {
  const items = [
    todo("legacy-first", { state: "done" }),
    todo("legacy-last", { state: "done" }),
    todo("b", { state: "done", createdAt: "2026-01-01" }),
    todo("a", { state: "done", createdAt: "2026-01-01" }),
    todo("attention-first", { needsAttention: true, attentionReason: "Review NEEDLE" }),
    todo("attention-tie", {
      needsAttention: true,
      attentionReason: "Review",
      attentionSequence: 2,
    }),
    todo("attention-tie-last", {
      needsAttention: true,
      attentionReason: "Review",
      attentionSequence: 2,
    }),
    todo("snoozed", { needsAttention: true, snoozedUntil: "2027-01-01" }),
    todo("ready"),
    todo("active"),
    todo("focus-ready"),
    todo("focus-done", { state: "done" }),
  ];
  const classify = (query = "") =>
    classifyProjectTodos(items, ["focus-done", "missing", "focus-ready"], query, (item) =>
      item.id.includes("ready"),
    );
  const ids = (items: ProjectTodo[]) => items.map((item) => item.id);
  const result = classify();
  expect(ids(result.focused)).toEqual(["focus-done", "focus-ready"]);
  expect(ids(result.attention)).toEqual(["attention-first", "attention-tie", "attention-tie-last"]);
  expect(ids(result.snoozed)).toEqual(["snoozed"]);
  expect(ids(result.ready)).toEqual(["ready"]);
  expect(ids(result.active)).toEqual(["active"]);
  expect(ids(result.done)).toEqual(["a", "b", "legacy-last", "legacy-first"]);
  expect(ids(classify("  NeEdLe ").attention)).toEqual(["attention-first"]);
  expect(classify("needle").focused).toEqual([]);
  items[7] = todo("snoozed", { snoozedUntil: "2027-01-01", attentionReason: "needle" });
  expect(classify("needle").snoozed).toEqual([]);
});

it("does not invalidate classification for equivalent readiness snapshots, but applies real changes", () => {
  using fixture = fixtureFor(
    [todo("task", { associations: [{ kind: "session", sessionId: "session", title: "Session" }] })],
    [sessionSummary({ sessionId: "session", projectPath: "/cake", workingDirectory: "/cake" })],
  );
  const catalog = fixture.models.worktreeOperations;
  let current = request("session");
  const project = { projectPath: "/cake", enabled: false, epoch: "test", status: "Off" };
  const update = () =>
    applyWorktreeOperationCatalogUpdate(catalog, {
      operations: [],
      autoMergeRequests: [{ ...current }],
      autoMergeProjects: [{ ...project }],
    });
  update();
  let calculations = 0;
  const stop = effect(() => {
    fixture.store.classifiedItems;
    calculations += 1;
  });
  try {
    const projected = catalog.autoMergeRequests[0];
    update();
    expect(catalog.autoMergeRequests[0]).toBe(projected);
    expect(calculations).toBe(1);
    current = { ...current, readyToMerge: false };
    update();
    expect(calculations).toBe(2);
    expect(fixture.store.classifiedItems.active.map((item) => item.id)).toEqual(["task"]);
    current = { ...current, readyToMerge: true };
    update();
    expect(calculations).toBe(3);
    expect(fixture.store.classifiedItems.ready.map((item) => item.id)).toEqual(["task"]);
    applyWorktreeOperationCatalogUpdate(catalog, { operations: [] });
    expect(calculations).toBe(4);
    expect(fixture.store.classifiedItems.ready).toEqual([]);
  } finally {
    stop();
  }
});

it("the temporary readiness lookup matches single-session authority across latest, external, and resolution rules", () => {
  const ids = [
    "ready",
    "revoked",
    "external",
    "external-failed",
    "external-landing",
    "external-merged",
    "resolved",
    "partial",
    "landed",
    "unknown",
  ];
  using fixture = fixtureFor(
    [],
    ids
      .filter((id) => id !== "unknown")
      .map((sessionId) =>
        sessionSummary({
          sessionId,
          projectPath: sessionId.startsWith("external") ? "/external" : "/cake",
          workingDirectory: "/cake",
          resolved: sessionId === "resolved" || sessionId === "partial",
        }),
      ),
  );
  applySnapshot(fixture.models.projects, {
    projects: [
      projectRecord({ path: "/cake" }),
      projectRecord({
        path: "/external",
        settings: { ...defaultProjectSettings(), worktreeLanding: "pull-request" },
      }),
    ],
  });
  const outcome = {
    targetBranch: "main",
    merged: true,
    resolutionSucceeded: false,
    message: "Follow-up",
  };
  fixture.models.worktreeOperations.autoMergeRequests.push(
    ...ids.map((id) => request(id)),
    request("revoked", { readyToMerge: false }),
    request("external-failed", { state: "failed" }),
    request("external-landing", { state: "landing" }),
    request("external-merged", { outcome }),
    request("partial", { outcome }),
    request("landed", { state: "landed" }),
  );
  const metadata = fixture.root.sessionMetadataStore;
  const lookup = metadata.createMergeReadinessLookup();
  for (const id of [...ids, "missing"]) expect(lookup(id)).toBe(metadata.sessionMergeReadiness(id));
});
