import { expect, type Locator } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import type { VisualCaptureScenario } from "./scenarios";
import type { CakeArtifactV1 } from "../../src/contracts/artifacts/artifact-contract";
import type { WidgetBrowserOutput } from "../../src/contracts/widgets/widget-browser-output";

// Review-only HTML. No production transcript, event correlation or authority changes.
const options = [
  [
    "receipt",
    "Attributed rows",
    "Agent messages have a sender and kind; Cake events use quiet status lines.",
  ],
  [
    "stacked",
    "Two-line messages",
    "Sender and kind above the short summary; events stay on one line.",
  ],
  [
    "timeline",
    "Message edge",
    "A short hairline marks agent-authored messages, never lifecycle events.",
  ],
  [
    "labels",
    "Kind gutter",
    "A fixed kind column makes reports, questions and blockers easy to scan.",
  ],
  [
    "sender-led",
    "Sender first",
    "Lead with the session; keep message kind beside its short summary.",
  ],
] as const;

const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const chevron = '<span class="chevron" aria-hidden="true"></span>';
const icon = (event = false) =>
  `<svg class="origin-icon" aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${event ? '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/>' : '<path d="M4 3.5h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H8l-5 3v-13a1 1 0 0 1 1-1Z"/>'}</svg>`;

function agentMessage(
  id: string,
  sender: string,
  kind: "Finding" | "Report" | "Question" | "Blocker",
  summary: string,
  body: string,
  exposed = "",
  open = false,
) {
  return `<div class="agent-message ${kind.toLowerCase()}">
    <details id="${id}" ${open ? "open" : ""}>
      <summary>${chevron}${icon()}<span class="kind">${kind}</span><span class="sender" title="${escape(sender)}">${sender}</span><span class="short">${summary}</span></summary>
      <div class="message-body"><p class="full-origin">From ${sender} · ${kind.toLowerCase()}</p><p>${body}</p>
        <div class="controls"><a href="cake://session/${kind === "Question" ? "sidebar-spacing" : "queue-recovery"}">Open session</a><a href="cake://session/${kind === "Question" ? "sidebar-spacing" : "queue-recovery"}?message=${id}">Original message</a><a class="linked-todo" href="cake://todo/${kind === "Question" ? "spacing" : "recovery"}">To-do · ${kind === "Question" ? "Review sidebar spacing" : "Fix queue recovery"}</a></div>
        ${kind === "Report" ? `<details class="attachment" ${open ? "open" : ""}><summary>${chevron}Artifact preview · Recovery handoff</summary><figure><ol class="handoff" aria-label="Recovery handoff"><li>Interrupted</li><li>Resume queue</li><li>Review conflict</li></ol><figcaption>Illustrative attachment · not a live artifact</figcaption></figure></details>` : ""}
      </div>
    </details>
    ${exposed ? `<p class="essential">${exposed}</p>` : ""}
  </div>`;
}

function lifecycle(
  id: string,
  status: string,
  task: string,
  detail: string,
  open = false,
  failure = false,
) {
  return `<details id="${id}" class="lifecycle ${failure ? "failure" : ""}" ${open ? "open" : ""}>
    <summary>${chevron}${icon(true)}<span class="app-origin">Cake</span><strong>${status}</strong><span class="event-task">${task}</span>${status === "Finished" ? '<span class="event-note">Not merged</span>' : ""}</summary>
    <div class="system-body"><p>${detail}</p><div class="controls"><a href="cake://session/${status === "Merged" || status === "Resolved" ? "toolbar-icons" : "queue-recovery"}">Open session</a><a class="linked-todo" href="cake://todo/${status === "Merged" || status === "Resolved" ? "icons" : "recovery"}">To-do · ${status === "Merged" || status === "Resolved" ? "Restore sidebar icon size" : "Fix queue recovery"}</a></div><details class="technical" ${open ? "open" : ""}><summary>${chevron}System details</summary><pre>Origin: application lifecycle event\nTask: ${task}\n${status === "Finished" ? "Run ended; matching agent report is immediately above.\nMerge: not attempted · Resolution: not requested" : status === "Merge failed" ? "Merge: stopped · Resolution: not attempted\nConflict: src/services/recovery.ts\nNo changes landed." : "Authority: explicit user instruction in this illustrative transcript."}</pre></details></div>
  </details>`;
}

