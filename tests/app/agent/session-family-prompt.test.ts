import { expect, it } from "vitest";
import child from "../../../src/domain/project-sessions/prompts/child-session-family.md?raw";
import { createSessionFamilyOperations } from "../../../src/domain/session-families/cake-session-family-operations";
import { createProjectSessionOperations } from "../../../src/domain/project-sessions/cake-session-operations";
import { resultDeliveryGuidance } from "../../../src/contracts/conversations/result-delivery";
import { backendAgentTools } from "../../../src/contracts/application/backend-agent-tools";

const unavailable = () => {
  throw Error("help must not invoke runtime");
};
const familyOperations = createSessionFamilyOperations(unavailable);
it("lets sessions.send omit its target in the shared contract", () => {
  expect(
    backendAgentTools().find((operation) => operation.command === "sessions.send")?.parameters
      .required,
  ).not.toContain("sessionId");
});

it("binds the child family prompt to its working directory", () => {
  expect(child).toContain("{{workingDirectory}}");
});

it("shares launch result semantics across launch and messaging operations", () => {
  const operations = [...familyOperations, ...createProjectSessionOperations(unavailable)];
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
});
