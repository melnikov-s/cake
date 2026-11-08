/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  isValidElement,
  memo,
  Profiler,
  useContext,
  type ComponentProps,
  type ContextType,
} from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Markdown,
  MarkdownLinkProvider,
  useMarkdownLinkActions,
} from "../../../src/renderer/components/ai-elements/markdown";
import { ArtifactReferencePreview } from "../../../src/renderer/components/artifact-reference-preview";
import { InlineArtifactPreview } from "../../../src/renderer/components/inline-artifact-preview";
import { ConversationMarkdownProvider } from "../../../src/renderer/components/conversation-markdown-provider";
import { ConversationMarkdownResourceContext } from "../../../src/renderer/components/conversation-markdown-resource-context";
import { RendererRoot } from "../../../src/renderer/components/renderer-root";
import { applyAutomationCatalogUpdate } from "../../../src/renderer/reducers/AutomationReducer";
import { applySessionCatalogGroupUpdate } from "../../../src/renderer/reducers/CatalogReducer";
import { automationRun, automationSession } from "./fixtures/automation-fixtures";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";
import type { Client } from "../../../src/renderer/client/Client";

// Isolate the window/provider boundary from intentional sidebar and pane updates.
// The real Store tree, providers, MarkdownRenderer and Streamdown remain in use.
vi.mock("../../../src/renderer/components/app", () => ({
  App: () => <MarkdownSurface />,
}));
vi.mock("../../../src/renderer/components/new-session-dialog", () => ({
  NewSessionDialog: () => null,
}));

const markdownCommits = vi.fn();
const providerRenders = vi.fn();
let currentActions: ReturnType<typeof useMarkdownLinkActions>;
let currentResources: ContextType<typeof ConversationMarkdownResourceContext>;
const attachmentId = "00000000-0000-4000-8000-000000000001";
const visibleBlocks = Array.from({ length: 12 }, (_, index) => index);
const MarkdownSurface = memo(function MarkdownSurface() {
  currentActions = useMarkdownLinkActions();
  currentResources = useContext(ConversationMarkdownResourceContext);
  providerRenders();
  return visibleBlocks.map((index) => (
    <Profiler key={index} id={`markdown-${index}`} onRender={markdownCommits}>
      <Markdown>
        {index === 0
          ? `[Message](cake://session/beta?message=entry-42) · [Attachment](cake://session/beta?attachment=${attachmentId})`
          : `Visible Markdown block ${index}`}
      </Markdown>
    </Profiler>
  ));
});

