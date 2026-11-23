/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { sessionSummary } from "./fixtures/catalog-fixtures";

it("keeps mixed session purposes on their individual to-do links without reordering associations or to-dos", async () => {
  using fixture = createRendererStoreFixture({
    sessions: [
      sessionSummary({ sessionId: "mine", projectPath: "/project", purpose: "user" }),
      sessionSummary({ sessionId: "assigned", projectPath: "/project", purpose: "delegated" }),
    ],
  });
  // Cold archive identities have relationship metadata even without a loaded list row.
  fixture.models.sessionCatalog.sessions.splice(0);
  fixture.models.sessionCatalog.signals.loaded = true;
  fixture.models.sessionCatalog.signals.purposes = { mine: "user", assigned: "delegated" };
  const store = fixture.root.cakeChatCollectionStore.registry.load("project-chat:test").todos;
  const items: ProjectTodo[] = ["first", "second"].map((title, index) => ({
    id: `00000000-0000-4000-8000-00000000001${index}`,
    title,
    description: title,
    status: "",
    state: "open",
    revision: 0,
    associations: [
      { kind: "session", sessionId: "assigned", title: "Assigned work" },
      { kind: "session", sessionId: "mine", title: "Direct work" },
    ],
  }));
  const view = render(
    <StoreProvider store={fixture.root}>
      {items.map((item) => (
        <ProjectTodoItem key={item.id} item={item} store={store} />
      ))}
    </StoreProvider>,
  );
  // Links start collapsed behind compact per-row disclosures without toggling focus.
  expect(screen.queryAllByRole("link")).toEqual([]);
  const user = userEvent.setup();
  for (const item of items) {
    await user.click(screen.getByRole("button", { name: `Show 2 links for ${item.title}` }));
  }
  const links = screen.getAllByRole("link");
  expect(links.map((link) => link.textContent)).toEqual([
    "Assigned work",
    "Direct work",
    "Assigned work",
    "Direct work",
  ]);
  const rows = view.container.querySelectorAll("[data-todo-id]");
  expect([...rows].map((row) => row.getAttribute("data-todo-id"))).toEqual(
    items.map((item) => item.id),
  );
  expect(screen.getAllByRole("img", { name: "Delegated Session" })).toHaveLength(2);
  expect(screen.getAllByRole("img", { name: "User Session" })).toHaveLength(2);
});

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

it("renders authored titles and decorative destination icons through the existing navigation components", async () => {
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
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: `Show ${cases.length} links for Review work` }));
  for (const { title, ref, Icon } of cases) {
    const link = screen.getByRole("link", { name: title });
    expect(link.getAttribute("href")).toBe(ref);
    expect(link.getAttribute("aria-description")).toBe(
      ref.startsWith("cake://session/") ? `${title}\n${ref}` : ref,
    );
    const icon = link.closest("li")!.querySelector("svg")!;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    const expected = render(<Icon />);
    expect(icon.innerHTML).toBe(expected.container.querySelector("svg")!.innerHTML);
    expected.unmount();
  }
  view.unmount();
});

