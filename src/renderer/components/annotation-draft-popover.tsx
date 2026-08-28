import { useState } from "react";
import { ComposerInput } from "@/components/ai-elements/composer";
import { Button } from "@/components/ui/button";
import type { Annotation } from "../../ipc/session-contract";
import type { MessageSelectionAnchor } from "../stores/MessageCommentsStore";
import { ChatPopover, type MessageCommentAnchorRect } from "./message-comment-popover";

export function AnnotationDraftPopover({
  anchor,
  selection,
  onAdd,
  onClose,
}: {
  anchor: MessageCommentAnchorRect;
  selection: MessageSelectionAnchor;
  onAdd(annotation: Omit<Annotation, "id">): void;
  onClose(): void;
}) {
  const [comment, setComment] = useState("");
  return (
    <ChatPopover anchor={anchor} title="Add annotation" eyebrow="Selection" onClose={onClose}>
      <form
        className="grid gap-3 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          onAdd({ ...selection, comment: comment.trim() || undefined });
          onClose();
        }}
      >
        <blockquote className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
          {selection.selectedText}
        </blockquote>
        <ComposerInput
          autoFocus
          aria-label="Annotation comment"
          className="min-h-20 rounded-lg border border-border px-3"
          placeholder="Add an optional comment…"
          value={comment}
          onChange={(event) => setComment(event.currentTarget.value)}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" type="submit">
            Add annotation
          </Button>
        </div>
      </form>
    </ChatPopover>
  );
}
