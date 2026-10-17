import { Schema } from "effect";
import type { StoreSnapshot } from "r-state-tree";

const legacyConversationSchema = Schema.Struct({
  kind: Schema.Literals(["project-session", "cake-chat"]),
  sessionId: Schema.String,
});
const legacyNavigationSchema = Schema.Struct({
  selection: Schema.optional(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literals(["workbench", "settings", "artifact-library"]) }),
      Schema.Struct({ kind: Schema.Literal("project-session"), sessionId: Schema.String }),
      Schema.Struct({
        kind: Schema.Literal("cake-chat"),
        sessionId: Schema.optional(Schema.String),
      }),
    ]),
  ),
  activeConversation: Schema.optional(legacyConversationSchema),
});

/** Root children and the collection's layout are singular Store children. */
function child(snapshot: StoreSnapshot, name: string): StoreSnapshot | undefined {
  const value = snapshot.children[name];
  return value && !Array.isArray(value) ? value : undefined;
}

function seedLayout(snapshot: StoreSnapshot | undefined, sessionId: string): StoreSnapshot {
  // An existing layout wins over the old, independently writable shell identity.
  if (snapshot?.state.layout) return snapshot;
  const paneId = crypto.randomUUID();
  return {
    state: {
      ...snapshot?.state,
      layout: { kind: "pane", paneId, history: [sessionId], historyCursor: 0 },
      focusedPaneId: paneId,
    },
    children: snapshot?.children ?? {},
  };
}

/** One-time renderer navigation v1 -> v2 migration, before mounting (desktop and browser).
 * Retain layouts and both kinds of history. Only seed a missing layout from the old shell;
 * if old identities disagree, the focused pane wins. Never persist shell session IDs again.
 */
export function migrateNavigation(snapshot: StoreSnapshot): StoreSnapshot {
  const shell = child(snapshot, "appShellStore");
  if (!shell || shell.state.navigationVersion === 2) return snapshot;
  // Startup-only decoding: malformed legacy navigation fails restoration rather than
  // silently choosing a different conversation. The rest of the Store snapshot is unchanged.
  const { selection, activeConversation } = Schema.decodeUnknownSync(legacyNavigationSchema)(
    shell.state,
  );
  const state = { ...shell.state };
  delete state.selection;
  delete state.activeConversation;
  const kind = selection?.kind;
  const coveringSurface = kind === "settings" || kind === "artifact-library" ? kind : undefined;
  const selected = coveringSurface
    ? activeConversation
    : selection?.kind === "project-session" ||
        (selection?.kind === "cake-chat" && selection.sessionId)
      ? selection
      : undefined;
  const workspace =
    kind === "cake-chat" || selected?.kind === "cake-chat"
      ? "cake-chat"
      : selected?.kind === "project-session"
        ? "project-sessions"
        : "home";
  const children = { ...snapshot.children };
  if (selected?.kind === "project-session")
    children.sessionLayoutStore = seedLayout(
      child(snapshot, "sessionLayoutStore"),
      selected.sessionId,
    );
  if (selected?.kind === "cake-chat" && selected.sessionId) {
    const collection = child(snapshot, "cakeChatCollectionStore");
    children.cakeChatCollectionStore = {
      state: collection?.state ?? {},
      children: {
        ...collection?.children,
        sessionLayoutStore: seedLayout(
          collection && child(collection, "sessionLayoutStore"),
          selected.sessionId,
        ),
      },
    };
  }
  children.appShellStore = {
    state: { ...state, navigationVersion: 2, workspace, coveringSurface },
    children: shell.children,
  };
  return { ...snapshot, children };
}
