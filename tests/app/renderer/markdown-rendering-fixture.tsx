import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { StoreProvider } from "r-state-tree/react";
import { createHighlighter } from "shiki";
import { vi } from "vitest";
import type { DiagramRequest } from "../../../src/renderer/lib/diagram-contract";
import { renderDiagram } from "../../../src/renderer/lib/diagram-engine";
import {
  Markdown,
  MarkdownLinkProvider,
} from "../../../src/renderer/components/ai-elements/markdown";
import type {
  SyntaxHighlightRequest,
  SyntaxHighlightResponse,
} from "../../../src/renderer/lib/syntax-highlighter-contract";
import { syntaxThemes } from "../../../src/renderer/lib/syntax-highlighter-contract";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

type MarkdownActions = ComponentProps<typeof MarkdownLinkProvider>["actions"];

/** Only the browser Worker transport is replaced; Markdown, Streamdown, the
 * renderer highlighter/cache and Shiki tokenization all run unchanged. Native
 * worker loading/bundling and layout remain Electron integration concerns. */
export async function installMarkdownWorker() {
  const highlighter = await createHighlighter({
    langs: ["typescript", "json", "shellscript"],
    themes: [...syntaxThemes],
  });
  class InProcessWorker extends EventTarget {
    private name: string;
    private stopped = false;
    constructor(_url: URL, options: WorkerOptions) {
      super();
      this.name = options.name ?? "";
    }
    postMessage(request: SyntaxHighlightRequest | DiagramRequest) {
      queueMicrotask(() => {
        if (this.stopped) return;
        if (this.name === "cake-diagram" && "source" in request) {
          this.dispatchEvent(new MessageEvent("message", { data: renderDiagram(request) }));
          return;
        }
        if (!("language" in request)) throw new Error("Unexpected worker request");
        const response: SyntaxHighlightResponse = {
          id: request.id,
          result: highlighter.codeToTokens(request.code, {
            lang: request.language,
            themes: { light: syntaxThemes[0], dark: syntaxThemes[1] },
          }),
        };
        this.dispatchEvent(new MessageEvent("message", { data: response }));
      });
    }
    terminate() {
      this.stopped = true;
    }
  }
  vi.stubGlobal("Worker", InProcessWorker);
  return {
    [Symbol.dispose]() {
      highlighter.dispose();
      vi.unstubAllGlobals();
    },
  };
}

export function renderMarkdown(
  source: string,
  options: {
    props?: Omit<ComponentProps<typeof Markdown>, "children">;
    actions?: Partial<MarkdownActions>;
    client?: TestClientOverrides;
    sessionLinkTarget?: string;
  } = {},
) {
  const sessionId = options.sessionLinkTarget;
  const fixture = createRendererStoreFixture({
    projects: sessionId ? [projectRecord({ path: "/work/cake" })] : [],
    sessions: sessionId ? [sessionSummary({ sessionId, projectPath: "/work/cake" })] : [],
    client: {
      ...options.client,
      electron: { setFullscreenSurfaceOpen: async () => undefined, ...options.client?.electron },
    },
  });
  if (sessionId) {
    const session = fixture.root.sessionRegistry.load(sessionId, "/work/cake");
    applyConversationUpdate(session.model, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId,
        sessionFile: `/sessions/${sessionId}.jsonl`,
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
  }
  const actions: MarkdownActions = {
    sessionIds: () => fixture.root.sessionCatalogStore.authoritativeSessionIds,
    openExternalUrl: (url) => void fixture.root.openExternalUrl(url),
    openSession: (sessionId, messageId, attachmentId) =>
      void fixture.root.navigationStore.openSessionLink(sessionId, messageId, attachmentId),
    ...options.actions,
  };
  const content = (text: string, props = options.props) => (
    <StoreProvider store={fixture.root}>
      <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
        <MarkdownLinkProvider actions={actions}>
          <Markdown {...props}>{text}</Markdown>
        </MarkdownLinkProvider>
      </StoreProvider>
    </StoreProvider>
  );
  const view = render(content(source));
  return {
    ...view,
    user: userEvent.setup(),
    async update(text: string, props = options.props) {
      await act(async () => view.rerender(content(text, props)));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

export function codeBodies(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-streamdown="code-block-body"]'));
}

/** A real Shiki token has dual-theme styles, unlike the plain growing fence. */
export function highlighted(body: HTMLElement) {
  return body.querySelector('span[style*="--shiki-dark"]') !== null;
}
