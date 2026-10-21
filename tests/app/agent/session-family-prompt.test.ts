import { describe, expect, it } from "vitest";
import projectTemplate from "../../../src/services/pi/runtime/prompts/project.md?raw";
import commonTemplate from "../../../src/services/pi/runtime/prompts/common.md?raw";
import parentTemplate from "../../../src/domain/project-sessions/prompts/parent-session-family.md?raw";
import childTemplate from "../../../src/domain/project-sessions/prompts/child-session-family.md?raw";
import workgroups from "../../../docs/agent/workgroups.md?raw";
import sessions from "../../../docs/agent/sessions.md?raw";
import { renderPromptTemplate } from "../../../src/services/pi/runtime/prompt-template";
import { createSessionFamilyOperations } from "../../../src/domain/session-families/cake-session-family-operations";

const project = renderPromptTemplate(projectTemplate, {
  cakeDocsDirectory: "/cake/docs",
  commonPrompt: renderPromptTemplate(commonTemplate),
});
const child = renderPromptTemplate(childTemplate, {
  familyId: "family-1",
  parentSessionId: "12345678",
  workingDirectory: "/worktrees/child",
});

describe("Project Session family communication policy", () => {
  it("puts recursive board-only transport and runtime limits directly in the kernel", () => {
    expect(project).toContain("parents, children, siblings and recursive descendants");
    expect(project).toContain("communicate exclusively via Workboard");
    expect(project).toContain(
      "never sessions.send/reply/send-batch, private subagents, files or side channels",
    );
    expect(project).toContain("even urgent/completion notices");
    expect(project).toContain("No private duplicates or relaying via outsiders");
    expect(project).toContain(
      "User-facing replies, Cake Chat and unrelated sessions are outside this rule",
    );
    expect(project).toContain("resultDelivery: notification");
    expect(project).toContain("Cake posts it before launch");
    expect(project).toContain("Posts never clear runtime-managed report obligations");
    expect(project).toContain("no private workaround or extra report");
    expect(project).toContain("Polling requires explicit user request");
    expect(project).toContain(
      "Every board post routes to explicit recipients plus the family root",
    );
    expect(project).toContain("Launch asynchronously; block only at the user");
    expect(project).toContain("Only actionable assignments/blockers wake idle family recipients");
    expect(project).toContain("Routine findings/completions wait as passive reminders");
    expect(project).toContain("No board: disclose, never invent/fallback");
  });

  it("uses identity/lifecycle overlays without repeating the full common policy", () => {
    expect(parentTemplate).toContain("main prompt's recursive Workboard-only");
    expect(parentTemplate).toContain("Only the family root resolves/restores");
    expect(child).toContain("family family-1; immediate parent: 12345678");
    expect(child).toContain("Working Directory is fixed at /worktrees/child");
    expect(child).toContain("cannot resolve/restore independently");
    expect(child).toContain("every member inactive");
    expect(child).toContain("Before starting an assignment, coordinating or reporting");
    expect(child).toContain("read workgroups.md and sessions.md");
    expect(parentTemplate.length).toBeLessThan(400);
    expect(child.length).toBeLessThan(650);
    // Keep the operating kernel bounded while making delivery and user overrides explicit.
    expect(project.length).toBeLessThan(3_200);
    expect(project).not.toContain("{{");
  });

  it("gates detailed mechanics behind precisely discoverable readable guides", () => {
    expect(project).toContain("Cake documentation directory: `/cake/docs`");
    expect(project).toContain("`workgroups.md` AND `sessions.md` before child assignments");
    expect(workgroups).toContain("they do not accept a board ID");
    expect(workgroups).toContain("An independent session cannot join an existing family");
    expect(workgroups).toContain("before admitting the first child turn");
    expect(workgroups).toContain("Cake supplies the board-discovery bootstrap");
    for (const operation of [
      "boards.current",
      "boards.read-new",
      "boards.read",
      "sessions.create-child",
    ])
      expect(workgroups).toContain(operation);
    expect(workgroups).toContain("`nextAfter` as `after`");
    expect(workgroups).toContain("`supersedes: [sequence, ...]`");
    expect(workgroups).toContain('audience: "workgroup"');
    expect(workgroups).toContain(
      "A user-facing final answer is not a substitute for this board result",
    );
    expect(workgroups).toContain("prompt text cannot disable or reroute them");
    expect(workgroups).toContain("never merge a child's branch by hand");
    expect(sessions).toContain(
      "When Cake Chat assigned your work, lead your final answer with a one-line outcome",
    );
    expect(sessions).toContain('`sessions.reply` with `outcome: "blocked"`');
  });

  it("aligns progressively disclosed session help, including bootstrap examples", () => {
    const operations = createSessionFamilyOperations(() => {
      throw new Error("Help inspection must not invoke runtime operations");
    });
    const guidance = (command: string) =>
      operations.find((operation) => operation.command === command)?.guidance?.join("\n");
    expect(guidance("sessions.create-child")).toContain('resultDelivery: "notification"');
    expect(guidance("sessions.create-child")).toContain(
      "persists its addressed Workboard assignment before its first turn can run",
    );
    for (const command of ["sessions.send", "sessions.reply", "sessions.send-batch"]) {
      expect(guidance(command)).toContain("exclusively");
      expect(guidance(command)).toContain("independent sessions");
    }
    const example = operations.find((operation) => operation.command === "sessions.create-child")
      ?.examples?.[0]?.input;
    expect(example).toMatchObject({ resultDelivery: "ignore" });
    expect(example?.assignment).toMatchObject({
      description: expect.any(String),
      body: expect.any(String),
    });
  });
});
