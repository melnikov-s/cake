/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { deliveryGate } from "./conversation-delivery-workflow-fixture";
import { renderConversationSession } from "./conversation-session-workflow-fixture";

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
