import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { DrawStore } from "../stores/DrawStore";
import { Button } from "./ui/button";
import {
  DialogBackdrop,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { IconButton } from "./ui/icon-button";
import { BackIcon, EditIcon, PlusIcon, TrashIcon } from "./ui/icons";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

export const DrawBoardToolbar = observer(function DrawBoardToolbar({
  store,
  onBack,
}: {
  store: DrawStore;
  onBack(): void;
}) {
  const [dialog, setDialog] = useState<"rename" | "delete">();
  const [title, setTitle] = useState("");
  const activeBoard = store.activeBoard;
  const closeDialog = () => setDialog(undefined);

  return (
    <>
      <header className="flex h-[35px] shrink-0 items-center gap-2 border-b border-border bg-background px-2 [-webkit-app-region:drag]">
        <IconButton
          className="[-webkit-app-region:no-drag]"
          tooltip="Back to conversation"
          onClick={onBack}
        >
          <BackIcon />
        </IconButton>
        <strong className="shrink-0 text-xs">Cake Draw</strong>
        <Select
          size="sm"
          className="max-w-56 [-webkit-app-region:no-drag]"
          aria-label="Active whiteboard"
          value={store.activeBoardId ?? ""}
          disabled={store.loading}
          onChange={(event) => void store.selectBoard(event.target.value)}
        >
          {store.boards.map((board) => (
            <option key={board.id} value={board.id}>
              {board.title}
            </option>
          ))}
        </Select>
        <IconButton
          className="[-webkit-app-region:no-drag]"
          tooltip="New whiteboard"
          disabled={store.loading}
          onClick={() => void store.createBoard()}
        >
          <PlusIcon />
        </IconButton>
        <IconButton
          className="[-webkit-app-region:no-drag]"
          tooltip="Rename whiteboard"
          disabled={!activeBoard || store.loading}
          onClick={() => {
            setTitle(activeBoard?.title ?? "");
            setDialog("rename");
          }}
        >
          <EditIcon />
        </IconButton>
        <IconButton
          className="[-webkit-app-region:no-drag]"
          tooltip="Delete whiteboard"
          disabled={!activeBoard || store.boards.length <= 1 || store.loading}
          onClick={() => setDialog("delete")}
        >
          <TrashIcon />
        </IconButton>
        <span className="ml-auto text-[10px] text-muted-foreground" role="status">
          {store.loading ? "Loading…" : store.saving ? "Saving…" : store.error ? store.error : ""}
        </span>
      </header>
      {dialog && activeBoard ? (
        <DialogBackdrop onClose={closeDialog} aria-label={`${dialog} whiteboard`}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {dialog === "rename" ? "Rename whiteboard" : "Delete whiteboard?"}
              </DialogTitle>
              {dialog === "delete" ? (
                <DialogDescription>
                  “{activeBoard.title}” will be deleted permanently.
                </DialogDescription>
              ) : null}
            </DialogHeader>
            {dialog === "rename" ? (
              <Input
                className="mt-4"
                autoFocus
                aria-label="Whiteboard name"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            ) : null}
            <DialogFooter>
              <Button variant="ghost" onClick={closeDialog}>
                Cancel
              </Button>
              <Button
                variant={dialog === "delete" ? "destructive" : "default"}
                disabled={dialog === "rename" && !title.trim()}
                onClick={() => {
                  if (dialog === "rename") void store.renameBoard(activeBoard.id, title);
                  else void store.deleteBoard(activeBoard.id);
                  closeDialog();
                }}
              >
                {dialog === "rename" ? "Rename" : "Delete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </DialogBackdrop>
      ) : null}
    </>
  );
});
