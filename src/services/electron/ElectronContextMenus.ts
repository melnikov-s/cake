import { readFileSync } from "node:fs";
import { Effect } from "effect";
import {
  BrowserWindow,
  clipboard,
  Menu,
  nativeImage,
  type MenuItemConstructorOptions,
  type ContextMenuParams,
  type WebContents,
} from "electron";
import type { cakeRpcSuccessSchemas } from "../../contracts/application/cake-rpc-contract";
import { ElectronError } from "../../contracts/desktop/electron-errors";
import type { ElectronService } from "./Electron";

interface ElectronContextMenuOptions {
  readonly annotationMenuIconPath: string;
  readonly chatMenuIconPath: string;
  readonly requireRendererConnection: (connectionId: number) => WebContents;
  readonly canRewordSelection: () => boolean;
  readonly reportClipboardError: (window: BrowserWindow, error: unknown) => void;
}

const electronError = (cause: unknown) =>
  new ElectronError({ message: cause instanceof Error ? cause.message : String(cause) });

type IconMenuEntry = Omit<MenuItemConstructorOptions, "icon" | "label" | "role" | "type"> & {
  readonly label: string;
  readonly icon: string;
};

const iconMenuEntry = ({ icon: iconPath, ...entry }: IconMenuEntry) => {
  // These catalog icons are rasterized at 2x for a 16-point native menu slot.
  // Supply the scale explicitly: asset bundling hashes names, so Electron cannot
  // infer Retina density from an @2x filename or discover sibling representations.
  const icon = nativeImage.createFromBuffer(readFileSync(iconPath), { scaleFactor: 2 });
  icon.setTemplateImage(true);
  return { ...entry, icon } satisfies MenuItemConstructorOptions;
};