function reminders(open = false) {
  return `<details class="reminders" ${open ? "open" : ""}><summary>${chevron}Context <span>3 updates · to-do, pending report, workflow</span></summary><div class="system-body"><p><strong>To-do:</strong> <a class="linked-todo" href="cake://todo/recovery">Fix queue recovery</a> → review. Not marked done by the report.</p><p><strong>Pending report:</strong> Sidebar spacing question awaits an answer.</p><p><strong>Workflow:</strong> Do not resolve Queue recovery. Completion is not merge or resolution approval.</p></div></details>`;
}

function workLog(open = false) {
  return `<details class="work-log" ${open ? "open" : ""}><summary>${chevron}Work log <span>4 tool calls · 1 file changed</span></summary><div class="system-body"><ol><li><code>read</code> · Sidebar icon sizing</li><li><code>edit</code> · Restore 16px icon token</li><li><code>bash</code> · Focused icon checks passed</li><li><code>bash</code> · Commit <code>e73a29d</code></li></ol></div></details>`;
}

function taskSection(id: string, title: string, content: string, done = false, attention = "") {
  return `<details class="task-section" id="${id}" open><summary><span class="task-state ${done ? "done" : ""}" role="img" aria-label="${done ? "Done" : "Open"}">${done ? "✓" : "○"}</span><a class="task-title" href="cake://todo/${id}" title="Show in To-do: ${escape(title)}">${title}</a><a class="task-focus" href="cake://todo/${id}" aria-label="Focus to-do: ${escape(title)}" title="Focus to-do (illustrative control)">⛶</a>${attention ? `<span class="task-attention">${attention}</span>` : ""}${chevron}</summary><div class="task-content">${content}</div></details>`;
}

function screen(id: string, name: string, note: string, open = false) {
  const stress = id === "stress";
  const sender = stress
    ? "Queue recovery with automatic conflict handoff across interrupted managed worktrees"
    : "Queue recovery";
  return `<section class="proposal ${id} ${id === "expanded" || stress ? "receipt" : ""}" id="${id}">
    <header class="proposal-label"><strong>${name}</strong><span>${note}</span></header>
    <div class="chat-heading">Cake <span>› Project Chat</span><span class="scope">Design prototype</span></div>
    <main class="conversation">
      ${taskSection(
        `${id}-icons-task`,
        "Restore sidebar icon size",
        `<div class="user"><span>You</span><p>Restore the old sidebar icon size. You may merge and resolve that fix.</p></div>
      <article class="assistant"><p>I'll restore the icons to 16px and keep the rest of the sidebar unchanged.</p></article>
      <div class="secondary-group">${workLog(open)}${lifecycle(`${id}-merged`, "Merged", "Toolbar icons", "Icon fix landed at e73a29d, following the user's explicit approval.")}${lifecycle(`${id}-resolved`, "Resolved", "Toolbar icons", "Only the Toolbar icons session was resolved, following the user's explicit approval.")}</div>`,
        true,
      )}
      ${taskSection(
        `${id}-recovery-task`,
        stress
          ? "Fix stalled conflict recovery across interrupted managed worktrees and preserve queued retry behavior"
          : "Fix queue recovery",
        `<div class="user"><span>You</span><p>Finish the queue recovery checks, but don't merge recovery yet.</p></div>
      <div class="message-group">
        ${agentMessage(`${id}-finding`, sender, "Finding", "Interrupted handoff reproduced.", "An interrupted queue loses its conflict handoff. The recovery change restores the handoff before resuming work.")}
        ${agentMessage(`${id}-report`, sender, "Report", "Recovery checks passed.", "<strong>Scoped recovery checks passed at <code>c42b8f1</code>.</strong> Interrupted work now resumes with a conflict handoff. The committed change is ready for review, not merged or resolved.", "", open)}
        <div class="coupled-event">${lifecycle(`${id}-finished`, "Finished", "Queue recovery", "Run ended. The agent's findings and checks are in the report above; this event adds lifecycle state only. No merge or resolution was attempted.", open)}</div>
      </div>
      <div class="user follow-up"><span>You</span><p>Try merging queue recovery now. Leave its session unresolved.</p></div>
      <div class="message-group failure-group">
        ${lifecycle(`${id}-failed`, "Merge failed", "Queue recovery", "The authorized merge stopped on a conflict. The work remains unmerged and unresolved.", false, true)}
        <p class="failure-reason">Conflict in <code>recovery.ts</code> · Nothing merged; session unresolved.</p>
        ${agentMessage(`${id}-blocker`, sender, "Blocker", "Conflict needs a decision.", "The queued retry change overlaps the recovery handoff. I have not selected one behavior or retried the merge.", "Retry behavior differs on both branches; review before retrying.")}
      </div>`,
        false,
        "Merge failed · 1 blocker",
      )}
      ${taskSection(`${id}-spacing-task`, "Review sidebar spacing", agentMessage(`${id}-question`, "Sidebar spacing", "Question", "Keep compact row spacing?", "The icon fix is separate from row spacing. Should I preserve the current compact rows or restore the earlier spacing too?", "Preserve current rows, or restore the earlier spacing?", open) + reminders(open), false, "1 question")}
    </main><div class="composer">Message Cake <span>↵</span></div>
  </section>`;
}