it("shows one latest update and preserves attention, activity and independent links", async () => {
  using fixture = createRendererStoreFixture({
    sessions: [
      sessionSummary({ sessionId: "run", projectPath: "/project", running: true }),
      sessionSummary({ sessionId: "done-1", projectPath: "/project", resolved: true }),
      sessionSummary({ sessionId: "done-2", projectPath: "/project", resolved: true }),
    ],
  });
  const store = fixture.root.cakeChatCollectionStore.registry.load("project-chat:test").todos;
  const item: ProjectTodo = {
    id: "00000000-0000-4000-8000-000000000099",
    title: "Fix concrete architecture review defects",
    description:
      "Review identified gaps in the workspace file limits. Check the fix against a large project.",
    status: "Legacy status text.",
    remainingWork: "Stored verification context.",
    state: "open",
    needsAttention: true,
    attentionReason: "Review 4 baseline Knip findings before merging",
    revision: 0,
    associations: [
      { kind: "session", sessionId: "run", title: "Deep consultant review" },
      { kind: "session", sessionId: "done-1", title: "Protect unsent input" },
      { kind: "session", sessionId: "done-2", title: "Bound workspace file reads" },
      { kind: "source", ref: "https://example.com/findings", title: "Prioritized findings" },
    ],
  };
  const view = render(
    <StoreProvider store={fixture.root}>
      <ProjectTodoItem item={item} store={store} />
    </StoreProvider>,
  );
  const user = userEvent.setup();
  const title = screen.getByRole("button", { name: item.title });
  expect(title.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getAllByText(item.description)).toHaveLength(1);
  expect(document.getElementById(title.getAttribute("aria-describedby")!)?.textContent).toBe(
    item.description,
  );
  expect(screen.queryByText(item.status)).toBeNull();
  expect(screen.getByText(item.attentionReason!)).toBeDefined();
  expect(screen.getByRole("img", { name: "Needs attention" })).toBeDefined();
  expect(screen.getByText("1 running")).toBeDefined();
  expect(screen.getByText("2/3 resolved")).toBeDefined();
  await user.click(screen.getByText(item.description));
  expect(title.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getAllByText(item.description)).toHaveLength(1);
  expect(screen.queryByText(/Legacy status text/)).toBeNull();
  expect(screen.queryByText(item.remainingWork!)).toBeNull();
  expect(store.isFocused(item.id)).toBe(false);
  await user.click(title);
  expect(title.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: "Deep consultant review" })).toBeNull();
  const toggle = () =>
    screen.getByRole("button", { name: /^(Show|Hide) 4 links for Fix concrete/ });
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  // 3 sessions + 1 web source show a single compact link count button.
  expect(toggle().textContent).toBe("4");
  await user.click(toggle());
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("link", { name: "Deep consultant review" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Prioritized findings" })).toBeDefined();
  expect(store.isFocused(item.id)).toBe(false);
  await user.click(toggle());
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: "Deep consultant review" })).toBeNull();
  view.unmount();
});

it("renders description Markdown whose links navigate without toggling the card", async () => {
  using fixture = createRendererStoreFixture();
  const store = fixture.root.cakeChatCollectionStore.registry.load("project-chat:test").todos;
  const description = [
    "## Rollout",
    "",
    "[#2486609](https://delta.shopify.io/shop/world/pull/2486609) live since 20 Nov 00:55. Fix 1 (`ba24be3c`): see [worker](cake://session/task).",
    "",
    "- **first** step",
    "- <b>raw</b> second step",
  ].join("\n");
  const item: ProjectTodo = {
    id: "00000000-0000-4000-8000-000000000012",
    title: "Ship the rollout",
    description,
    status: "",
    state: "open",
    revision: 0,
    associations: [],
  };
  const openExternalUrl = vi.fn();
  const openSession = vi.fn();
  const view = render(
    <StoreProvider store={fixture.root}>
      <MarkdownLinkProvider actions={{ openSession, openExternalUrl }}>
        <ProjectTodoItem item={item} store={store} />
      </MarkdownLinkProvider>
    </StoreProvider>,
  );
  const user = userEvent.setup();
  const title = screen.getByRole("button", { name: item.title });
  const preview = () => document.getElementById(title.getAttribute("aria-describedby")!)!;
  // The clamped preview keeps inline Markdown and flattens blocks to one run of text.
  expect(preview().textContent).not.toContain("](");
  expect(preview().textContent).not.toContain("`");
  expect(preview().querySelector("code")?.textContent).toBe("ba24be3c");
  expect(preview().querySelector("strong, [data-streamdown=strong]")?.textContent).toBe("first");
  expect(preview().querySelector("h2, ul, li, p, b")).toBeNull();
  expect(preview().textContent).toMatch(/^Rollout\s+#2486609 live since/);
  // Authored HTML stays literal text rather than becoming elements.
  expect(preview().textContent).toContain("<b>raw</b> second step");

  await user.click(screen.getByRole("link", { name: "#2486609" }));
  expect(openExternalUrl).toHaveBeenCalledWith("https://delta.shopify.io/shop/world/pull/2486609");
  await user.click(screen.getByRole("link", { name: /worker/ }));
  expect(openSession).toHaveBeenCalledWith("task");
  expect(title.getAttribute("aria-expanded")).toBe("false");

  // The expanded card renders the full Markdown.
  await user.click(title);
  expect(title.getAttribute("aria-expanded")).toBe("true");
  expect(preview().querySelector("h2")?.textContent).toBe("Rollout");
  expect(preview().querySelectorAll("li")).toHaveLength(2);
  expect(preview().querySelector("b")).toBeNull();
  expect(preview().textContent).toContain("<b>raw</b> second step");
  await user.click(screen.getByRole("link", { name: "#2486609" }));
  expect(openExternalUrl).toHaveBeenCalledTimes(2);
  expect(title.getAttribute("aria-expanded")).toBe("true");
  view.unmount();
});
