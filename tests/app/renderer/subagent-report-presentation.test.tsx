/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { ChatTextMessage } from "../../../src/renderer/components/chat-message";
import { subagentReportFindings } from "../../../src/renderer/lib/subagent-report-presentation";
import { researchOrigin } from "../../fixtures/subagent-report";
import type { SubagentReportOrigin } from "../../../src/contracts/subagents/subagent-data";

afterEach(cleanup);

it.each([
  ["complete", undefined, "Subagent complete", "The requested checks passed."],
  ["error", undefined, "Subagent failed", "Permission denied reading the requested transcript."],
  ["error", "start", "Subagent failed to start", "Could not start the selected model."],
  ["aborted", undefined, "Subagent aborted", "Partial findings retained before cancellation."],
] as const)(
  "shows %s reports with inspectable assignment and unchanged findings",
  async (status, failurePhase, heading, findings) => {
    const report: SubagentReportOrigin = {
      ...researchOrigin,
      task:
        "Read only: inspect the session transcript.\n" + "Keep the assignment intact. ".repeat(40),
      projectPath: "/projects/cake",
      status,
      ...(failurePhase ? { failurePhase } : {}),
    };
    const text = `Background subagent ${status}: ${report.task.slice(0, 500)}\n\n${findings}`;
    const view = render(
      <ChatTextMessage
        part={{
          id: "report",
          kind: "text",
          role: "user",
          text,
          status: "complete",
          subagentReport: report,
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: heading })).toBeDefined();
    const body = view.container.querySelector('[data-slot="message-content"]')!;
    expect(body.textContent).toBe(findings);
    const disclosure = screen.getByRole("button", { name: "Assignment details" });
    const details = document.getElementById(disclosure.getAttribute("aria-controls")!)!;
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(details.hidden).toBe(true);
    await userEvent.setup().click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(details.hidden).toBe(false);
    expect(within(details).getByText(report.task, { normalizer: (text) => text })).toBeDefined();
    expect(details.textContent).toContain(report.handleId);
    expect(details.textContent).toContain(report.projectPath);
    expect(details.textContent).toContain("fixture/fixture");
    await userEvent.setup().click(disclosure);
    expect(details.hidden).toBe(true);
    expect(body.textContent).toBe(findings);
    expect(report.task.length).toBeGreaterThan(500);
  },
);

it("removes only one exact Cake envelope tied to structured provenance", () => {
  const envelope = `Background subagent complete: ${researchOrigin.task}\n\n`;
  const findings = "The response quotes a similar message:\n\n" + envelope + "Quoted text.";
  expect(subagentReportFindings(envelope + findings, researchOrigin)).toBe(findings);
  for (const text of [
    findings,
    envelope,
    `Background subagent complete: A different assignment\n\nKeep this.`,
    `Background subagent error: ${researchOrigin.task}\n\nKeep this.`,
    `Introduction\n\n${envelope}Keep this.`,
    `Background subagent complete: ${researchOrigin.task}\nKeep this.`,
  ])
    expect(subagentReportFindings(text, researchOrigin)).toBe(text);
});

it("leaves an ordinary user's lookalike completion text unchanged", () => {
  const text = `Background subagent complete: ${researchOrigin.task}\n\nLiteral user text.`;
  const view = render(
    <ChatTextMessage part={{ id: "user", kind: "text", role: "user", text, status: "complete" }} />,
  );
  expect(view.container.querySelector('[data-slot="message-content"]')?.textContent).toBe(text);
});