export function incomingMessageProposalsHtml() {
  return `<style>
*{box-sizing:border-box}body{margin:0;padding:0}.gallery{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;font-size:14px;line-height:1.45;background:#e8ebef;color:#25282c;padding:24px}
.proposal{--background:oklch(0.98 0.003 250);--foreground:oklch(0.205 0.012 252);--card:oklch(0.998 0.001 250);--muted:oklch(0.948 0.006 250);--muted-foreground:oklch(0.48 0.015 250);--border:oklch(0.885 0.008 250);--accent:oklch(0.58 0.18 252);--destructive:oklch(0.58 0.18 28);--success:oklch(0.58 0.14 150);--user-message:oklch(0.915 0.014 245);color-scheme:light;color:var(--foreground);width:min(100%,960px);margin:0 auto 36px;background:var(--background);border-radius:8px}
@media(prefers-color-scheme:dark){.gallery{background:#191c21}.proposal{--background:oklch(0.205 0.006 255);--foreground:oklch(0.93 0.004 255);--card:oklch(0.24 0.007 255);--muted:oklch(0.27 0.008 255);--muted-foreground:oklch(0.68 0.009 255);--border:oklch(0.32 0.008 255);--accent:oklch(0.68 0.17 250);--destructive:oklch(0.69 0.18 28);--success:oklch(0.72 0.14 150);--user-message:oklch(0.268 0.016 250);color-scheme:dark}}
.proposal-label{display:flex;flex-direction:column;gap:3px;padding:16px 24px;border-bottom:1px solid var(--border);background:var(--card)}.proposal-label strong{font-size:16px;font-weight:600}.proposal-label span{color:var(--muted-foreground)}
.chat-heading{display:flex;gap:8px;padding:12px 24px;border-bottom:1px solid var(--border);font-weight:500}.chat-heading span{color:var(--muted-foreground);font-weight:400}.scope{margin-left:auto}
.conversation{max-width:816px;margin:0 auto;padding:20px 24px;display:flex;flex-direction:column;gap:16px}.conversation>*{min-width:0}.message-group,.secondary-group{display:flex;flex-direction:column;gap:4px}
.task-section{min-width:0}.task-section>summary{display:flex;align-items:center;gap:8px;min-height:28px;margin-left:-12px;margin-bottom:10px;font-size:13px}.task-section>summary:hover{background:none}.task-state{color:var(--muted-foreground);flex-shrink:0;font-size:16px}.task-state.done{color:var(--success)}.task-title{color:var(--foreground);font-weight:500;overflow-wrap:anywhere;min-width:0}.task-focus{color:var(--muted-foreground);font-size:16px;flex-shrink:0;padding:2px}.task-section>summary>.chevron{margin-left:auto;transform:rotate(-45deg)}.task-section[open]>summary>.chevron{transform:rotate(45deg)}.task-attention{font-size:12px;white-space:nowrap;color:var(--foreground);margin-left:auto}.task-attention+.chevron{margin-left:4px!important}.task-section[open]>summary>.task-attention{display:none}.task-section[open]>summary>.chevron{margin-left:auto!important}.task-content{display:flex;flex-direction:column;gap:16px;border-left:4px solid var(--border);margin-left:-12px;padding-left:8px}.task-section:not([open])>summary{margin-bottom:0}.linked-todo{white-space:normal}
summary{cursor:pointer;list-style:none;border-radius:6px}summary::-webkit-details-marker{display:none}summary:hover{background:var(--muted)}summary:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}summary:focus-visible{background:var(--muted)}
.chevron{width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);flex-shrink:0;margin:0 5px;color:var(--muted-foreground)}details[open]>summary>.chevron{transform:rotate(45deg)}.origin-icon{width:16px;height:16px;flex-shrink:0;color:var(--muted-foreground)}
.agent-message>details>summary{display:flex;align-items:center;gap:8px;min-height:36px;padding:6px 8px;min-width:0}.sender{font-weight:500;max-width:36%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.short{color:var(--foreground);min-width:0;flex:1}.kind{font-size:12px;line-height:20px;color:var(--muted-foreground);white-space:nowrap}.question .kind,.blocker .kind{color:var(--foreground);font-weight:600}.question>details>summary,.blocker>details>summary{border-left:2px solid var(--border);padding-left:6px}.agent-message:has(>details[open])>.essential{display:none}.essential{margin:0 8px 4px 116px;font-size:14px;overflow-wrap:anywhere}.message-body{margin:2px 8px 8px 32px;padding:8px 0 8px 16px;border-left:1px solid var(--border);line-height:1.65;overflow-wrap:anywhere}.message-body p{margin:0 0 8px}.full-origin{color:var(--muted-foreground);font-size:13px}
.controls{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:13px;margin-top:8px}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}.attachment{margin-top:12px}.attachment>summary,.technical>summary{display:flex;align-items:center;gap:6px;min-height:28px;color:var(--muted-foreground);font-size:13px}.attachment figure{margin:8px 0;max-width:440px;color:var(--muted-foreground)}.handoff{display:flex;flex-wrap:wrap;gap:8px;list-style-position:inside;padding:0;margin:8px 0}.handoff li{flex:1 1 120px;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:13px}.attachment figcaption{font-size:12px;margin-top:4px}
.lifecycle{font-size:13px;color:var(--muted-foreground)}.lifecycle>summary{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;min-height:28px;padding:3px 8px}.lifecycle strong{font-weight:500}.app-origin{font-size:12px}.event-task{overflow-wrap:anywhere;min-width:0}.event-note{margin-left:auto;font-size:12px}.coupled-event{margin-left:32px}.coupled-event .lifecycle>summary{padding-left:0}.failure>summary{color:var(--foreground)}.failure strong{color:var(--destructive);font-weight:600}.failure-reason{margin:0 8px 4px 58px;overflow-wrap:anywhere;font-size:14px}.technical pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 "SF Mono",Menlo,monospace}.system-body{margin:4px 8px 8px 32px;padding:4px 0 4px 16px;border-left:1px solid var(--border);overflow-wrap:anywhere;line-height:1.6}.system-body p{margin:0 0 6px}.system-body ol{padding-left:20px;margin:0}.system-body li+li{margin-top:4px}
.work-log,.reminders{font-size:13px;color:var(--muted-foreground)}.work-log>summary,.reminders>summary{display:flex;align-items:center;gap:8px;min-height:28px;padding:3px 8px}.work-log{background:color-mix(in srgb,var(--muted) 45%,transparent);border-radius:6px}.work-log>summary>span:last-child,.reminders>summary>span:last-child{min-width:0}.reminders{margin:4px 0 0 32px}
.assistant{font-size:15px;line-height:1.75;padding:12px 16px;background:var(--card);border:1px solid var(--border);border-radius:10px}.assistant p{margin:0}.user{margin-left:48px}.user>span{color:var(--muted-foreground);display:block;margin-bottom:5px;font-size:13px}.user p{margin:0;border:1px solid var(--border);background:var(--user-message);border-radius:10px;padding:12px 16px;font-size:15px;line-height:1.65}code{font-family:"SF Mono",Menlo,monospace;font-size:.94em;background:var(--muted);border-radius:3px;padding:1px 4px}.composer{margin:0 24px 20px;border:1px solid var(--border);border-radius:8px;padding:12px;color:var(--muted-foreground);background:var(--card)}.composer span{float:right}
/* Flat alternatives change hierarchy, never add a card around an agent message. */
.stacked .agent-message>details>summary{display:grid;grid-template-columns:16px 16px auto minmax(0,1fr);gap:0 8px}.stacked .chevron{grid-row:1/3}.stacked .origin-icon{grid-column:2;grid-row:1/3}.stacked .kind{grid-column:3;grid-row:1}.stacked .sender{grid-column:4;grid-row:1;max-width:none}.stacked .short{grid-column:3/5;grid-row:2}.stacked .essential{margin-left:64px}
.timeline .agent-message{border-left:1px solid var(--border);margin-left:8px}.timeline .agent-message>details>summary{border:0}.timeline .coupled-event{margin-left:40px}
.labels .agent-message>details>summary{display:grid;grid-template-columns:16px 16px 62px minmax(0,1fr) minmax(0,1.3fr)}.labels .sender{max-width:none}.labels .essential{margin-left:134px}
.sender-led .agent-message>details>summary{display:flex}.sender-led .sender{order:0}.sender-led .kind{order:1;padding-left:8px;border-left:1px solid var(--border)}.sender-led .short{order:2}
@media(max-width:620px){.gallery{padding:8px}.proposal-label{padding:12px}.chat-heading{padding:10px 12px}.chat-heading .scope{display:none}.conversation{padding:16px 20px;gap:16px}.task-section>summary{flex-wrap:wrap;gap:4px 8px}.task-title{max-width:calc(100% - 72px)}.task-attention{margin-left:24px}.task-section>summary>.chevron{margin-left:auto!important}.agent-message>details>summary,.labels .agent-message>details>summary,.sender-led .agent-message>details>summary{display:grid;grid-template-columns:16px 16px auto minmax(0,1fr);gap:0 8px}.agent-message .chevron{grid-column:1;grid-row:1/3}.agent-message .origin-icon{grid-column:2;grid-row:1/3}.agent-message .kind{grid-column:3;grid-row:1;order:0}.agent-message .sender{grid-column:4;grid-row:1;max-width:none;order:0}.agent-message .short{grid-column:3/5;grid-row:2;order:0}.sender-led .kind{padding:0;border:0}.essential,.labels .essential,.stacked .essential{margin-left:64px}.message-body{margin-left:32px;padding-left:12px}.lifecycle>summary{column-gap:6px}.event-note{margin-left:0}.coupled-event{margin-left:24px}.user{margin-left:20px}.user p{padding:10px 12px}.composer{margin:0 12px 16px}.reminders{margin-left:24px}.reminders>summary{align-items:flex-start}.failure-reason{margin-left:32px}}
</style><div class="gallery">${options.map(([id, name, note], index) => screen(id, `${index + 1} · ${name}`, note)).join("")}${screen("expanded", "Recommended · inspection state", "Report + attached preview; finished event + System details; work log and context expanded.", true)}${screen("stress", "Recommended · long sender", "Same short summaries; full session title remains available inside the disclosure.")}</div>`;
}

