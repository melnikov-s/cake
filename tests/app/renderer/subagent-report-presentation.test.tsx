/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownLinkProvider } from "../../../src/renderer/components/ai-elements/markdown";
import { ChatTextMessage } from "../../../src/renderer/components/chat-message";
import { subagentReportFindings } from "../../../src/renderer/lib/subagent-report-presentation";
import { researchOrigin } from "../../fixtures/subagent-report";
import type { SubagentReportOrigin } from "../../../src/contracts/subagents/subagent-data";

afterEach(cleanup);

it.each([
  ["complete", undefined, "Subagent complete", "Completed", "The requested checks passed."],
  [
    "error",
    undefined,
    "Subagent failed",
    "Failed",
    "Permission denied reading the requested transcript.",
  ],
  ["error", "start", "Subagent failed to start", "Failed to start", "Could not start the model."],
  ["aborted", undefined, "Subagent aborted", "Aborted", "Partial findings retained."],
] as const)(
  "shows %s reports with inspectable assignment and unchanged findings",
  async (status, failurePhase, heading, badge, findings) => {
    const report: SubagentReportOrigin = {
      ...researchOrigin,
      task: "Bug-fix workflow audit\n" + "Keep the assignment intact. ".repeat(40),
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
    expect(screen.getByRole("article", { name: heading })).toBeDefined();
    // The card names the worker once, with its status as a badge.
    expect(screen.getByRole("button", { name: "Bug-fix workflow audit" }).textContent).toBe(
      `Bug-fix workflow audit${badge}`,
    );
    const body = view.container.querySelector('[data-slot="message-content"]')!;
    expect(body.textContent).toBe(findings);
    const disclosure = screen.getByRole("button", { name: "Assignment details" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.hasAttribute("aria-controls")).toBe(false);
    await userEvent.setup().click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    const details = document.getElementById(disclosure.getAttribute("aria-controls")!)!;
    expect(within(details).getByText(report.task, { normalizer: (text) => text })).toBeDefined();
    expect(details.textContent).toContain(report.handleId);
    expect(details.textContent).toContain(report.projectPath);
    expect(details.textContent).toContain("fixture/fixture");
    await userEvent.setup().click(disclosure);
    expect(details.isConnected).toBe(false);
    expect(body.textContent).toBe(findings);
    expect(report.task.length).toBeGreaterThan(500);
  },
);

it.each([
  ["Worker 10000000", "Delegated task"],
  ["", "Delegated task"],
  ["Bug-fix workflow audit", "Bug-fix workflow audit"],
])(
  "names retained worker messages from %j without changing their target",
  async (title, expected) => {
    const openSubagent = vi.fn();
    const href = `cake://subagent/parent/${researchOrigin.handleId}?message=original-answer`;
    render(
      <MarkdownLinkProvider
        actions={{ openSession: vi.fn(), openSubagent, openExternalUrl: vi.fn() }}
      >
        <ChatTextMessage
          part={{
            id: "progress",
            kind: "text",
            role: "user",
            text: "Findings retained.",
            status: "complete",
            agentSource: { title, href },
          }}
        />
      </MarkdownLinkProvider>,
    );
    expect(screen.getByRole("button", { name: expected })).toBeDefined();
    const link = screen.getByRole("link", { name: "Open conversation" });
    expect(link.getAttribute("href")).toBe(href);
    await userEvent.setup().click(link);
    expect(openSubagent).toHaveBeenCalledExactlyOnceWith(
      "parent",
      researchOrigin.handleId,
      "original-answer",
    );
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
