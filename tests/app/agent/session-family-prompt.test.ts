import { describe, expect, it } from "vitest";
import projectTemplate from "../../../src/services/pi/runtime/prompts/project.md?raw";
import commonTemplate from "../../../src/services/pi/runtime/prompts/common.md?raw";
import parentTemplate from "../../../src/domain/project-sessions/prompts/parent-session-family.md?raw";
import childTemplate from "../../../src/domain/project-sessions/prompts/child-session-family.md?raw";
import workgroups from "../../../docs/agent/workgroups.md?raw";
import delegation from "../../../docs/agent/family-delegation.md?raw";
import coordination from "../../../docs/agent/family-coordination.md?raw";
import lifecycle from "../../../docs/agent/family-lifecycle.md?raw";
import communication from "../../../docs/agent/communication.md?raw";
import { renderPromptTemplate } from "../../../src/services/pi/runtime/prompt-template";
import { createSessionFamilyOperations } from "../../../src/domain/session-families/cake-session-family-operations";
import { createProjectSessionOperations } from "../../../src/domain/project-sessions/cake-session-operations";
import { resultDeliveryGuidance } from "../../../src/contracts/conversations/result-delivery";

const project = renderPromptTemplate(projectTemplate, {
  cakeDocsDirectory: "/cake/docs",
  commonPrompt: renderPromptTemplate(commonTemplate),
});
const child = renderPromptTemplate(childTemplate, {
  familyId: "family-1",
  parentSessionId: "12345678",
  workingDirectory: "/worktrees/child",
});

describe("Project Session family guidance", () => {
  it("keeps essential identity and safety in the injected context", () => {
    expect(project).toContain("parents, children, siblings and recursive descendants");
    expect(project).toContain("communicate exclusively via Workboard");
    expect(project).toContain("no private messages, duplicates or relaying via outsiders");
    expect(project).toContain(
      "User-facing replies, Cake Chat and unrelated sessions are outside this rule",
    );
    expect(project).toContain("Current explicit user exceptions apply");
    expect(project).toContain("Cake persists it before launch");
    expect(project).toContain("No board: disclose, never invent/fallback");
    expect(project).toContain("Verify launch/delivery, not posting");
    expect(project).toContain("Honor stops/cancellations");
    expect(parentTemplate).toContain("Only the family root resolves/restores");
    expect(child).toContain("family family-1; immediate parent: 12345678");
    expect(child).toContain("Working Directory is fixed at /worktrees/child");
    expect(child).toContain("cannot resolve/restore independently");
    expect(child).toContain("every member inactive");
    expect(child).toContain("Use the substantive startup assignment");
    expect(child).toContain("initial prompt includes the full persisted Workboard assignment");
    expect(child).toContain("no initial board read is needed");
    expect(child).toContain("durable assignment and results");
  });

  it("keeps operational details behind named task guides", () => {
    expect(project).toContain("Cake documentation directory: `/cake/docs`");
    expect(project).toContain("`workgroups.md`: family entry guide");
    expect(project).toContain("follow its task-specific guides only as needed");
    for (const guide of ["family-delegation.md", "family-coordination.md", "family-lifecycle.md"])
      expect(workgroups).toContain(guide);
    expect(workgroups).toContain("not the whole family manual");
    expect(parentTemplate.length).toBeLessThan(450);
    expect(child.length).toBeLessThan(950);
    expect(workgroups.length).toBeLessThan(2_800);
    const role = renderPromptTemplate(projectTemplate, {
      cakeDocsDirectory: "/cake/docs",
      commonPrompt: "",
    });
    expect(role.length).toBeLessThan(1_500);
    expect(commonTemplate.length).toBeLessThan(2_500);
    expect(project).not.toContain("{{");
    expect(delegation).toContain("they do not accept a board ID");
    expect(delegation).toContain("before admitting the first child turn");
    expect(delegation).toContain("durable original");
    expect(delegation).toContain("Cake includes the full persisted assignment");
    expect(delegation).toContain("no initial board read is needed");
    expect(coordination).toContain("do not reread that entry just to start work");
    expect(delegation).toContain("Inspect the returned `launch` outcome");
    expect(delegation).toContain("returned `requestId` and unchanged assignment");
    for (const operation of ["boards.current", "boards.read-new", "boards.read"])
      expect(coordination).toContain(operation);
    expect(coordination).toContain("`nextAfter` as `after`");
    expect(coordination).toContain("`supersedes: [sequence, ...]`");
    expect(coordination).toContain('audience: "workgroup"');
    expect(coordination).toContain(
      "A user-facing final answer is not a substitute for this board result",
    );
    expect(coordination).toContain("explicit audience and the unique family root");
    expect(lifecycle).toContain("uncommitted edits remain");
    expect(lifecycle).toContain("never merge a child's branch by hand");
    expect(lifecycle).toContain("resolution requires every member to be inactive");
  });

  it("makes dependent-result selection explicit without adding a wait or private wake-up", () => {
    expect(project).toContain(
      "At launch set resultDelivery: reply for dependent actions/answers owed",
    );
    expect(project).toContain("notification for background review");
    expect(project).toContain("not a wait");
    expect(project).toContain("authorized work needs no new approval");
    expect(project).toContain("Outbound delivery is separate");
    expect(delegation).toContain('set `resultDelivery: "reply"`');
    expect(delegation).toContain("no fresh authorization is needed merely to select reply");
    expect(communication).toContain("notification for background work the user will review later");
    expect(communication).toContain("implementation needed for the next action uses reply too");
    expect(communication).toContain("queue a non-interrupting");
    expect(communication).toContain(
      "neither clears that obligation nor guarantees a dependent parent continuation",
    );
    expect(communication).toContain(
      "Prompt text cannot disable or reroute existing runtime obligations",
    );
    expect(communication).toContain(
      "Do not send an extra `sessions.reply`, private wake-up or duplicate report",
    );
    expect(project).toContain("Polling/check-ins require explicit user request");
  });

  it("shares the decision rule in launch/send/reply help and demonstrates dependent launch", () => {
    const unavailableApi = () => {
      throw new Error("Help inspection must not invoke runtime operations");
    };
    const operations = [
      ...createSessionFamilyOperations(unavailableApi),
      ...createProjectSessionOperations(unavailableApi),
    ];
    for (const command of [
      "sessions.create-child",
      "session.create",
      "sessions.send",
      "sessions.reply",
      "sessions.send-batch",
    ]) {
      const guidance = operations.find((operation) => operation.command === command)?.guidance;
      expect(guidance, command).toContain(resultDeliveryGuidance);
    }
    const childOperation = operations.find(
      (operation) => operation.command === "sessions.create-child",
    );
    expect(childOperation?.guidance?.join("\n")).toContain("family-delegation.md before launch");
    const example = childOperation?.examples?.[0]?.input;
    expect(example).toMatchObject({ resultDelivery: "reply" });
    expect(example?.assignment).toMatchObject({
      description: expect.any(String),
      body: expect.any(String),
    });
  });
});
