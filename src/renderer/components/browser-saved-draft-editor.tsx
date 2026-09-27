import { observer } from "r-state-tree/react";
import type { BrowserSessionStore } from "../stores/BrowserSessionStore";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export const BrowserSavedDraftEditor = observer(function BrowserSavedDraftEditor({
  session,
}: {
  session: BrowserSessionStore;
}) {
  const record = session.savedDraft;
  if (record?.status !== "saved") return null;
  return (
    <div className="flex flex-col gap-2 border-b border-border p-3">
      <label htmlFor={`saved-draft-${record.sessionId}`} className="text-sm font-medium">
        Saved Draft prompt
      </label>
      <Textarea
        id={`saved-draft-${record.sessionId}`}
        value={session.savedDraftEditText}
        onChange={(event) => session.setSavedDraftEditText(event.target.value)}
        disabled={!session.connected}
      />
      <Button
        variant="outline"
        className="self-start"
        disabled={!session.connected || session.savedDraftEditText === record.text}
        onClick={() => void session.saveSavedDraftEdit()}
      >
        Save Draft
      </Button>
    </div>
  );
});
