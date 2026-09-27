import { createStore, mount } from "r-state-tree";
import { expect, it } from "vitest";
import type { SavedDraft } from "../../../../src/domain/project-sessions/saved-draft-data";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { BrowserNavigationStore } from "../../../../src/renderer/stores/BrowserNavigationStore";

it("a remotely activated saved Draft follows the backend Working Directory, not its old project-root target", () => {
  const projection = RootProjection.create();
  const record: SavedDraft = {
    sessionId: "00000000-0000-4000-8000-000000000001",
    projectPath: "/project",
    workingDirectory: "/project",
    title: "Shared",
    text: "Start",
    attachments: [],
    labelIds: [],
    resolved: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
    status: "saved",
  };
  const navigation = mount(
    createStore(BrowserNavigationStore, {
      projection,
      savedDrafts: () => [record],
    }),
  );
  expect(navigation.selectSession(record.sessionId)).toBe(true);
  expect(navigation.opened[0]).toMatchObject({ workingDirectory: "/project", staged: true });
  navigation.materializeSavedDraft({
    ...record,
    revision: 3,
    status: "activated",
    workingDirectory: "/worktrees/shared",
  });
  expect(navigation.opened[0]).toMatchObject({
    workingDirectory: "/worktrees/shared",
    staged: false,
  });
  navigation[Symbol.dispose]();
  projection[Symbol.dispose]();
});
