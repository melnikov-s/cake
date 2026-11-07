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
  expect(project).toContain("No prerequisite guide reads");
  expect(
    operations.find((o) => o.command === "sessions.create-child")?.guidance?.join("\n"),
  ).toContain("no prerequisite guide reads");
});
