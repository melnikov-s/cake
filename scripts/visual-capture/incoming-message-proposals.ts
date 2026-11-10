import { expect, type Locator } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import type { VisualCaptureScenario } from "./scenarios";
import type { CakeArtifactV1 } from "../../src/contracts/artifacts/artifact-contract";
import type { WidgetBrowserOutput } from "../../src/contracts/widgets/widget-browser-output";

// Design evidence only. None of these alternatives replaces the production transcript.
const options = [
  [
    "receipt",
    "Quiet receipts",
    "One compact disclosure header: sender, then a very short summary.",
  ],
  ["stacked", "Two-line receipts", "A stable sender line above a short, readable summary."],
  [
    "timeline",
    "Conversation rail",
    "An understated rule couples incoming updates and their context.",
  ],
  ["bundle", "Update bundle", "Related session messages share one enclosing surface."],
  [
    "columns",
    "Sender column",
    "A fixed origin column separates provenance from the human summary.",
  ],
] as const;

const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

function receipt(id: string, sender: string, summary: string, body: string, failure = false) {
  return `<div class="receipt ${failure ? "failure" : ""}">
    <details id="${id}"><summary><span class="chevron" aria-hidden="true"></span><span class="sender" title="${escape(sender)}">${sender}</span><span class="short" title="${escape(summary)}">${summary}</span>${failure ? '<span class="state">Needs review</span>' : ""}</summary>
      <div class="message-body"><p class="full-origin">From ${sender}</p><p>${body}</p>
      <div class="source-line"><a href="cake://session/queue-recovery">Open session</a><a href="cake://session/queue-recovery/message/report-1">Original message</a><span>Session e37674d0 · report</span></div>
      <details class="technical"><summary>Technical details</summary><pre>Source: session e37674d0\nMessage: report-1\nNo task-completion authority is inferred from a report.</pre></details>
      <a class="todo" href="cake://todo/recovery">✓ Done · Fix stalled conflict recovery and blocked merge queue</a></div>
    </details>
    ${failure ? '<p class="failure-reason">Merge blocked by conflicts in <code>recovery.ts</code>. Changes are not merged.</p>' : ""}
  </div>`;
}

function reminders() {
  return `<details class="reminders"><summary aria-label="System reminders: Cake Project Chat changes and Task context"><span class="system-label">System</span><span class="pill">Cake · Project Chat changes</span><span class="pill">Task context</span></summary>
    <div class="reminder-body"><p><strong>Cake · Project Chat changes</strong><br>Project Chat owns tracking. Keep work in the assigned session; report scoped checks and provenance.</p><p><strong>Task context</strong><br>Preserve the existing sidebar and icon work. A session report is not merge or to-do completion approval.</p></div>
  </details>`;
}

function screen(id: string, name: string, note: string, extra = "") {
  const stress = id === "stress";
  return `<section class="proposal ${id} ${extra}" id="${id}">
    <header class="proposal-label"><strong>${name}</strong><span>${note}</span></header>
    <div class="chat-surface"><div class="chat-heading">Cake <span>› Project Chat</span><span class="scope">Transcript only · sidebar unchanged</span></div>
    <main class="conversation">
      <div class="incoming">
      ${receipt(`${id}-report`, stress ? "Integrate queue recovery with automatic conflict handoff across interrupted worktrees" : "Queue recovery", stress ? "Recovery checks passed; this deliberately long source preview remains inspectable in full without pushing the status or sender out of the header." : "Recovery checks passed.", stress ? "Recovery checks passed; this deliberately long source preview remains inspectable in full without pushing the status or sender out of the header." : "<strong>Recovery checks passed.</strong> Integrated queue recovery with automatic conflict handoff. Scoped checks passed on the committed changes; this report alone does not authorize merging.")}
      <details class="work-log"><summary><span class="chevron" aria-hidden="true"></span>Work log <span>6 tool calls</span></summary><div class="message-body">Read recovery state · Updated handoff · Ran scoped checks · Committed changes</div></details>
      </div>
      <article class="assistant"><p><strong>Merged and verified on main at <code>bcc81fdb</code>.</strong> The worktree is clean, and the recovery sessions are resolved.</p><p>You can rebuild and restart now. We can discuss the reminder improvements afterward.</p></article>
      <div class="incoming">
      ${receipt(`${id}-failure`, "Integrate queue recovery with automatic conflict handoff", "Conflict handoff needs review.", "<strong>Auto-merge needs review.</strong> The recovery integration report arrived, but this later merge attempt failed. Review the conflict before retrying. The earlier assistant message above is retained as conversation history, not current merge status.", true)}
      ${reminders()}
      </div>
      <div class="user"><span>You</span><p>In one of the very recent commits, we changed the sidebar, and I like all the changes that we did to the sidebar, except for the icon size. I prefer the old icon size. Can we restore the old icon size, please?</p></div>
      <details class="work-log"><summary><span class="chevron" aria-hidden="true"></span>Work log <span>4 tool calls · todos.create</span></summary><div class="message-body">Read sidebar changes · Created follow-up to-do</div></details>
    </main><div class="composer">Message Cake <span>↵</span></div></div>
  </section>`;
}

