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
    expect(
      screen.getByRole("button", { name: "Bug-fix workflow audit" }).parentElement?.textContent,
    ).toBe(`Bug-fix workflow audit${badge}${findings}`);
    const card = screen.getByRole("button", { name: "Bug-fix workflow audit" });
    expect(card.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.querySelector('[data-slot="message-content"]')).toBeNull();
    await userEvent.setup().click(card);
    expect(card.getAttribute("aria-expanded")).toBe("true");
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
    const card = screen.getByRole("button", { name: expected });
    expect(card.getAttribute("aria-expanded")).toBe("false");
    const link = screen.getByRole("link", { name: "Open source" });
    expect(link.getAttribute("href")).toBe(href);
    await userEvent.setup().click(link);
    expect(openSubagent).toHaveBeenCalledExactlyOnceWith(
      "parent",
      researchOrigin.handleId,
      "original-answer",
    );
    expect(card.getAttribute("aria-expanded")).toBe("false");
    await userEvent.setup().click(card);
    expect(screen.getByText("Findings retained.")).toBeDefined();
    expect(card.getAttribute("aria-expanded")).toBe("true");
  },
);

it.each(["report", "worker update"] as const)(
  "preserves deliberate %s disclosure across content rerenders and keeps its source accessible",
  async (kind) => {
    const user = userEvent.setup();
    const openSubagent = vi.fn();
    const href = `cake://subagent/parent/${researchOrigin.handleId}?message=original-answer`;
    const message = (text: string) => (
      <MarkdownLinkProvider
        actions={{ openSession: vi.fn(), openSubagent, openExternalUrl: vi.fn() }}
      >
        <ChatTextMessage
          part={{
            id: "incoming",
            kind: "text",
            role: "user",
            text,
            status: "complete",
            ...(kind === "report"
              ? { subagentReport: researchOrigin }
              : { agentSource: { title: researchOrigin.task, href } }),
          }}
          reportSource={{ href }}
        />
      </MarkdownLinkProvider>
    );
    const view = render(message("Initial investigation findings."));
    const disclosure = screen.getByRole("button", { name: researchOrigin.task });
    const body = () => view.container.querySelector('[data-slot="message-content"]');
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(body()).toBeNull();
    await user.click(screen.getByRole("link", { name: "Open source" }));
    expect(openSubagent).toHaveBeenCalledExactlyOnceWith(
      "parent",
      researchOrigin.handleId,
      "original-answer",
    );
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    await user.click(disclosure);
    expect(body()?.textContent).toBe("Initial investigation findings.");
    view.rerender(message("Updated investigation findings."));
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(body()?.textContent).toBe("Updated investigation findings.");
    await user.click(disclosure);
    view.rerender(message("Final investigation findings."));
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(body()).toBeNull();
    expect(screen.getByRole("link", { name: "Open source" }).getAttribute("href")).toBe(href);
    await user.click(disclosure);
    expect(body()?.textContent).toBe("Final investigation findings.");
  },
);

it("keeps coding-session source messages expanded by default", () => {
  const view = render(
    <ChatTextMessage
      part={{
        id: "coding-session",
        kind: "text",
        role: "user",
        text: "Implementation ready for review.",
        status: "complete",
        agentSource: { title: "Coding session", href: "cake://session/coding-session" },
      }}
    />,
  );
  expect(screen.getByRole("button", { name: "Coding session" }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(view.container.querySelector('[data-slot="message-content"]')?.textContent).toBe(
    "Implementation ready for review.",
  );
});

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