function mountRoot(client: TestClientOverrides = {}) {
  const fixture = createRendererStoreFixture({
    client,
    projects: [projectRecord({ path: "/project" })],
    sessions: [
      sessionSummary({ sessionId: "alpha", projectPath: "/project", title: "Alpha" }),
      sessionSummary({ sessionId: "beta", projectPath: "/project", title: "Beta" }),
    ],
  });
  fixture.root.navigationStore.selectProjectSession("alpha");
  const callbacks = {
    openExternalUrl: vi.fn(),
    openSession: vi.fn(),
    openSubagent: vi.fn(),
  };
  const view = render(<RendererRoot rootStore={fixture.root} variant="app" {...callbacks} />);
  return {
    ...fixture,
    callbacks,
    view,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

beforeEach(() => {
  markdownCommits.mockClear();
  providerRenders.mockClear();
});
afterEach(cleanup);

it.each(["project catalog", "automation catalog", "open automation runs"] as const)(
  "does not broadcast unrelated additions/removals from %s to 12 visible Markdown blocks",
  async (source) => {
    using fixture = mountRoot();
    const actions = currentActions!;
    const resources = currentResources;
    const observations: { markdownCommits: number; providerRenders: number }[] = [];
    const callbackMembership: boolean[] = [];
    const sessionId = source === "project catalog" ? "unrelated" : "automation-run-1";
    const publish = (added: boolean) => {
      if (source === "project catalog") {
        applySessionCatalogGroupUpdate(
          fixture.models.sessionCatalog,
          { projectPath: "/project", resolved: false },
          {
            _tag: "Event",
            revision: added ? 1 : 2,
            event: added
              ? {
                  _tag: "Upserted",
                  session: sessionSummary({ sessionId, projectPath: "/project" }),
                }
              : { _tag: "Removed", sessionId },
          },
        );
      } else if (source === "automation catalog") {
        applyAutomationCatalogUpdate(fixture.models.automations, {
          _tag: "Event",
          revision: added ? 1 : 2,
          event: added
            ? { _tag: "SessionUpserted", summary: automationSession() }
            : { _tag: "SessionRemoved", sessionId },
        });
      } else if (added) fixture.root.automationSessionsStore.loadRun(automationRun(), "Run title");
      else fixture.root.automationSessionsStore.closeSession(sessionId);
    };
    for (const added of [true, false]) {
      const renders = providerRenders.mock.calls.length;
      const commits = markdownCommits.mock.calls.length;
      await act(async () => publish(added));
      observations.push({
        markdownCommits: markdownCommits.mock.calls.length - commits,
        providerRenders: providerRenders.mock.calls.length - renders,
      });
      callbackMembership.push(actions.sessionIds!().includes(sessionId));
      expect(currentActions!.sessionIds!().includes(sessionId)).toBe(added);
      expect(actions.sessionTitle!(sessionId)).toBe(
        added
          ? source === "project catalog"
            ? "unrelated"
            : source === "automation catalog"
              ? "Daily review"
              : "Run title"
          : undefined,
      );
    }
    expect(observations).toEqual([
      { markdownCommits: 0, providerRenders: 0 },
      { markdownCommits: 0, providerRenders: 0 },
    ]);
    expect(callbackMembership).toEqual([true, false]);
    expect(currentActions).toBe(actions);
    expect(currentResources).toBe(resources);
  },
);

it("keeps context identities stable even when RendererRoot itself rerenders", () => {
  using fixture = mountRoot();
  const actions = currentActions;
  const resources = currentResources;
  const renders = providerRenders.mock.calls.length;
  const commits = markdownCommits.mock.calls.length;
  // Removing an explicit default prop defeats observer's props memo without changing the UI.
  fixture.view.rerender(<RendererRoot rootStore={fixture.root} {...fixture.callbacks} />);
  expect(currentActions).toBe(actions);
  expect(currentResources).toBe(resources);
  expect(providerRenders.mock.calls.length - renders).toBe(0);
  expect(markdownCommits.mock.calls.length - commits).toBe(0);
});

it("reads the current conversation and titles through callbacks captured before navigation", async () => {
  using fixture = mountRoot();
  const actions = currentActions!;
  const openArtifact = vi
    .spyOn(fixture.root.navigationStore, "openArtifact")
    .mockImplementation(() => {});
  const preview = actions.renderArtifactReference!("cake://artifact/report@r1", "Report");
  if (!isValidElement<ComponentProps<typeof ArtifactReferencePreview>>(preview))
    throw new Error("Expected an artifact reference preview");
  expect(actions.sessionTitle!("beta")).toBe("Beta");
  actions.openArtifact!("cake://artifact/report@r1");
  expect(openArtifact).toHaveBeenLastCalledWith("alpha", "report", 1);
  const commits = markdownCommits.mock.calls.length;

  await act(async () => {
    fixture.root.navigationStore.selectProjectSession("beta");
    fixture.models.sessionCatalog.find("beta")!.title = "Renamed Beta";
  });
  expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe("beta");
  expect(currentActions).toBe(actions);
  expect(markdownCommits.mock.calls.length - commits).toBe(0);
  expect(actions.sessionTitle!("beta")).toBe("Renamed Beta");
  actions.openArtifact!("cake://artifact/report@r2");
  expect(openArtifact).toHaveBeenLastCalledWith("beta", "report", 2);
  // A preview rendered before the switch must not retain the old active session either.
  preview.props.onOpen("report", 1);
  expect(openArtifact).toHaveBeenLastCalledWith("beta", "report", 1);
  fireEvent.click(screen.getByRole("link", { name: "Message" }));
  expect(fixture.callbacks.openSession).toHaveBeenLastCalledWith("beta", "entry-42");
  fireEvent.click(screen.getByRole("link", { name: "Attachment" }));
  expect(fixture.callbacks.openSession).toHaveBeenLastCalledWith("beta", undefined, attachmentId);
  openArtifact.mockRestore();
});

it("updates conversation resources deliberately without inheriting another pane's attachment reader", async () => {
  const readImage = vi.fn<Client["filesystem"]["readImage"]>(async () => ({
    data: "AQID",
    mimeType: "image/png",
  }));
  using fixture = mountRoot({ filesystem: { readImage } });
  const resources = currentResources!;
  const parentAttachment = vi.fn();
  const alphaAttachment = vi.fn().mockResolvedValue({ data: "AQID", mimeType: "image/png" });
  const betaAttachment = vi.fn().mockResolvedValue({ data: "BAUG", mimeType: "image/png" });
  const inherited = { ...currentActions!, loadAttachmentImage: parentAttachment };
  let paneActions: ReturnType<typeof useMarkdownLinkActions>;
  function PaneProbe() {
    paneActions = useMarkdownLinkActions();
    return null;
  }
  const tree = (sessionId: string, loadAttachmentImage?: typeof alphaAttachment) => (
    <MarkdownLinkProvider actions={inherited}>
      <ConversationMarkdownResourceContext value={resources}>
        <ConversationMarkdownProvider
          stateSessionId={sessionId}
          workspacePath={`/${sessionId}-tree`}
          loadAttachmentImage={loadAttachmentImage}
        >
          <PaneProbe />
        </ConversationMarkdownProvider>
      </ConversationMarkdownResourceContext>
    </MarkdownLinkProvider>
  );
  const view = render(tree("alpha", alphaAttachment));
  const alphaActions = paneActions!;
  view.rerender(tree("alpha", alphaAttachment));
  expect(paneActions!).toBe(alphaActions);
  const signal = new AbortController().signal;
  await paneActions!.loadWorkspaceImage!("screen.png", signal);
  expect(readImage).toHaveBeenLastCalledWith("/alpha-tree", "screen.png", { signal });
  await paneActions!.loadAttachmentImage!("attachment", signal);
  expect(alphaAttachment).toHaveBeenCalledWith("attachment", signal);

  view.rerender(tree("beta", betaAttachment));
  expect(paneActions!).not.toBe(alphaActions);
  await paneActions!.loadWorkspaceImage!("screen.png", signal);
  expect(readImage).toHaveBeenLastCalledWith("/beta-tree", "screen.png", { signal });
  await paneActions!.loadAttachmentImage!("attachment", signal);
  expect(betaAttachment).toHaveBeenCalledWith("attachment", signal);
  const embed = paneActions!.renderArtifactEmbed!("cake://artifact/report@r1", "Report");
  if (!isValidElement<ComponentProps<typeof InlineArtifactPreview>>(embed))
    throw new Error("Expected an inline artifact preview");
  expect(embed.props.stateSessionId).toBe("beta");
  expect(embed.props.store).toBe(resources.inlineArtifacts);
  expect(embed.props.inlineWidgets).toBe(resources.inlineWidgets);
  view.rerender(tree("beta"));
  expect(paneActions!.loadAttachmentImage).toBeUndefined();
  expect(parentAttachment).not.toHaveBeenCalled();
});

it("publishes intentional navigation capability changes instead of retaining stale prop callbacks", () => {
  using fixture = mountRoot();
  const actions = currentActions;
  const resources = currentResources;
  const callbacks = {
    openExternalUrl: vi.fn(),
    openSession: vi.fn(),
    openSubagent: vi.fn(),
  };
  fixture.view.rerender(<RendererRoot rootStore={fixture.root} {...callbacks} />);
  expect(currentActions).not.toBe(actions);
  expect(currentResources).toBe(resources);
  currentActions!.openExternalUrl("https://example.com");
  expect(callbacks.openExternalUrl).toHaveBeenCalledWith("https://example.com");
  currentActions!.openSubagent!("parent", "worker", "message");
  expect(callbacks.openSubagent).toHaveBeenCalledWith("parent", "worker", "message");
  fireEvent.click(screen.getByRole("link", { name: "Attachment" }));
  expect(callbacks.openSession).toHaveBeenCalledWith("beta", undefined, attachmentId);
  expect(fixture.callbacks.openSession).not.toHaveBeenCalled();
});
