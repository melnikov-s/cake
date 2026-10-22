/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectTodoItem } from "../../../src/renderer/components/project-todo-item";
import { MarkdownLinkProvider } from "../../../src/renderer/components/ai-elements/markdown";
import { ArtifactReferencePreview } from "../../../src/renderer/components/artifact-reference-preview";
import {
  ArtifactIcon,
  ChatIcon,
  LinkIcon,
  MarkdownIcon,
  TreeIcon,
  SparkleIcon,
} from "../../../src/renderer/components/ui/icons";
import { projectTodoAssociationDestination } from "../../../src/renderer/lib/project-todo-association";
import type {
  ProjectTodo,
  ProjectTodoAssociation,
} from "../../../src/contracts/projects/project-todos";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const cases = [
  {
    title: "Subagent report",
    ref: "cake://subagent/task/10000000-0000-4000-8000-000000000001",
    Icon: SparkleIcon,
  },
  { title: "Project Session", ref: "cake://session/task", Icon: TreeIcon },
  { title: "Exact report", ref: "cake://session/task?message=report%2F1", Icon: ChatIcon },
  {
    title: "Attachment",
    ref: "cake://session/task?attachment=00000000-0000-4000-8000-000000000001",
    Icon: ArtifactIcon,
  },
  { title: "Website", ref: "https://example.com/report.md", Icon: LinkIcon },
  { title: "Artifact", ref: "cake://artifact/report@r2", Icon: ArtifactIcon },
  { title: "Workspace Markdown", ref: "docs/README.MD#overview", Icon: MarkdownIcon },
  { title: "Workspace source", ref: "src/main.ts:12:3", Icon: ArtifactIcon },
  {
    title: "Workspace diff",
    ref: "src/main.ts?view=changes&side=before#L2-L4",
    Icon: ArtifactIcon,
  },
];

afterEach(cleanup);

it.each(cases)(
  "classifies $title by its destination, not its source association kind",
  ({ title, ref, Icon }) => {
    expect(projectTodoAssociationDestination({ kind: "source", ref, title })).toEqual({
      href: ref,
      Icon,
    });
  },
);

it("classifies explicit session associations with the established Project Session icon", () => {
  expect(
    projectTodoAssociationDestination({ kind: "session", sessionId: "task", title: "Work" }),
  ).toEqual({
    href: "cake://session/task",
    Icon: TreeIcon,
  });
});

it("classifies explicit subagent associations by public handle and parent with a distinct icon", () => {
  expect(
    projectTodoAssociationDestination({
      kind: "subagent",
      parentSessionId: "task",
      handleId: "10000000-0000-4000-8000-000000000001",
      title: "Worker",
    }),
  ).toEqual({
    href: "cake://subagent/task/10000000-0000-4000-8000-000000000001",
    Icon: SparkleIcon,
  });
});

it("renders authored titles and decorative destination icons through the existing navigation components", () => {
  using fixture = createRendererStoreFixture();
  const store = fixture.root.cakeChatCollectionStore.registry.load("project-chat:test").todos;
  const associations: ProjectTodoAssociation[] = cases.map(({ title, ref }) => ({
    kind: "source",
    ref,
    title,
  }));
  const item: ProjectTodo = {
    id: "00000000-0000-4000-8000-000000000011",
    title: "Review work",
    description: "Review work",
    status: "",
    state: "open",
    revision: 0,
    associations,
  };
  const view = render(
    <StoreProvider store={fixture.root}>
      <MarkdownLinkProvider
        actions={{
          openSession: vi.fn(),
          openExternalUrl: vi.fn(),
          renderArtifactReference: (reference, label) => (
            <ArtifactReferencePreview
              reference={reference}
              store={fixture.root.artifactReferencePreviewStore}
              onOpen={vi.fn()}
            >
              {label}
            </ArtifactReferencePreview>
          ),
        }}
      >
        <ProjectTodoItem item={item} store={store} />
      </MarkdownLinkProvider>
    </StoreProvider>,
  );
  for (const { title, ref, Icon } of cases) {
    const link = screen.getByRole("link", { name: title });
    expect(link.getAttribute("href")).toBe(ref);
    expect(link.getAttribute("aria-description")).toBe(ref);
    const icon = link.closest("li")!.querySelector("svg")!;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    const expected = render(<Icon />);
    expect(icon.innerHTML).toBe(expected.container.querySelector("svg")!.innerHTML);
    expected.unmount();
  }
  view.unmount();
});
