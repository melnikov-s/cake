import { type Effect, Schema } from "effect";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import {
  CanvasDetail,
  CanvasPublish,
  CanvasRead,
  CanvasResults,
  CanvasSearch,
  type ProjectCanvasControl,
} from "../../contracts/project-canvas/project-canvas";
import * as canvas from "./projectCanvas";

export const makeProjectCanvasControl = (
  id: string,
  publisher: string,
  run: <A, E>(
    effect: Effect.Effect<A, E, Effect.Services<ReturnType<typeof canvas.publish>>>,
    options: { signal: AbortSignal },
  ) => Promise<A>,
): ProjectCanvasControl => ({
  publish: (input, signal) => run(canvas.publish(id, publisher, input), { signal }),
  search: (input, signal) => run(canvas.search(id, input), { signal }),
  read: ({ link }, signal) => run(canvas.read(id, link), { signal }),
});

export const createProjectCanvasOperations = (
  control: ProjectCanvasControl,
): CakeOperationDefinition[] => [
  {
    command: "canvas.publish",
    topic: "canvas",
    summary: "Publish to the calling project’s Canvas",
    inputSchema: CanvasPublish,
    outputSchema: CanvasDetail,
    canonicalSessionIds: true,
    guidance: [
      "Publish deliberately for review, never auto-post transcripts, captures, or commits. Use a short decision, an image from attachments.list, or an accessible Cake artifact reference. Attachments and artifacts are retained by their existing Cake stores.",
    ],
    examples: [
      {
        input: {
          group: "Checkout review",
          title: "Decision",
          content: { kind: "decision", text: "Keep guest checkout on the first screen." },
        },
      },
    ],
    limitations: [
      "Use the current exact card link as previous to append a revision. Pass the same group and set aspect to the screenshot width divided by height if known. Stable artifact references freeze to the exact revision at publication. Optionally give an artifact a screenshot using content.previewAttachmentId from attachments.list.",
    ],
    result: "New exact Canvas link, stable card link, and revision history.",
    execute: (input, { signal }) =>
      control.publish(Schema.decodeUnknownSync(CanvasPublish)(input), signal),
  },
  {
    command: "canvas.search",
    topic: "canvas",
    summary: "Find published Canvas cards",
    inputSchema: CanvasSearch,
    outputSchema: CanvasResults,
    canonicalSessionIds: true,
    examples: [{ input: { query: "checkout" } }, { input: {} }],
    result:
      "Up to twenty matching cards; omit query to list, continue with nextOffset. Links point to the matched exact revision.",
    execute: (input, { signal }) =>
      control.search(Schema.decodeUnknownSync(CanvasSearch)(input), signal),
  },
  {
    command: "canvas.read",
    topic: "canvas",
    summary: "Read a Canvas card revision and pinned feedback",
    examples: [
      {
        input: {
          link: `cake://canvas/project-chat:${"a".repeat(64)}/00000000-0000-4000-8000-000000000001@r1`,
        },
      },
    ],
    inputSchema: CanvasRead,
    outputSchema: CanvasDetail,
    canonicalSessionIds: true,
    result:
      "The selected revision, its exact source reference, its pins, and revision history. Board reads do not notify or wake sessions.",
    execute: (input, { signal }) =>
      control.read(Schema.decodeUnknownSync(CanvasRead)(input), signal),
  },
];