type Seed = NonNullable<VisualCaptureScenario["seed"]>;
export function createIncomingMessageProposalsScenario(dependencies: {
  seedArtifact: (
    paths: Parameters<Seed>[0],
    theme: Parameters<Seed>[1],
    artifact: CakeArtifactV1,
    inline: boolean,
  ) => ReturnType<Seed>;
  retainBrowser: (
    paths: Parameters<Seed>[0],
    language: "html",
    source: string,
  ) => Promise<WidgetBrowserOutput>;
}): VisualCaptureScenario {
  const title = "Incoming message proposals";
  const targetId = (state: string) =>
    state === "long" || state === "long-collapsed"
      ? "stress"
      : ["default", "narrow", "task-collapsed"].includes(state)
        ? "receipt"
        : state;
  const frame = (page: Parameters<VisualCaptureScenario["prepare"]>[0]) =>
    page.getByRole("dialog", { name: title, exact: true }).locator("iframe").contentFrame();
  return {
    name: "incoming-message-proposals",
    description: "Review-only taxonomy: conversation, agent messages and application events",
    states: [
      "default",
      "receipt",
      "stacked",
      "timeline",
      "labels",
      "sender-led",
      "expanded",
      "long",
      "long-collapsed",
      "narrow",
      "expanded-narrow",
      "task-collapsed",
    ],
    async seed(paths, theme) {
      const source = incomingMessageProposalsHtml();
      await dependencies.seedArtifact(
        paths,
        theme,
        {
          protocol: "cake.artifact/v1",
          id: "incoming-message-proposals",
          sessionId: "incoming-message-proposals",
          revision: 1,
          kind: "widget",
          title,
          payload: {
            language: "html",
            source,
            brief: "Static design only; not working production UI",
            generationSessionId: "incoming-proposal-fixture",
            browser: await dependencies.retainBrowser(paths, "html", source),
          },
          fallback: { markdown: title },
          interaction: { mode: "present" },
        },
        true,
      );
      await writeFile(
        join(paths.cakeHome, "state", "application.json"),
        JSON.stringify({
          version: 10,
          data: {
            ...defaultApplicationState(),
            projects: [
              {
                path: paths.project,
                name: "Cake architecture",
                addedAt: new Date(0).toISOString(),
                lastOpenedAt: new Date(0).toISOString(),
              },
            ],
          },
        }),
      );
    },
    async prepare(page, state) {
      await page
        .getByRole("button", { name: "Open Project Chat for Cake architecture", exact: true })
        .click();
      await page.getByRole("button", { name: "Search sessions", exact: true }).first().click();
      await page.keyboard.type("Explain how Cake's desktop architecture works.");
      await page
        .getByRole("option")
        .filter({ hasText: "Explain how Cake's desktop architecture works." })
        .first()
        .click();
      const host = page.locator('[data-slot="artifact-disclosure"]').first();
      await expect(host.locator("iframe").contentFrame().locator(".gallery")).toBeVisible();
      await host.getByRole("button", { name: `View ${title} fullscreen`, exact: true }).click();
      // Real CSS viewport, not a scaled screenshot or the user's running application.
      if (["narrow", "long", "long-collapsed", "expanded-narrow"].includes(state))
        await page
          .getByRole("dialog", { name: title, exact: true })
          .locator("iframe")
          .evaluate((element) => element.style.setProperty("width", "420px", "important"));
      const section = frame(page).locator(
        `#${state === "expanded-narrow" ? "expanded" : targetId(state)}`,
      );
      // Capture one full-size alternative, not a distant slice of the gallery.
      await section.evaluate((element) => {
        for (const sibling of element.parentElement?.children ?? []) {
          if (sibling !== element && sibling instanceof HTMLElement) sibling.style.display = "none";
        }
      });
      await section.scrollIntoViewIfNeeded();
      await expect(section.locator(".failure-reason")).toBeVisible();
      await expect(
        section.locator(
          ["expanded", "expanded-narrow"].includes(state)
            ? ".question .full-origin"
            : ".question .essential",
        ),
      ).toBeVisible();
      await expect(section.locator(".blocker .essential")).toBeVisible();
      await expect(section.locator(".coupled-event")).toContainText("Finished");
      await expect(section.locator(".coupled-event")).toContainText("Not merged");
      // Test Enter and Space on a native disclosure, with no hidden focus stops.
      const report = section.locator(".report>details");
      const disclosure = report.locator(":scope>summary");
      const initiallyOpen = await report.evaluate((element) => element.hasAttribute("open"));
      await disclosure.focus();
      await disclosure.press("Enter");
      expect(await report.evaluate((element) => element.hasAttribute("open"))).toBe(!initiallyOpen);
      await disclosure.press("Space");
      expect(await report.evaluate((element) => element.hasAttribute("open"))).toBe(initiallyOpen);
      if (state === "long") {
        await disclosure.press("Enter");
        await expect(section.locator(".report .full-origin")).toContainText(
          "across interrupted managed worktrees",
        );
      }
      if (["expanded", "expanded-narrow"].includes(state)) {
        await expect(section.locator(".attachment figure")).toBeVisible();
        await expect(section.locator(".work-log ol")).toBeVisible();
        await expect(section.locator(".coupled-event .technical pre")).toBeVisible();
        await expect(section.locator(".reminders .system-body")).toBeVisible();
        for (const selector of [
          ".work-log",
          ".attachment",
          ".coupled-event .technical",
          ".reminders",
          ".coupled-event>details",
        ]) {
          const detail = section.locator(selector);
          const header = detail.locator(":scope>summary");
          await header.focus();
          await header.press("Space");
          expect(await detail.evaluate((element) => element.hasAttribute("open"))).toBe(false);
          await header.press("Enter");
          await expect(detail).toHaveAttribute("open", "");
        }
        // Tab from the report reaches its attached controls, not a collapsed body.
        await disclosure.focus();
        await disclosure.press("Tab");
        await expect(
          section.locator(".report").getByRole("link", { name: "Open session", exact: true }),
        ).toBeFocused();
      } else if (state !== "long") {
        await disclosure.focus();
        await disclosure.press("Tab");
        await expect(section.locator(".coupled-event>details>summary")).toBeFocused();
      }
      // Task boundaries are not message categories. Folding the stretch retains alerts.
      const task = section.locator(".task-section").nth(1);
      const taskHeader = task.locator(":scope>summary");
      await taskHeader.focus();
      await taskHeader.press("Enter");
      await expect(task.locator(".task-attention")).toContainText("Merge failed · 1 blocker");
      await expect(task.locator(".task-attention")).toBeVisible();
      await expect(task.locator(".failure-reason")).not.toBeVisible();
      if (state !== "task-collapsed") {
        await taskHeader.press("Space");
        await expect(task.locator(".failure-reason")).toBeVisible();
      } else {
        const questionTask = section.locator(".task-section").last();
        await questionTask.locator(":scope>summary").press("Enter");
        await expect(questionTask.locator(".task-attention")).toContainText("1 question");
        await expect(questionTask.locator(".task-attention")).toBeVisible();
      }
      // Inspect every visible descendant, including wrapped essential text and details.
      expect(await section.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      const overflowing = await section
        .locator("summary, .message-body, .system-body, .essential, .failure-reason")
        .evaluateAll((elements) =>
          elements
            .filter(
              (element) =>
                element.getClientRects().length && element.scrollWidth > element.clientWidth + 1,
            )
            .map((element) => element.className || element.tagName),
        );
      expect(overflowing).toEqual([]);
      if (state === "expanded") await disclosure.focus();
      else
        await section.evaluate((element) => {
          const active = element.ownerDocument.activeElement;
          if (active instanceof HTMLElement) active.blur();
        });
      await section.evaluate((element) => element.ownerDocument.scrollingElement?.scrollTo(0, 0));
      await page.mouse.move(1, 1);
    },
    region: (page, state): Locator =>
      frame(page).locator(`#${state === "expanded-narrow" ? "expanded" : targetId(state)}`),
  };
}
