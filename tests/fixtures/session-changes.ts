import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "./window-state";
import {
  defaultApplicationState,
  type ApplicationState,
} from "../../src/contracts/application/application-data";

const changesSessionId = "session-changes-review";

/** Real Git facts behind the production review pane, shared by smoke and visual checks. */
export async function seedSessionChanges(
  paths: { project: string; cakeHome: string; userData: string },
  theme: "light" | "dark" = "dark",
) {
  const worktree = resolve(paths.project, "../review-worktree");
  const timestamp = new Date(0).toISOString();
  await Promise.all([
    mkdir(paths.project, { recursive: true }),
    mkdir(join(paths.cakeHome, "state"), { recursive: true }),
    mkdir(paths.userData, { recursive: true }),
  ]);
  const git = (cwd: string, ...args: string[]) => promisify(execFile)("git", args, { cwd });
  await git(paths.project, "init", "-b", "main");
  await git(paths.project, "config", "user.email", "cake@example.test");
  await git(paths.project, "config", "user.name", "Cake Review Fixture");
  await writeFile(join(paths.project, "README.md"), "# Review pane\n\nSession branch review.\n");
  await writeFile(join(paths.project, "removed.ts"), "export const obsolete = true;\n");
  await git(paths.project, "add", "-A");
  await git(paths.project, "commit", "-m", "Initial fixture");
  const baseCommit = (await git(paths.project, "rev-parse", "HEAD")).stdout.trim();
  await git(paths.project, "worktree", "add", "-b", "agent/changes-review", worktree);
  await mkdir(join(worktree, "src"), { recursive: true });
  await writeFile(
    join(worktree, "src", "review-pane.ts"),
    "export const paneWidth = 334;\nexport const title = 'Changes';\n",
  );
  await git(worktree, "add", "-A");
  await git(worktree, "commit", "-m", "Add branch change counts");
  await writeFile(
    join(worktree, "src", "session-changes.ts"),
    "export const sections = ['Commits', 'Uncommitted'];\n",
  );
  await git(worktree, "add", "-A");
  await git(worktree, "commit", "-m", "Keep uncommitted file details separate");
  await writeFile(
    join(worktree, "src", "review-pane.ts"),
    "export const paneWidth = 334;\nexport const title = 'Changes';\nexport const showCommitFiles = true;\n",
  );
  await git(worktree, "rm", "removed.ts");
  await git(worktree, "add", "-A");
  await git(worktree, "commit", "-m", "Show commit history in the changes pane");
  await writeFile(
    join(worktree, "README.md"),
    "# Review pane\n\nSession branch review.\n\nReview staged edits separately.\n",
  );
  await git(worktree, "add", "README.md");
  await writeFile(
    join(worktree, "src", "review-pane.ts"),
    "export const paneWidth = 334;\nexport const title = 'Changes';\nexport const showCommitFiles = true;\nexport const clickableFiles = true;\n",
  );
  await writeFile(
    join(worktree, "src", "session-changes.ts"),
    "export const sections = ['Commits', 'Uncommitted'];\nexport const keepComposerVisible = true;\n",
  );
  const sessions = cakeWorkspaceSessionDirectory(worktree, join(paths.cakeHome, "pi", "sessions"));
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, `1970-01-01T00-00-00-000Z_${changesSessionId}.jsonl`),
    [
      { type: "session", version: 3, id: changesSessionId, timestamp, cwd: worktree },
      {
        type: "session_info",
        id: "name",
        parentId: null,
        timestamp,
        name: "Review changes",
      },
      {
        type: "message",
        id: "user",
        parentId: "name",
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Show me what’s ready to merge." }],
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "assistant",
        parentId: "user",
        timestamp,
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Three commits are ready for review. The working tree still has a few edits.\n\nThe commit list and uncommitted edits are separate, so you can check each before merging.",
            },
          ],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  await writeFile(
    join(paths.cakeHome, "state", "application.json"),
    JSON.stringify({
      version: 9,
      data: {
        ...defaultApplicationState(),
        projects: [
          {
            path: paths.project,
            name: "Cake",
            addedAt: timestamp,
            lastOpenedAt: timestamp,
            todos: {
              selectedId: null,
              sequence: 0,
              deliveryToken: null,
              pending: [],
              items: [
                {
                  id: "00000000-0000-4000-8000-000000000011",
                  title: "Review worktree changes",
                  description: "Check committed work before landing.",
                  status: "",
                  state: "open",
                  revision: 0,
                  associations: [
                    {
                      kind: "session",
                      sessionId: changesSessionId,
                      title: "Review changes",
                    },
                  ],
                },
              ],
            },
          },
        ],
      } satisfies ApplicationState,
    }),
  );
  await writeFile(
    join(paths.cakeHome, "state", "worktrees.json"),
    JSON.stringify({
      schemaVersion: 1,
      records: [
        {
          projectPath: paths.project,
          worktreePath: worktree,
          branch: "agent/changes-review",
          baseBranch: "main",
          baseCommit,
          state: "active",
          createdAt: timestamp,
        },
      ],
    }),
  );
  await writeFile(
    join(paths.userData, "window-state.json"),
    windowState({
      project: paths.project,
      workingDirectory: worktree,
      sessionId: changesSessionId,
      theme,
    }),
  );
  return { worktree };
}
