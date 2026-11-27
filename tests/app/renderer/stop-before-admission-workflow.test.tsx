/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { deliveryGate } from "./conversation-delivery-workflow-fixture";
import {
  renderConversationSession,
  workingAssistantPart,
} from "./conversation-session-workflow-fixture";

const firstTurn = TurnId.make("10000000-0000-4000-8000-000000000001");
const secondTurn = TurnId.make("10000000-0000-4000-8000-000000000002");
afterEach(cleanup);

it("applies a Stop pressed before admission to that send once admitted, and never to a later one", async () => {
  const admissions = [deliveryGate<TurnId>(), deliveryGate<TurnId>()];
  let call = 0;
  const prompt = vi.fn(() => admissions[call++]!.promise);
  const abort = vi.fn(async () => {});
  using fixture = renderConversationSession(
    "project",
    { sessionChats: { prompt, abort } },
    [],
    "Snapshot",
  );
  // An idle observed session: nothing is streaming before the first send.
  fixture.publish({ parts: [], streaming: false });
  const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: fixture.inputLabel });
  await fixture.user.type(input, "Start some work{Enter}");
  await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
  // The send is still awaiting admission: Stop is offered, but there is no turn to stop yet.
  await fixture.user.click(screen.getByRole("button", { name: "Stop" }));
  expect(abort).not.toHaveBeenCalled();
  await act(async () => admissions[0]!.resolve(firstTurn));
  expect(abort).toHaveBeenCalledOnce();
  // The remembered Stop was consumed by that turn; a later send is not stopped.
  await fixture.user.type(input, "Later work{Enter}");
  await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
  await act(async () => admissions[1]!.resolve(secondTurn));
  expect(abort).toHaveBeenCalledOnce();
});

it("keeps the empty Project Chat composer on disabled Send when a passive notice arrives", () => {
  const prompt = vi.fn();
  using fixture = renderConversationSession("project-chat", { sessionChats: { prompt } }, []);
  fixture.publish({ streaming: false });
  const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send" });
  expect(send.disabled).toBe(true);

  fixture.incoming([
    {
      id: "passive-notice",
      kind: "notice",
      tone: "info",
      title: "Passive project update",
    },
  ]);
  expect(screen.getByText("Passive project update")).toBeDefined();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" })).toBe(send);
  expect(send.disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(prompt).not.toHaveBeenCalled();
});

it("keeps Project Chat Stop available during send admission and live work, then restores disabled Send", async () => {
  const admission = deliveryGate<TurnId>();
  const prompt = vi.fn(() => admission.promise);
  const abort = vi.fn(async () => {});
  using fixture = renderConversationSession(
    "project-chat",
    { sessionChats: { prompt, abort } },
    [],
  );
  fixture.publish({ streaming: false });
  const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: fixture.inputLabel });
  const stop = () => screen.getByRole<HTMLButtonElement>("button", { name: "Stop" });
  const sessionId = fixture.sessionId;

  await fixture.user.type(input, "Start work{Enter}");
  await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
  expect(input.value).toBe("");
  expect(stop().disabled).toBe(false);

  fixture.event({ _tag: "TurnAccepted", sessionId, turnId: firstTurn, delivery: "prompt" });
  await act(async () => admission.resolve(firstTurn));
  expect(stop().disabled).toBe(false);

  fixture.event({ _tag: "StreamingChanged", sessionId, streaming: true });
  await fixture.user.click(stop());
  expect(abort).toHaveBeenCalledOnce();
  fixture.event({ _tag: "TurnSettled", sessionId, turnId: firstTurn, outcome: "complete" });
  expect(stop().disabled).toBe(false);
  fixture.publish({ streaming: false, parts: [{ ...workingAssistantPart, status: "complete" }] });
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(true);
});
