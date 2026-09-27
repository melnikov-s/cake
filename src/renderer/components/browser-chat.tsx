import { observer } from "r-state-tree/react";
import { Chat } from "./chat";
import { ArtifactHost } from "./artifact-host";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import type { BrowserSessionStore } from "../stores/BrowserSessionStore";

export const BrowserChat = observer(function BrowserChat({
  session,
}: {
  session: BrowserSessionStore;
}) {
  const request = session.interaction.request;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {session.uncertain && (
        <Callout variant="warning" role="alert">
          Delivery is uncertain. Reconnection never sends your message again. Check the transcript
          before deciding.
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!session.readyToReconcile}
              onClick={() => session.acknowledgeUncertainty(true)}
            >
              Discard retained draft
            </Button>
            <Button
              variant="outline"
              disabled={!session.readyToReconcile}
              onClick={() => session.acknowledgeUncertainty(false)}
            >
              Keep draft for deliberate resend
            </Button>
          </div>
        </Callout>
      )}
      {session.created && !session.opened && session.connected && (
        <Button variant="outline" disabled={session.opening} onClick={() => void session.open()}>
          Retry opening chat
        </Button>
      )}
      <Chat
        store={session.chat}
        empty={
          <p className="p-6 text-sm text-muted-foreground">
            Send a message to start this Project Session. Drafts stay in this tab only.
          </p>
        }
        transcriptBehavior={{ artifacts: { interaction: session.interaction, records: [] } }}
        footer={
          request && (
            <div className="grid gap-2">
              {!session.model.uiParts.some(
                (part) => part.kind === "tool" && part.artifactId === request.record.artifact.id,
              ) && (
                <ArtifactHost
                  record={request.record}
                  requested
                  onSubmit={(value) => void session.interaction.respond(value)}
                  onSkip={() => void session.interaction.respond(undefined, true)}
                />
              )}
              <Button
                variant="outline"
                disabled={!session.connected || session.interaction.responding}
                onClick={() => void session.interaction.respond(undefined, true)}
              >
                Skip question
              </Button>
            </div>
          )
        }
      />
    </div>
  );
});
