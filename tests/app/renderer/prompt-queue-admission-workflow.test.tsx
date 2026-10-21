/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Attachment } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import {
  durableInputText,
  durableQueuedPart,
} from "../../../src/services/pi-durable/durable-input-presentation";
import { queuePart } from "./prompt-queue-workflow-fixture";
import { renderConversationSession } from "./conversation-session-workflow-fixture";

const turnId = TurnId.make("10000000-0000-4000-8000-000000000003");
const reference: Attachment = {
  kind: "input",
  id: "20000000-0000-4000-8000-000000000003",
  name: "Pasted text · 52 lines",
  mimeType: "text/plain",
  byteLength: 400,
};
const log = "QUEUED_LOG\n" + "details\n".repeat(50);
const labels = () =>
  within(screen.getByRole("list", { name: "Queued prompts" }))
    .getAllByRole("button", { name: /^View queued message:/ })
    .map((button) => button.textContent);
afterEach(cleanup);

describe.each(["project", "cake-chat", "project-chat"] as const)(
  "%s queue admission",
  (profile) => {
    it("does not steer B or submit C while a pasted image is still being read", async () => {
      const reads: Array<() => void> = [];
      const read = FileReader.prototype.readAsDataURL;
      const reader = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (
        this: FileReader,
        blob: Blob,
      ) {
        reads.push(() => read.call(this, blob));
      });
      const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => turnId);
      const steer = vi.fn<Client["sessionChats"]["steerQueuedMessage"]>(async () => ({
        steering: ["B"],
        followUp: [],
      }));
      using fixture = renderConversationSession(
        profile,
        { sessionChats: { prompt, steerQueuedMessage: steer } },
        [queuePart(2, "B")],
      );
      try {
        const input = screen.getByRole("combobox");
        await fixture.user.click(input);
        fireEvent.paste(input, {
          clipboardData: {
            getData: () => "",
            files: [new File(["pixels"], "queued.png", { type: "image/png" })],
          },
        });
        expect(reads).toHaveLength(1);
        await fixture.user.keyboard("{Enter}");
        expect(steer).not.toHaveBeenCalled();
        await fixture.user.type(input, "C");
        await fixture.user.keyboard("{Enter}");
        expect(prompt).not.toHaveBeenCalled();
        await act(async () => {
          reads[0]!();
        });
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "View queued.png enlarged" })).toBeDefined(),
        );
        await fixture.user.click(screen.getByRole("button", { name: "Queue for later" }));
        expect(prompt).toHaveBeenCalledOnce();
        expect(prompt.mock.calls[0]?.[0]).toMatchObject({
          text: "C",
          attachments: [{ kind: "image", name: "queued.png" }],
        });
        expect(labels()).toEqual(["B", "C"]);
        expect(steer).not.toHaveBeenCalled();
      } finally {
        reader.mockRestore();
      }
    });

    it.each(
      (["text", "attachment", "attachment-only", "same-text-attachment"] as const).flatMap(
        (variant) => [false, true].map((ackFirst) => ({ variant, ackFirst })),
      ),
    )(
      "keeps B then C ($variant, ackFirst=$ackFirst) queued once through admission",
      async ({ variant, ackFirst }) => {
        const text =
          variant === "attachment-only" ? "" : variant === "same-text-attachment" ? "B" : "C";
        const attachments = variant === "text" ? [] : [reference];
        const projected = (index: number, text: string, attachments: Attachment[] = []) =>
          profile === "project"
            ? queuePart(index, text, { attachments })
            : durableQueuedPart(
                {
                  id: index as SubmissionId,
                  mode: "followUp",
                  content: durableInputText(text, attachments, false),
                },
                `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
              );
        const b = projected(2, "B");
        const c = projected(3, text, attachments);
        const acknowledgement = Promise.withResolvers<void>();
        const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => {
          await acknowledgement.promise;
          return turnId;
        });
        const steer = vi.fn<Client["sessionChats"]["steerQueuedMessage"]>(async () => {
          fixture.publish({ parts: [{ ...c, deliveryState: "steering" }, b] });
          return { steering: [text], followUp: ["B"] };
        });
        using fixture = renderConversationSession(
          profile,
          {
            sessionChats: { prompt, steerQueuedMessage: steer },
          },
          [b],
        );
        const input = screen.getByRole("combobox");
        await fixture.user.click(input);
        if (variant !== "text") await fixture.user.paste(log);
        if (text) await fixture.user.type(input, text);
        await fixture.user.click(screen.getByRole("button", { name: "Queue for later" }));
        const label = text || "1 attachment";
        expect(labels()).toEqual(["B", label]);
        expect(
          within(screen.getByRole("group", { name: "Queued" })).getByRole("status").textContent,
        ).toBe("Sending…");
        expect(screen.queryByRole("group", { name: "Steering" })).toBeNull();
        expect(
          within(screen.getByLabelText("Conversation")).queryByText(reference.name),
        ).toBeNull();
        // The draft was consumed, but C has not been acknowledged. Another
        // Enter must not mistake that temporary emptiness for steering B.
        await fixture.user.click(input);
        await fixture.user.keyboard("{Enter}");
        expect(steer).not.toHaveBeenCalled();
        expect(prompt).toHaveBeenCalledOnce();
        const acknowledge = () =>
          act(async () => {
            acknowledgement.resolve();
            await acknowledgement.promise;
          });
        if (ackFirst) await acknowledge();
        // Both orders occur across RPC acknowledgement and projection transport.
        fixture.publish({ parts: [b, c] });
        expect(labels()).toEqual(["B", label]);
        expect(screen.queryByRole("group", { name: "Steering" })).toBeNull();
        if (!ackFirst) await acknowledge();
        expect(labels()).toEqual(["B", label]);
        expect(prompt).toHaveBeenCalledOnce();
        expect(steer).not.toHaveBeenCalled();
        expect(prompt.mock.calls[0]?.[0]).toMatchObject({
          text,
          attachments: variant === "text" ? [] : [{ kind: "text", text: log }],
        });
        await fixture.user.click(
          screen.getAllByRole("button", { name: `Send now as steering: ${label}` }).at(-1)!,
        );
        expect(labels()).toEqual([label, "B"]);
        expect(
          within(screen.getByRole("group", { name: "Steering" })).getAllByRole("listitem"),
        ).toHaveLength(1);
        expect(
          within(screen.getByRole("group", { name: "Queued" })).getAllByRole("listitem"),
        ).toHaveLength(1);
        expect(steer).toHaveBeenCalledOnce();
      },
    );
  },
);
