import { expect, it } from "vitest";
import common from "../../../src/services/pi/runtime/prompts/common.md?raw";
import project from "../../../src/services/pi/runtime/prompts/project.md?raw";
import child from "../../../src/domain/project-sessions/prompts/child-session-family.md?raw";
import parent from "../../../src/domain/project-sessions/prompts/parent-session-family.md?raw";
import workgroups from "../../../docs/agent/workgroups.md?raw";
import delegation from "../../../docs/agent/family-delegation.md?raw";
import lifecycle from "../../../docs/agent/family-lifecycle.md?raw";
import { createSessionFamilyOperations } from "../../../src/domain/session-families/cake-session-family-operations";
import { createProjectSessionOperations } from "../../../src/domain/project-sessions/cake-session-operations";
import { resultDeliveryGuidance } from "../../../src/contracts/conversations/result-delivery";
import { backendAgentTools } from "../../../src/contracts/application/backend-agent-tools";
it("keeps family authority and startup self-contained", () => {
  for (const rule of [
    "Family coordination defaults to Workboard, including descendants",
    "explicit user exceptions apply",
    "assignment: { description, body }",
    "verify launch, not just posting",
    "Honor stops",
  ])
    expect(project).toContain(rule);
  expect(child).toContain("Fixed Working Directory: {{workingDirectory}}");
  expect(child).toContain("Only the root resolves/restores");
  expect(child).toContain("Start directly");
  expect(parent).toContain("every member inactive");
  expect(workgroups).toContain("No private messages, outsider relays or duplicate wake-ups");
  expect(delegation).toContain("returned requestId and unchanged assignment");
  expect(lifecycle).toContain("Never land manually");
});
it("shares launch result semantics without prerequisite guide reads", () => {
  const unavailable = () => {
    throw Error("help must not invoke runtime");
  };
  const operations = [
    ...createSessionFamilyOperations(unavailable),
    ...createProjectSessionOperations(unavailable),
  ];
  for (const command of [
    "sessions.create-child",
    "session.create",
    "sessions.send",
    "sessions.reply",
    "sessions.send-batch",
  ])
    expect(operations.find((o) => o.command === command)?.guidance, command).toContain(
      resultDeliveryGuidance,
    );
  expect(common).toContain(
    "reply for owed answers/dependencies, notification for background review",
  );
  expect(common).toContain("No acknowledgment-only replies or duplicate reports");
  expect(common).toContain("Private pending reports: reports.md");
  expect(operations.find((o) => o.command === "sessions.send")?.guidance?.join("\n")).toContain(
    "receiving a report or notification does not require a response",
  );
  expect(operations.find((o) => o.command === "sessions.reply")?.guidance?.join("\n")).toContain(
    "Do not reply merely to acknowledge",
  );
  expect(project).toContain("No prerequisite guide reads");
  expect(
    operations.find((o) => o.command === "sessions.create-child")?.guidance?.join("\n"),
  ).toContain("no prerequisite guide reads");
});
it("limits report-tool guidance to existing private-report bookkeeping in both tool catalogs", () => {
  const operations = createSessionFamilyOperations(() => {
    throw Error("help must not invoke runtime");
  });
  for (const catalog of [operations, backendAgentTools()]) {
    const guidance = catalog
      .find((operation) => operation.command === "sessions.reports.acknowledge")
      ?.guidance?.join("\n");
    for (const rule of [
      "Only for pending private reports actually communicated",
      "their IDs with exact already-emitted communicatedText",
      "mark handled and stop reminders, not to reply to the sender",
      "Never planned prose/intake/tool receipts/unrelated answers",
      "persisted visible text",
      "Dismiss only by user decision",
    ])
      expect(guidance).toContain(rule);
  }
});
