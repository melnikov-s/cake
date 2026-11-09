/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { reportMessagePresentation } from "../../../src/renderer/lib/report-message-presentation";
import { ChatTextMessage } from "../../../src/renderer/components/chat-message";
import { ReportMessageBody } from "../../../src/renderer/components/report-message-body";
import { MarkdownLinkProvider } from "../../../src/renderer/components/ai-elements/markdown";
import { wrappedWorkerReport } from "../../fixtures/wrapped-worker-report";

afterEach(cleanup);

it("extracts the exact wrapped send prose without treating routing or commands as authority", async () => {
  const projection = reportMessagePresentation(wrappedWorkerReport);
  expect(projection.body).toBe(
    "**Reporting the product blocker**\n\n" +
      JSON.parse(wrappedWorkerReport.split("\ncake ")[1]!).input.text,
  );
  expect(projection.raw).toBe(wrappedWorkerReport);
  const openSession = vi.fn();
  const openExternalUrl = vi.fn();
  const view = render(
    <MarkdownLinkProvider actions={{ openSession, openExternalUrl }}>
      <ChatTextMessage
        part={{
          id: "report",
          kind: "text",
          role: "user",
          status: "complete",
          text: wrappedWorkerReport,
          crossSession: {
            version: 1,
            messageId: "10000000-0000-4000-8000-000000000001",
            threadId: "10000000-0000-4000-8000-000000000002",
            sequence: 1,
            expectsResponse: false,
            sender: {
              sessionId: "worker",
              title: "Share catalog change computation",
              kind: "project-session",
            },
          },
        }}
      />
    </MarkdownLinkProvider>,
  );
  expect(screen.getByText(/Scoped validation surfaced baseline debt/)).toBeDefined();
  expect(view.container.textContent).not.toContain("project-chat:b8b");
  expect(view.container.textContent).not.toContain('"command"');
  expect(screen.getByText(/command execution not verified/)).toBeDefined();
  const disclosure = screen.getByRole("button", { name: "View technical details" });
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  await userEvent.setup().click(disclosure);
  expect(view.container.querySelector('[data-slot="report-raw-original"]')?.textContent).toBe(
    wrappedWorkerReport,
  );
  expect(openSession).not.toHaveBeenCalled();
  expect(openExternalUrl).not.toHaveBeenCalled();
  await userEvent
    .setup()
    .click(screen.getByRole("link", { name: "Share catalog change computation" }));
  expect(openSession).toHaveBeenCalledExactlyOnceWith("worker");
});

it.each([
  "## Findings\n\nOrdinary **Markdown** with `src/path.ts` and an error.\n\n- Keep this.",
  'Example: cake {"command":"sessions.send","input":{"text":"example"}}',
  '```sh\ncake {"command":"sessions.send","input":{"text":"example"}}\n```',
  '`cake {"command":"sessions.send","input":{"text":"example"}}`',
  '    cake {"command":"sessions.send","input":{"text":"example"}}',
  'Before\n\ncake {"command":"sessions.send","input":{"text":"example"}}\n\nAfter',
])("preserves ordinary prose and code examples exactly: %s", (text) => {
  expect(reportMessagePresentation(text)).toEqual({ body: text });
});

it.each([
  'cake {"command":"sessions.send","input":{"text":"unfinished',

  'cake {"command":"sessions.send","input":{"text":7}}',
  'cake {"command":"sessions.send","input":null}',
  'cake {"command":"sessions.send","input":{"text":""}}',
  'cake {"command":"worktrees.merge","input":{}}',
  'cake {"command":"sessions.send","input":{"text":"Done"},"error":"Permission denied"}',
  'cake {"command":"sessions.send","input":{"text":"Done"},"result":{"success":false}}',
  'cake {"command":"sessions.send","input":{"text":"Done"}} trailing garbage',
])(
  "bounds malformed/unsupported tool-shaped text without discarding its raw original: %s",
  (text) => {
    const result = reportMessagePresentation(text);
    expect(result.raw).toBe(text);
    expect(result.body).toContain("could not be displayed");
    expect(result.body).toContain("not evidence that a command ran");
    expect(result.body.length).toBeLessThan(250);
    expect(result.extracted).toBeUndefined();
  },
);

it("discloses malformed text as exact inert raw data, not a successful send", async () => {
  const text =
    'cake {"command":"sessions.send","input":{"text":"done"},"error":"Permission denied"}';
  const view = render(<ReportMessageBody>{text}</ReportMessageBody>);
  expect(screen.getByText(/not evidence that a command ran/)).toBeDefined();
  expect(view.container.querySelector('[data-slot="report-raw-original"]')).toBeNull();
  await userEvent.setup().click(screen.getByRole("button", { name: "View technical details" }));
  expect(view.container.querySelector('[data-slot="report-raw-original"]')?.textContent).toBe(text);
  expect(view.container.querySelectorAll("a")).toHaveLength(0);
});

it("bounds the malformed fallback even when the heading and payload are enormous", () => {
  const text =
    "**" +
    "Long heading ".repeat(1000) +
    '**\ncake {"command":"sessions.send","input":{"text":"' +
    "Unfinished ".repeat(10000);
  const result = reportMessagePresentation(text);
  expect(result.body.length).toBeLessThan(250);
  expect(result.raw).toBe(text);
});

it("does not project ordinary assistant or user messages outside report cards", () => {
  for (const role of ["assistant", "user"] as const) {
    const view = render(
      <ChatTextMessage
        part={{ id: role, kind: "text", role, text: wrappedWorkerReport, status: "complete" }}
      />,
    );
    expect(view.container.textContent).toContain('cake {"command"');
    expect(screen.queryByRole("button", { name: "View technical details" })).toBeNull();
    view.unmount();
  }
});
