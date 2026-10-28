import { expect, it } from "vitest";
import {
  addArtifactPresentationReminder,
  applyArtifactExitTransition,
  artifactTargetFromReminder,
  splitArtifactPresentationReminder,
} from "../../../src/contracts/artifacts/artifact-presentation-context";
import { passiveNoticeContext } from "../../../src/contracts/conversations/passive-notice";
import type { InternalInput } from "../../../src/contracts/conversations/internal-input";
import { promptText } from "../../../src/services/pi/runtime/session-projection";
import { artifactTarget } from "../../fixtures/artifact-presentation";

it("splits exact artifact context before host attachments/image hints without removing user-authored reminders", () => {
  const text = "My quotation: <system-reminder>keep this literal note</system-reminder>";
  const decorated = addArtifactPresentationReminder(text, artifactTarget);
  const attached = promptText(decorated, [
    {
      kind: "input",
      id: "20000000-0000-4000-8000-000000000001",
      name: "shot.png",
      mimeType: "image/png",
      byteLength: 42,
    },
  ]);
  const hints =
    "\n\n[Image: original 2048x1024, displayed at 1024x512. Multiply coordinates by 2.00 to map to original image.]";
  expect(splitArtifactPresentationReminder(attached + hints)).toEqual({
    text:
      promptText(text, [
        {
          kind: "input",
          id: "20000000-0000-4000-8000-000000000001",
          name: "shot.png",
          mimeType: "image/png",
          byteLength: 42,
        },
      ]) + hints,
    reminder: splitArtifactPresentationReminder(decorated).reminder,
  });
  for (const literal of [
    text,
    decorated + "\n\nMy own following prose",
    decorated + "\n\n<cake-task-input>not JSON</cake-task-input>",
  ]) {
    expect(splitArtifactPresentationReminder(literal)).toEqual({
      text: literal,
      reminder: undefined,
    });
  }
});

it("keeps passive updates model-visible while gating the artifact exit independently", () => {
  const notices = [
    {
      id: "notice",
      text: "Background result",
      crossSession: {
        version: 1 as const,
        messageId: "20000000-0000-4000-8000-000000000001",
        threadId: "20000000-0000-4000-8000-000000000002",
        sequence: 1,
        expectsResponse: false,
        sender: { sessionId: "worker", title: "Worker", kind: "project-session" as const },
      },
    },
  ];
  const suffix = `\n\n${passiveNoticeContext(notices)}`;
  const candidate = addArtifactPresentationReminder("Outside", null);
  const origin: InternalInput = {
    _tag: "UserWithReminders",
    text: candidate,
    userText: "Outside",
    notices,
  };
  expect(applyArtifactExitTransition(candidate + suffix, false, origin)).toBe("Outside" + suffix);
  expect(applyArtifactExitTransition(candidate + suffix, true, origin)).toBe(candidate + suffix);
  expect(artifactTargetFromReminder(candidate + suffix, origin)).toBe(false);
  const entered = addArtifactPresentationReminder("Inside", artifactTarget);
  expect(artifactTargetFromReminder(entered + suffix, { ...origin, text: entered })).toBe(true);
});
