import { describe, expect, it } from "vitest";
import projectTemplate from "../../../src/services/pi/runtime/prompts/project.md?raw";
import commonTemplate from "../../../src/services/pi/runtime/prompts/common.md?raw";
import parentTemplate from "../../../src/domain/project-sessions/prompts/parent-session-family.md?raw";
import childTemplate from "../../../src/domain/project-sessions/prompts/child-session-family.md?raw";
import workgroups from "../../../docs/agent/workgroups.md?raw";
import sessions from "../../../docs/agent/sessions.md?raw";
import { renderPromptTemplate } from "../../../src/services/pi/runtime/prompt-template";
import { createSessionFamilyOperations } from "../../../src/domain/session-families/cake-session-family-operations";

const project = renderPromptTemplate(projectTemplate, { cakeDocsDirectory: "/cake/docs" });
const child = renderPromptTemplate(childTemplate, {
  familyId: "family-1",
  parentSessionId: "s:12345678",
  workingDirectory: "/worktrees/child",
});

describe("Project Session family communication policy", () => {
  it("puts recursive board-only policy directly in the Project Session system prompt", () => {
    expect(project).toContain("parents, children, siblings, and descendants recursively");
    expect(project).toContain("exclusively through the family's shared message board");
    expect(project).toContain("never use `sessions.send`, `sessions.reply`, `sessions.send-batch`");
    expect(project).toContain("even for urgent wake-ups or completion reports");
    expect(project).toContain("Do not duplicate board entries with private notifications");
    expect(project).toContain(
      "does not apply to user-facing replies, Cake Chat, or unrelated independent sessions",
    );
    expect(project).toContain("do not use them to relay family messages around the board");
  });

  it("keeps parent and child context aligned without weakening worktree safeguards", () => {
    for (const prompt of [renderPromptTemplate(parentTemplate), child]) {
      expect(prompt).toContain("exclusively through the shared Workboard");
      expect(prompt).toContain("not `sessions.send` or `sessions.reply`");
      expect(prompt).toContain("Create children with `expectsResponse: false`");
    }
    expect(child).toContain("immediate parent is s:12345678");
    expect(child).toContain("Working Directory is fixed at /worktrees/child");
    expect(child).toContain("they cannot be resolved or restored independently");
    expect(workgroups).toContain("Never create an unrelated worktree base manually");
    expect(workgroups).toContain("uncommitted edits remain in this session's checkout");
    expect(workgroups).toContain("never merge a child's branch by hand");
    expect(workgroups).toContain("resolution requires every member to be inactive");
  });

  it("describes actual board discovery, automatic setup, targeting and selective reads", () => {
    for (const text of [project, workgroups]) {
      for (const operation of [
        "sessions.list-family",
        "sessions.create-child",
        "boards.append",
        "boards.current",
        "boards.read-new",
        "boards.read",
      ]) {
        expect(text).toContain(operation);
      }
      expect(text).toContain("no separate");
      expect(text).toContain('audience: "workgroup"');
    }
    expect(workgroups).toContain("they do not accept a board ID");
    expect(workgroups).toContain("An independent session cannot join an existing family");
    expect(workgroups).toContain("After the returned child reference is known");
    expect(workgroups).toContain("Use the initial prompt only for lifecycle/bootstrap directions");
    expect(workgroups).toContain("`nextAfter` as `after`");
    expect(workgroups).toContain("`supersedes: [sequence, ...]`");
    expect(workgroups).toContain(
      "A user-facing final answer is not a substitute for this board result",
    );
  });

  it("reconciles creator reports and discloses runtime limits without a private fallback", () => {
    for (const text of [project, workgroups, commonTemplate, sessions]) {
      expect(text).toContain("expectsResponse: false");
      expect(text).toContain("runtime-managed");
    }
    expect(project).toContain("Board entries/reminders do not wake idle sessions");
    expect(project).toContain("board posts do not clear them");
    expect(project).toContain("Do not add a manual private report");
    expect(workgroups).toContain("prompt text cannot disable or reroute them");
    expect(workgroups).toContain("let them resume that member");
    expect(commonTemplate).toContain(
      "When Cake Chat assigned your work, your final answer is that report",
    );
    expect(commonTemplate).toContain("Outside the calling session's family, redirect");
  });

  it("aligns progressively disclosed session help, including bootstrap examples", () => {
    const operations = createSessionFamilyOperations(() => {
      throw new Error("Help inspection must not invoke runtime operations");
    });
    const guidance = (command: string) =>
      operations.find((operation) => operation.command === command)?.guidance?.join("\n");
    expect(guidance("sessions.create-child")).toContain("Set expectsResponse: false");
    expect(guidance("sessions.create-child")).toContain(
      "board posts do not clear existing obligations",
    );
    for (const command of ["sessions.send", "sessions.reply", "sessions.send-batch"]) {
      expect(guidance(command)).toContain("exclusively");
      expect(guidance(command)).toContain("independent sessions");
    }
    const example = operations.find((operation) => operation.command === "sessions.create-child")
      ?.examples?.[0]?.input;
    expect(example).toMatchObject({ expectsResponse: false });
    expect(example?.initialPrompt).toContain("read your assignment there");
  });
});
