import { createRoot } from "react-dom/client";
import type { UiPart } from "../../src/contracts/conversations/session-contract";
import { ChatTextMessage } from "../../src/renderer/components/chat-message";
import { WidgetItemAttachment } from "../../src/renderer/components/widget-item-attachment";
import { Badge } from "../../src/renderer/components/ui/badge";
import { AttachmentReference } from "../../src/renderer/components/ui/attachment-reference";
import { SourceAttachment } from "../../src/renderer/components/source-attachment";

const longName =
  "#2394891 self-healing: give the goal rubric a verification standard for automated recovery attempts across every reviewed pull request";
const unbroken = `artifact-${"x".repeat(160)}`;
const text = [
  "Can you pick this one up next and check whether the rubric covers the screenshot evidence?",
  `https://github.com/example/world/pull/2394891/files#diff-${"0123456789abcdef".repeat(8)}`,
  unbroken,
].join("\n");

const part: Extract<UiPart, { kind: "text" }> = {
  kind: "text",
  id: "user-long",
  role: "user",
  text,
};
const markdownPart = { ...part, id: "user-long-markdown", renderAs: "markdown" as const };

const attachments = (
  <>
    <WidgetItemAttachment
      presentation="transcript"
      item={{
        name: longName,
        itemId: "pr-2394891",
        widget: { lineageId: "pull-requests", title: "Pull requests", revision: 1 },
      }}
    />
    {/* Mirrors the transcript file-name chip in chat-transcript-part.tsx. */}
    <Badge variant="mono" className="w-fit rounded-xl">
      {`/Users/example/${unbroken}.log`}
    </Badge>
    <AttachmentReference
      sessionId="session"
      reference={{
        id: "reference",
        name: `${longName}.md`,
        mimeType: "text/markdown",
        byteLength: 10,
      }}
    />
    <SourceAttachment
      attachment={{
        name: "source",
        location: { path: `src/${unbroken}/component.tsx` },
        selectedText: unbroken,
      }}
    />
  </>
);

/** Columns sized like the desktop transcript and a phone viewport; both clip horizontally. */
function Column({ width, id }: { width: number; id: string }) {
  return (
    <section
      data-testid={id}
      style={{
        width,
        overflowX: "hidden",
        overflowY: "auto",
        padding: 16,
        display: "grid",
        gap: 24,
      }}
    >
      <ChatTextMessage part={part} beforeContent={attachments} />
      <ChatTextMessage part={markdownPart} beforeContent={attachments} />
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <main className="bg-background p-4 text-foreground" style={{ display: "grid", gap: 32 }}>
    <Column id="desktop" width={720} />
    <Column id="phone" width={360} />
  </main>,
);
