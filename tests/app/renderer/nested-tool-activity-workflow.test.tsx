/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { nestedArgumentBytes } from "../../fixtures/nested-tool-activity";
import { renderChatSurface } from "./chat-surface-workflow-fixture";
import { liveNestedActivity, savedNestedActivity } from "./nested-tool-activity-workflow-fixture";

afterEach(cleanup);

it("updates the same nested activity in place and replaces live output with metadata-only saved history", async () => {
  using fixture = renderChatSurface({ snapshot: { streaming: true } });
  fixture.publish([liveNestedActivity("partial child output", "running")], true);
  const summary = (await screen.findByText("Work log")).closest("summary");
  if (!summary) throw new Error("Missing work log disclosure");
  await fixture.user.click(summary);
  await fixture.user.click(await screen.findByRole("button", { name: /^codemode/ }));
  const region = await screen.findByRole("region", { name: "Nested tool activity" });
  const read = within(region).getByRole("button", { name: /^read/ });
  await fixture.user.click(read);
  expect(read.getAttribute("aria-expanded")).toBe("true");
  expect(region.textContent).toContain("partial child output");

  fixture.publish([liveNestedActivity("live child output", "success")], true);
  expect(within(region).getByRole("button", { name: /^read/ })).toBe(read);
  expect(read.getAttribute("aria-expanded")).toBe("true");
  expect(region.textContent).toContain("live child output");
  expect(region.textContent).not.toContain("partial child output");
  expect(region.querySelectorAll('[data-slot="tool"]')).toHaveLength(1);

  fixture.publish(savedNestedActivity());
  expect(screen.getByRole("region", { name: "Nested tool activity" })).toBe(region);
  expect(region.querySelectorAll('[data-slot="tool"]')).toHaveLength(3);
  expect(region.textContent).not.toContain("live child output");
  expect(region.textContent).toContain("Output unavailable in saved history");
  const tools = [...region.querySelectorAll<HTMLElement>('[data-slot="tool"]')];
  const cancelledRead = tools[1];
  const unfinishedWrite = tools[2];
  if (!cancelledRead || !unfinishedWrite) throw new Error("Missing recorded nested children");
  await fixture.user.click(within(cancelledRead).getByRole("button", { name: /^read/ }));
  await fixture.user.click(within(unfinishedWrite).getByRole("button", { name: /^write/ }));
  expect(cancelledRead.textContent).toContain("Recorded error summary");
  expect(cancelledRead.textContent).toContain("Read cancelled");
  expect(unfinishedWrite.textContent).toContain(
    `Arguments not recorded (${nestedArgumentBytes} bytes)`,
  );
  expect(region.textContent).toContain("Incomplete record");
  expect(screen.getByText("Returned output")).toBeDefined();
});