/** Native context menus and their transient popups; the Electron service owns their lifetime. */
export const makeElectronContextMenus = (options: ElectronContextMenuOptions) => {
  const openSessionContextMenus = new Set<Menu>();
  const composerMenus = new Map<
    number,
    {
      show(params: ContextMenuParams): void;
      dismiss(): void;
    }
  >();
  const spellingItems = (
    sender: WebContents,
    params: ContextMenuParams,
  ): MenuItemConstructorOptions[] => {
    // macOS can report spellcheckEnabled=false while supplying a native misspelling.
    if (!params.misspelledWord) return [];
    return [
      ...(params.dictionarySuggestions.length
        ? params.dictionarySuggestions.slice(0, 5).map((suggestion) => ({
            label: suggestion,
            click: () => sender.replaceMisspelling(suggestion),
          }))
        : [{ label: "No Suggestions", enabled: false }]),
      { type: "separator" },
    ];
  };
  const copyText = (window: BrowserWindow, text: string): void => {
    void clipboard
      .writeText(text)
      .catch((error: unknown) => options.reportClipboardError(window, error));
  };
  const operations: Pick<
    ElectronService,
    | "showTranscriptSelectionContextMenu"
    | "showComposerContextMenu"
    | "showSessionContextMenu"
    | "showProjectContextMenu"
  > = {
    showTranscriptSelectionContextMenu: Effect.fn("Electron.showTranscriptSelectionContextMenu")(
      function* (connectionId, request) {
        const sender = yield* Effect.try({
          try: () => options.requireRendererConnection(connectionId),
          catch: electronError,
        });
        const owner = BrowserWindow.fromWebContents(sender);
        if (!owner) return {};
        return yield* Effect.tryPromise({
          try: () =>
            new Promise<SuccessTranscriptMenu>((resolve) => {
              let selectedAction: SuccessTranscriptMenu["action"];
              const template: MenuItemConstructorOptions[] = [{ role: "copy" }];
              if (request.canAnnotate)
                template.push(
                  iconMenuEntry({
                    label: "Add annotation",
                    icon: options.annotationMenuIconPath,
                    click: () => {
                      selectedAction = "add-annotation";
                    },
                  }),
                );
              if (request.canChat)
                template.push(
                  iconMenuEntry({
                    label: "Chat about this",
                    icon: options.chatMenuIconPath,
                    click: () => {
                      selectedAction = "chat-about-selection";
                    },
                  }),
                );
              template.push({ role: "selectAll" });
              Menu.buildFromTemplate(template).popup({
                window: owner,
                callback: () => resolve({ action: selectedAction }),
              });
            }),
          catch: electronError,
        });
      },
    ),
    showComposerContextMenu: Effect.fn("Electron.showComposerContextMenu")(
      function* (connectionId, request) {
        const sender = yield* Effect.try({
          try: () => options.requireRendererConnection(connectionId),
          catch: electronError,
        });
        const owner = BrowserWindow.fromWebContents(sender);
        if (!owner) return {};
        return yield* Effect.tryPromise({
          try: (signal) =>
            new Promise<SuccessComposerMenu>((resolve) => {
              let completed = false;
              let menu: Menu | undefined;
              const finish = (action?: SuccessComposerMenu["action"]) => {
                if (completed) return;
                completed = true;
                composerMenus.delete(sender.id);
                sender.removeListener("destroyed", dismiss);
                signal.removeEventListener("abort", dismiss);
                menu?.closePopup();
                resolve({ action });
              };
              const dismiss = () => finish();
              composerMenus.get(sender.id)?.dismiss();
              sender.once("destroyed", dismiss);
              signal.addEventListener("abort", dismiss, { once: true });
              // The renderer sends this request before allowing Chromium's context-menu
              // default action. Wait for its native params rather than opening two menus.
              composerMenus.set(sender.id, {
                dismiss,
                show: (params) => {
                  menu = Menu.buildFromTemplate([
                    ...spellingItems(sender, params),
                    { role: "cut" },
                    { role: "copy" },
                    { role: "paste" },
                    { type: "separator" },
                    {
                      label: "Insert model reference",
                      enabled: request.canInsertModel,
                      click: () => finish("insert-model"),
                    },
                    {
                      label: "Insert session reference",
                      enabled: request.canInsertSession,
                      click: () => finish("insert-session"),
                    },
                    {
                      label: "Move draft to session…",
                      enabled: request.canMoveDraft,
                      click: () => finish("move-draft"),
                    },
                    {
                      label: "Reword",
                      enabled: request.canReword && options.canRewordSelection(),
                      click: () => finish("reword"),
                    },
                    {
                      label: "Reword with Prompt…",
                      enabled: request.canReword && options.canRewordSelection(),
                      click: () => finish("reword-with-prompt"),
                    },
                    { type: "separator" },
                    { role: "selectAll" },
                  ]);
                  menu.popup({ window: owner, x: request.x, y: request.y, callback: dismiss });
                },
              });
            }),
          catch: electronError,
        });
      },
    ),
    showSessionContextMenu: Effect.fn("Electron.showSessionContextMenu")(
      function* (connectionId, request) {
        const sender = yield* Effect.try({
          try: () => options.requireRendererConnection(connectionId),
          catch: electronError,
        });
        const owner = BrowserWindow.fromWebContents(sender);
        if (!owner) return {};
        return yield* Effect.tryPromise({
          try: () =>
            new Promise<SuccessSessionMenu>((resolve) => {
              let completed = false;
              const finish = (action?: SuccessSessionMenu["action"]) => {
                if (completed) return;
                completed = true;
                resolve({ action });
              };
              const copyId = {
                label: "Copy Session ID",
                click: () => copyText(owner, request.sessionId),
              };
              const activeItems: MenuItemConstructorOptions[] = [
                ...(request.unread === false
                  ? [{ label: "Mark as Unread", click: () => finish("mark-unread") }]
                  : []),
                { label: "Rename", click: () => finish("rename") },
                copyId,
              ];
              const moveToUser: MenuItemConstructorOptions[] =
                request.delegated && !request.permanent
                  ? [{ label: "Move to My sessions", click: () => finish("move-to-user") }]
                  : [];
              const menu = Menu.buildFromTemplate([
                ...moveToUser,
                ...(request.permanent
                  ? [
                      {
                        label: "Mark as Read",
                        enabled: request.unread === true,
                        click: () => finish("mark-read"),
                      },
                      {
                        label: "Mark as Unread",
                        enabled: request.unread === false,
                        click: () => finish("mark-unread"),
                      },
                      copyId,
                    ]
                  : request.draft
                    ? [
                        ...activeItems,
                        ...(request.familyChild
                          ? []
                          : [{ label: "Delete", click: () => finish("delete") }]),
                      ]
                    : request.resolved
                      ? [
                          { label: "Unresolve", click: () => finish("unresolve") },
                          copyId,
                          ...(request.familyChild
                            ? []
                            : [
                                { type: "separator" as const },
                                { label: "Delete", click: () => finish("delete") },
                              ]),
                        ]
                      : [...activeItems, { label: "Resolve", click: () => finish("resolve") }]),
              ]);
              openSessionContextMenus.add(menu);
              menu.popup({
                window: owner,
                x: request.x,
                y: request.y,
                callback: () => {
                  openSessionContextMenus.delete(menu);
                  finish();
                },
              });
            }),
          catch: electronError,
        });
      },
    ),
    showProjectContextMenu: Effect.fn("Electron.showProjectContextMenu")(
      function* (connectionId, request) {
        const sender = yield* Effect.try({
          try: () => options.requireRendererConnection(connectionId),
          catch: electronError,
        });
        const owner = BrowserWindow.fromWebContents(sender);
        if (!owner) return {};
        return yield* Effect.tryPromise({
          try: () =>
            new Promise<SuccessProjectMenu>((resolve) => {
              let completed = false;
              const finish = (action?: SuccessProjectMenu["action"]) => {
                if (completed) return;
                completed = true;
                resolve({ action });
              };
              Menu.buildFromTemplate([
                { label: "New Automation…", click: () => finish("new-automation") },
                { label: "Project Settings…", click: () => finish("settings") },
                {
                  label: "Sort Sessions",
                  submenu: [
                    {
                      label: "By Date",
                      type: "radio",
                      checked: request.sessionSort === "date",
                      click: () => finish("sort-by-date"),
                    },
                    {
                      label: "By Label",
                      type: "radio",
                      checked: request.sessionSort === "label",
                      click: () => finish("sort-by-label"),
                    },
                  ],
                },
                { type: "separator" },
                { label: "Copy Project Path", click: () => copyText(owner, request.path) },
                { type: "separator" },
                {
                  label: `Delete Resolved Worktrees${request.resolvedWorktreeCount > 0 ? ` (${request.resolvedWorktreeCount})` : ""}`,
                  enabled: request.resolvedWorktreeCount > 0,
                  click: () => finish("delete-resolved-worktrees"),
                },
                { type: "separator" },
                { label: "Remove Project…", click: () => finish("remove-project") },
              ]).popup({ window: owner, x: request.x, y: request.y, callback: () => finish() });
            }),
          catch: electronError,
        });
      },
    ),
  };
  return {
    operations,
    installEditMenu: (window: BrowserWindow) => {
      window.webContents.on("context-menu", (_event, params) => {
        const composer = composerMenus.get(window.webContents.id);
        if (composer) {
          composer.show(params);
          return;
        }
        if (
          !params.isEditable &&
          !params.selectionText &&
          !params.misspelledWord &&
          !params.linkURL
        )
          return;
        const template = spellingItems(window.webContents, params);
        if (params.linkURL)
          template.push(
            { label: "Copy Link", click: () => copyText(window, params.linkURL) },
            { type: "separator" },
          );
        if (params.isEditable || params.selectionText)
          template.push(
            { role: "cut", enabled: params.isEditable && params.editFlags.canCut },
            {
              role: "copy",
              enabled: params.isEditable ? params.editFlags.canCopy : Boolean(params.selectionText),
            },
            { role: "paste", enabled: params.isEditable && params.editFlags.canPaste },
            { role: "selectAll" },
          );
        Menu.buildFromTemplate(template).popup({ window });
      });
    },
    stop: () => {
      for (const composer of composerMenus.values()) composer.dismiss();
      for (const menu of openSessionContextMenus) menu.closePopup();
      openSessionContextMenus.clear();
    },
  };
};

type SuccessTranscriptMenu = {
  readonly action?: "chat-about-selection" | "add-annotation";
};
type SuccessComposerMenu = {
  readonly action?:
    | "reword"
    | "reword-with-prompt"
    | "insert-model"
    | "insert-session"
    | "move-draft";
};
type SuccessSessionMenu = {
  readonly action?:
    | "rename"
    | "mark-read"
    | "mark-unread"
    | "resolve"
    | "unresolve"
    | "delete"
    | "move-to-user";
};
type SuccessProjectMenu = (typeof cakeRpcSuccessSchemas)["show-project-context-menu"]["Type"];
