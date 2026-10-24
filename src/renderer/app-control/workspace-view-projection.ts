import { Schema } from "effect";
import type { RootApplicationControlCapabilities } from "./RootApplicationControlHost";
import {
  type AppWorkspaceView,
  VisibleEditorMetadataList,
} from "../../contracts/application/app-workspace-view";

const editorMetadata = Schema.Struct({ visible: VisibleEditorMetadataList });

/** URLs are orientation, not a channel for cookies, credentials, OAuth fragments or query tokens. */
function publicLocation(location: string | undefined): string | undefined {
  if (!location) return undefined;
  try {
    const url = new URL(location);
    if (url.protocol === "about:" && url.pathname === "blank") return "about:blank";
    if (!["http:", "https:", "file:"].includes(url.protocol)) return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.slice(0, 4096);
  } catch {
    return undefined;
  }
}

/** No navigation, runtime acquisition, file reads, or queries to background panes. */
export async function inspectWorkspaceView(
  capabilities: Pick<
    RootApplicationControlCapabilities,
    | "appShellStore"
    | "projectWorkbenchStore"
    | "sessionLayoutStore"
    | "cakeChatCollectionStore"
    | "client"
    | "signal"
  >,
): Promise<AppWorkspaceView | undefined> {
  const active = capabilities.appShellStore.activeConversation;
  if (!active) return undefined;
  const presentation = capabilities.projectWorkbenchStore.presentationStore;
  const mode = presentation.props.activeSession()?.presentationMode;
  if (mode !== "browser" && mode !== "vscode") return undefined;
  const layout =
    active.kind === "cake-chat"
      ? capabilities.cakeChatCollectionStore.sessionLayoutStore
      : capabilities.sessionLayoutStore;
  const paneId = layout.paneForSession(active.sessionId)?.paneId;
  const identity = { sessionId: active.sessionId, ...(paneId ? { paneId } : null) };
  const covered =
    capabilities.appShellStore.coveringSurface !== undefined ||
    capabilities.projectWorkbenchStore.activeSessionResolved;
  if (mode === "browser") {
    const browser = presentation.browserStore;
    if (!browser.visible) return { ...identity, kind: mode, status: "hidden" };
    const bounds = browser.measuredBounds;
    const hidden =
      covered ||
      !bounds ||
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      (browser.currentLocation !== undefined && !browser.nativeViewBounds.visible);
    const url = hidden ? undefined : publicLocation(browser.currentLocation);
    return {
      ...identity,
      kind: "browser",
      status: hidden
        ? "hidden"
        : browser.error
          ? "unavailable"
          : browser.loading || !browser.currentLocation
            ? "loading"
            : url
              ? "ready"
              : "unavailable",
      ...(url && !browser.error ? { url } : null),
    };
  }
  const editor = presentation.embeddedEditorStore;
  if (!editor.visible) return { ...identity, kind: mode, status: "hidden" };
  const bounds = editor.measuredBounds;
  const hidden =
    covered ||
    !bounds ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    (editor.nativeViewReady && !editor.nativeViewBounds.visible);
  const view: AppWorkspaceView = {
    ...identity,
    kind: "vscode",
    status: hidden
      ? "hidden"
      : editor.error || editor.status === "failed" || editor.status === "missing"
        ? "unavailable"
        : !editor.nativeViewReady || editor.status !== "ready"
          ? "loading"
          : "ready",
  };
  if (view.status !== "ready") return view;
  const workspacePath = presentation.props.projectPath();
  if (!workspacePath || capabilities.signal.aborted) return { ...view, status: "unavailable" };

  // editor.status has no event-backed visible-editor cache. Bound this metadata-only
  // request independently of the companion's startup/script deadlines, even if a
  // transport ignores cancellation. Never return lastActivePath as all visible files.
  const controller = new AbortController();
  const signal = AbortSignal.any([capabilities.signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      capabilities.client.vscode.performEditorAction(
        workspacePath,
        { type: "editor.status" },
        { signal },
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Editor metadata deadline"));
        }, 200);
      }),
    ]);
    // The user may have switched/covered the surface while the request was in flight.
    if (
      capabilities.appShellStore.selection.kind !== active.kind ||
      capabilities.appShellStore.activeConversation?.sessionId !== active.sessionId ||
      capabilities.appShellStore.coveringSurface ||
      !editor.nativeViewBounds.visible ||
      presentation.props.projectPath() !== workspacePath
    )
      return { ...view, status: "hidden" };
    const metadata = Schema.decodeUnknownSync(editorMetadata)(result);
    return {
      ...view,
      editors: metadata.visible.map(({ path, group, active }) => ({
        path,
        ...(group === undefined ? null : { group }),
        active,
      })),
    };
  } catch {
    return { ...view, status: "unavailable" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
