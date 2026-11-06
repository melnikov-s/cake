import { useEffect, useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import { Markdown } from "./ai-elements/markdown";
import { Button } from "./ui/button";
import { CopyButton } from "./ui/copy-button";
import { IconButton } from "./ui/icon-button";
import { CloseIcon } from "./ui/icons";
import { PopoverContent } from "./ui/popover";
import { Textarea } from "./ui/textarea";
import type { ChatStore, QueuedPrompt } from "../stores/ChatStore";

export const QueuedPromptPopover = observer(function QueuedPromptPopover({
  store,
  entry,
  initiallyEditing,
  onClose,
}: {
  store: ChatStore;
  entry: QueuedPrompt;
  initiallyEditing: boolean;
  onClose(): void;
}) {
  const [editing, setEditing] = useState(initiallyEditing);
  const [draft, setDraft] = useState(entry.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const editable = entry.editable !== false && !entry.provenance && store.canEditQueuedPrompt;
  useEffect(() => {
    if (editing) textarea.current?.focus();
    else editButton.current?.focus();
  }, [editing]);
  const finishEdit = () => {
    setEditing(false);
    setError(undefined);
  };
  const save = async () => {
    if (saving || (!draft.trim() && !entry.attachments.length)) return;
    setSaving(true);
    setError(undefined);
    try {
      if (await store.editQueuedPrompt(entry.id, draft)) finishEdit();
      else setError("Couldn't save this queued message. Try again.");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <PopoverContent
      side="top"
      align="start"
      initialFocusSelector={initiallyEditing ? "textarea" : undefined}
      aria-label={entry.state === "steering" ? "Steering message" : "Queued message"}
      className="flex max-h-[min(32rem,70dvh)] w-[32rem] flex-col gap-3 overflow-hidden p-3"
    >
      <div className="flex shrink-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {entry.source ? (
            <Markdown>{`[${entry.source.sender.title.replace(/[\\`*_[\]]/g, "\\$&")}](cake://session/${encodeURIComponent(entry.source.sender.sessionId)})`}</Markdown>
          ) : entry.state === "steering" ? (
            "Steering message"
          ) : (
            "Queued message"
          )}
        </span>
        <CopyButton getText={async () => (editing ? draft : entry.text)} label="queued message" />
        {editable && (
          <Button
            ref={editButton}
            variant="ghost"
            size="sm"
            disabled={entry.pending || editing}
            onClick={() => {
              setDraft(entry.text);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
        <IconButton tooltip="Close" ariaLabel="Close queued message" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
      {editing ? (
        <Textarea
          ref={textarea}
          aria-label="Queued message text"
          className="min-h-32 flex-1 resize-none overflow-y-auto text-sm"
          value={draft}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            }
          }}
        />
      ) : (
        <div className="min-h-0 overflow-y-auto overscroll-contain text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {entry.renderUserMessageAsMarkdown ? (
            <Markdown>{entry.text}</Markdown>
          ) : (
            entry.text || `${entry.attachments.length} attachments`
          )}
        </div>
      )}
      {error && (
        <div role="alert" className="text-xs text-destructive">
          {error}
        </div>
      )}
      {editing && (
        <div className="flex shrink-0 justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={saving} onClick={finishEdit}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={saving || entry.pending || (!draft.trim() && !entry.attachments.length)}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </PopoverContent>
  );
});