export function incomingMessageProposalsHtml() {
  return `<style>
*{box-sizing:border-box}body{margin:0} .gallery{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;font-size:14px;line-height:1.45;background:#e8ebef;color:#25282c;padding:24px}
.proposal{--background:oklch(0.98 0.003 250);--foreground:oklch(0.205 0.012 252);--card:oklch(0.998 0.001 250);--muted:oklch(0.948 0.006 250);--muted-foreground:oklch(0.48 0.015 250);--border:oklch(0.885 0.008 250);--accent:oklch(0.58 0.18 252);--destructive:oklch(0.58 0.18 28);--user-message:oklch(0.915 0.014 245);color-scheme:light;color:var(--foreground);width:min(100%,960px);margin:0 auto 36px;background:var(--background)}
@media(prefers-color-scheme:dark){.proposal{--background:oklch(0.205 0.006 255);--foreground:oklch(0.93 0.004 255);--card:oklch(0.24 0.007 255);--muted:oklch(0.27 0.008 255);--muted-foreground:oklch(0.68 0.009 255);--border:oklch(0.32 0.008 255);--accent:oklch(0.68 0.17 250);--destructive:oklch(0.69 0.18 28);--user-message:oklch(0.268 0.016 250);color-scheme:dark}}
.proposal-label{display:flex;flex-direction:column;gap:3px;padding:16px 24px;border-bottom:1px solid var(--border);background:var(--card)}.proposal-label strong{font-size:16px;font-weight:600}.proposal-label span{color:var(--muted-foreground)}
.chat-heading{display:flex;gap:8px;padding:12px 24px;border-bottom:1px solid var(--border);font-weight:500}.chat-heading span{color:var(--muted-foreground);font-weight:400}.chat-heading .scope{margin-left:auto}
.conversation{max-width:816px;margin:0 auto;padding:24px;display:flex;flex-direction:column;gap:20px}.incoming{display:flex;flex-direction:column;gap:4px;min-width:0}
.receipt{min-width:0;border-radius:8px}.receipt>details>summary{display:flex;align-items:center;gap:8px;min-height:36px;padding:6px 8px;min-width:0;border-radius:6px;cursor:pointer;list-style:none}.receipt>details>summary:hover{background:var(--muted)}summary::-webkit-details-marker{display:none}summary:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.chevron{width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);flex-shrink:0;margin:0 4px;color:var(--muted-foreground)}details[open]>summary>.chevron{transform:rotate(45deg)}
.sender{font-weight:500;max-width:43%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:1}.short{color:var(--muted-foreground);min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.state{color:var(--destructive);font-weight:500;white-space:nowrap;font-size:14px;margin-left:auto}
.message-body{padding:10px 16px 12px 30px;border-top:1px solid var(--border);line-height:1.6;overflow-wrap:anywhere}.message-body p{margin:0 0 10px}.full-origin{color:var(--muted-foreground)}.source-line{display:flex;flex-wrap:wrap;gap:8px 16px;color:var(--muted-foreground);margin-top:12px}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}.todo{display:block;margin-top:10px}.technical{margin-top:10px;color:var(--muted-foreground)}.technical summary{cursor:pointer;min-height:28px}.technical pre{white-space:pre-wrap;font:13px/1.5 "SF Mono",Menlo,monospace}
.failure-reason{margin:0 8px 6px 30px;color:var(--destructive);font-size:14px;line-height:1.5;overflow-wrap:anywhere}code{font-family:"SF Mono",Menlo,monospace;font-size:.94em;background:var(--muted);border-radius:3px;padding:1px 4px}.failure>details[open]{border:1px solid var(--border);border-radius:8px}
.work-log{border-radius:6px;background:color-mix(in srgb,var(--muted) 50%,transparent);color:var(--muted-foreground);font-size:14px}.work-log>summary{display:flex;align-items:center;gap:8px;min-height:32px;padding:5px 8px;cursor:pointer;list-style:none}.work-log>summary>span:last-child{font-weight:400;margin-left:2px}.work-log .message-body{font-size:14px}
.assistant{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px 20px;font-size:15px;line-height:1.75}.assistant p{margin:0}.assistant p+p{margin-top:12px}
.reminders{padding:4px 8px 0 30px;color:var(--muted-foreground)}.reminders>summary{display:flex;align-items:flex-start;flex-wrap:wrap;gap:4px 6px;list-style:none;cursor:pointer;min-height:28px;border-radius:6px}.system-label{line-height:28px}.pill{display:inline-block;border-radius:99px;border:1px solid var(--border);background:var(--card);font-size:14px;min-height:28px;padding:3px 10px;max-width:100%;overflow-wrap:anywhere}.reminder-body{margin-top:6px;border:1px solid var(--border);background:var(--card);border-radius:8px;padding:12px;overflow-wrap:anywhere;line-height:1.6}.reminder-body p{margin:0}.reminder-body p+p{margin-top:10px}
.user{margin-left:64px}.user>span{color:var(--muted-foreground);display:block;margin-bottom:6px}.user p{margin:0;border:1px solid var(--border);background:var(--user-message);border-radius:10px;padding:16px 20px;font-size:15px;line-height:1.75}
.composer{margin:0 24px 20px;border:1px solid var(--border);border-radius:8px;padding:12px;color:var(--muted-foreground);background:var(--card)}.composer span{float:right}
/* Alternatives change hierarchy, not font size or content. */
.stacked .receipt>details>summary{display:grid;grid-template-columns:16px minmax(0,1fr) auto;gap:0 8px;padding:7px 8px}.stacked .sender{max-width:none;grid-column:2;grid-row:1}.stacked .short{grid-column:2;grid-row:2}.stacked .chevron{grid-row:1/3}.stacked .state{grid-column:3;grid-row:1/3}
.timeline .incoming{border-left:2px solid var(--border);padding-left:8px}.timeline .receipt>details>summary{padding-left:4px}.timeline .work-log{background:none}.timeline .reminders{padding-left:26px}
.bundle .incoming{border:1px solid var(--border);border-radius:8px;background:var(--card);gap:0}.bundle .incoming>.work-log{border-radius:0 0 8px 8px;border-top:1px solid var(--border);background:none}.bundle .reminders{border-top:1px solid var(--border);padding-bottom:8px}.bundle .receipt>details>summary{border-radius:8px}
.columns .receipt>details>summary{display:grid;grid-template-columns:16px minmax(110px,1fr) minmax(0,1.6fr) auto}.columns .sender{max-width:none;border-right:1px solid var(--border);padding-right:10px}.columns .short{padding-left:4px}.columns .message-body{margin-left:24px}
@media(max-width:620px){.gallery{padding:8px}.proposal-label{padding:12px}.chat-heading{padding:10px 12px}.scope{display:none}.conversation{padding:16px 12px;gap:16px}.receipt>details>summary{display:grid;grid-template-columns:16px minmax(0,1fr) auto;gap:0 8px}.sender{grid-row:1;grid-column:2;max-width:none}.short{grid-row:2;grid-column:2/4}.state{grid-column:3;grid-row:1}.chevron{grid-column:1;grid-row:1/3}.user{margin-left:20px}.assistant,.user p{padding:12px 14px}.composer{margin:0 12px 16px}.columns .receipt>details>summary{grid-template-columns:16px minmax(0,1fr) auto}.columns .sender{border:0;padding:0}.columns .short{padding:0}.columns .message-body{margin-left:0}}
</style><div class="gallery">${options.map(([id, name, note], index) => screen(id, `${index + 1} · ${name}`, note)).join("")}
${screen("stress", "Recommended · expanded + long content", "Full provenance, original message, read-only to-do link and grouped system pills.", "receipt")}</div>`;
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
      : ["default", "expanded", "narrow"].includes(state)
        ? "receipt"
        : state;
  const frame = (page: Parameters<VisualCaptureScenario["prepare"]>[0]) =>
    page.getByRole("dialog", { name: title, exact: true }).locator("iframe").contentFrame();
  return {
    name: "incoming-message-proposals",
    description: "Static design comparison only; no production transcript changes",
    states: [
      "default",
      "receipt",
      "stacked",
      "timeline",
      "bundle",
      "columns",
      "expanded",
      "long",
      "long-collapsed",
      "narrow",
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
            brief: "Static comparison, not working product UI",
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
      // Electron enforces a minimum native window width. Resize only this isolated
      // prototype iframe to demonstrate a real 420px CSS viewport, not a scaled image.
      if (["narrow", "long", "long-collapsed"].includes(state))
        await page
          .getByRole("dialog", { name: title, exact: true })
          .locator("iframe")
          .evaluate((element) => element.style.setProperty("width", "420px", "important"));
      const section = frame(page).locator(`#${targetId(state)}`);
      await section.scrollIntoViewIfNeeded();
      await expect(section.locator(".failure-reason")).toBeVisible();
      if (state === "expanded" || state === "long") {
        const disclosure = section.locator(".receipt>details>summary").first();
        await disclosure.focus();
        await disclosure.press("Enter");
        await expect(section.locator(".receipt>details").first()).toHaveAttribute("open", "");
        await expect(
          section.getByRole("link", { name: "Open session", exact: true }).first(),
        ).toBeVisible();
        await section.locator(".reminders>summary").focus();
        await section.locator(".reminders>summary").press("Enter");
        await expect(section.locator(".reminder-body")).toBeVisible();
        if (state === "expanded") await section.locator(".failure>details>summary").click();
      }
      // No document or individual disclosure may overflow horizontally at narrow widths.
      expect(await section.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await section.locator(".receipt>details>summary").evaluateAll((rows) => {
        if (rows.some((row) => row.scrollWidth > row.clientWidth))
          throw new Error("Disclosure overflow");
      });
      await page.mouse.move(1, 1);
    },
    region: (page, state): Locator => frame(page).locator(`#${targetId(state)}`),
  };
}
