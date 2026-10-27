import { createServer, type ServerResponse } from "node:http";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Page, type CDPSession } from "@playwright/test";
import { fixture, createPerformanceFixture, marker, sessionId } from "./fixtures/performance";
import { installLocalModelHttpGuard } from "./main-harness";
import {
  metricNames,
  type Metric,
  type Run,
  type Sample,
} from "../../scripts/performance/regression";

const root = resolve(import.meta.dirname, "../..");
const live = '.transcript:not([data-slot="content-transition-outgoing"] *)';
const input = 'textarea[aria-label="Message"]';
type Probe = {
  event: "mousedown" | "keydown";
  target: string;
  present: string[];
  absent?: string[];
  text?: string;
  value?: string;
  label?: string;
};

/** DOM event -> settled, visible destination and one further frame opportunity.
 * No Playwright polling/round-trip duration is included in the measured interval.
 */
async function arm(page: Page, probe: Probe) {
  await page.evaluate((probe) => {
    const state = { result: undefined as { ms: number; longTasks: number[] } | undefined };
    Object.assign(window, { cakeRegressionProbe: state });
    const listener = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest(probe.target)) return;
      document.removeEventListener(probe.event, listener, true);
      const started = performance.now();
      const mark = `cake.perf.${probe.label}`;
      performance.mark(`${mark}.start`);
      const tasks: number[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) tasks.push(entry.duration);
      });
      observer.observe({ type: "longtask" });
      const visible = (element: Element | null) => {
        if (!(element instanceof HTMLElement) || !element.getClientRects().length) return false;
        for (let node: HTMLElement | null = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (
            style.display === "none" ||
            style.visibility !== "visible" ||
            Number(style.opacity) === 0 ||
            node.getAnimations().some((a) => a.playState === "running")
          )
            return false;
        }
        return true;
      };
      const ready = () => {
        if (!probe.present.every((selector) => visible(document.querySelector(selector))))
          return false;
        if (probe.absent?.some((selector) => document.querySelector(selector))) return false;
        if (probe.text) {
          const transcript = document.querySelector(probe.present[0]!);
          if (!transcript) return false;
          const viewport = transcript.getBoundingClientRect();
          const walker = document.createTreeWalker(transcript, NodeFilter.SHOW_TEXT);
          let found = false;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.includes(probe.text) || !visible(node.parentElement)) continue;
            const bounds = node.parentElement!.getBoundingClientRect();
            if (
              bounds.top >= Math.max(0, viewport.top) &&
              bounds.bottom <= Math.min(innerHeight, viewport.bottom) &&
              bounds.right > viewport.left &&
              bounds.left < viewport.right
            ) {
              found = true;
              break;
            }
          }
          if (!found) return false;
        }
        const composer = document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message"]',
        );
        if (!composer || composer.disabled) return false;
        return probe.value === undefined || composer.value === probe.value;
      };
      const frame = () => {
        if (performance.now() - started > 30000) {
          observer.disconnect();
          return;
        }
        if (ready())
          requestAnimationFrame(() => {
            if (!ready()) {
              requestAnimationFrame(frame);
              return;
            }
            tasks.push(...observer.takeRecords().map((entry) => entry.duration));
            observer.disconnect();
            state.result = { ms: performance.now() - started, longTasks: tasks };
            performance.mark(`${mark}.end`);
            performance.measure(mark, `${mark}.start`, `${mark}.end`);
          });
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    document.addEventListener(probe.event, listener, true);
  }, probe);
}
async function measured(page: Page, probe: Probe, action: () => Promise<unknown>) {
  await arm(page, probe);
  await action();
  await page.waitForFunction(
    () => Boolean(Reflect.get(window, "cakeRegressionProbe")?.result),
    undefined,
    {
      timeout: 35000,
    },
  );
  return page.evaluate(
    () => Reflect.get(window, "cakeRegressionProbe").result as { ms: number; longTasks: number[] },
  );
}
async function saveTrace(cdp: CDPSession, path: string) {
  const complete = new Promise<{ stream?: string }>((done) =>
    cdp.once("Tracing.tracingComplete", done),
  );
  await cdp.send("Tracing.end");
  const { stream } = await complete;
  if (!stream) throw new Error("Chromium did not return a renderer trace stream");
  async function* chunks() {
    try {
      for (;;) {
        const chunk = await cdp.send("IO.read", { handle: stream!, size: 1024 * 1024 });
        yield Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
        if (chunk.eof) break;
      }
    } finally {
      await cdp.send("IO.close", { handle: stream! });
    }
  }
  await pipeline(chunks(), createGzip(), createWriteStream(path));
}

test("user-visible performance collection @performance", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  test.skip(
    !process.env.CAKE_PERFORMANCE_RUN,
    "Use pnpm perf:collect or perf:check (isolated performance config)",
  );
  test.setTimeout(20 * 60_000);
  const run: Run = JSON.parse(await readFile(process.env.CAKE_PERFORMANCE_RUN!, "utf8"));
  const n = run.samplesPerMetric;
  let calls = 0;
  let pending: ServerResponse | undefined;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(500).end("Unexpected fixture request");
      return;
    }
    // Drain the real request; never depend on its response latency.
    for await (const chunk of request) void chunk;
    calls++;
    if (pending) throw new Error("Overlapping provider request");
    pending = response; // Hold all provider tokens until UI feedback has been measured.
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture server address");
  const origin = `http://127.0.0.1:${address.port}`;
  const f = await createPerformanceFixture(origin, n);
  const application = await electron.launch({
    args: [root],
    cwd: root,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      LANG: "en_US.UTF-8",
      HOME: f.home,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: f.userData,
      CAKE_HOME: f.cakeHome,
      PI_CODING_AGENT_DIR: join(f.cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  let cdp: CDPSession | undefined;
  const errors: string[] = [];
  const metrics = Object.fromEntries(metricNames.map((name) => [name, []])) as unknown as Record<
    Metric,
    Sample[]
  >;
  try {
    await installLocalModelHttpGuard(application, origin);
    const page = await application.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize(fixture.viewport);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.locator(live).getByText(marker(0), { exact: true })).toBeVisible({
      timeout: 60000,
    });
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline,blink.user_timing",
      transferMode: "ReturnAsStream",
    });
    const row = (i: number) => `.session-item[data-session-id="${sessionId(i)}"] .session-row`;
    const pane = (i: number) => `[data-slot="session-pane"][data-session-id="${sessionId(i)}"]`;
    const switchTo = async (i: number) => {
      await page.locator(row(i)).click();
      await expect(page.locator(live).getByText(marker(i), { exact: true })).toBeVisible();
    };
    const sample = async (name: Metric, probe: Probe, action: () => Promise<unknown>) => {
      const before = calls;
      const timing = await measured(
        page,
        { ...probe, label: `${name}.${metrics[name].length}` },
        action,
      );
      metrics[name].push({
        ...timing,
        iteration: metrics[name].length,
        providerCalls: calls - before,
      });
    };
    const switchProbe = (i: number): Probe => ({
      event: "mousedown",
      target: row(i),
      present: [`${pane(i)} ${live}`, `${pane(i)} ${input}`],
      text: marker(i),
    });
    // Expose all rows outside timing. Each cold destination is never opened in this process.
    const showMore = page.getByRole("button", { name: "Show more", exact: true });
    while (await showMore.count()) await showMore.click();
    for (let i = 3; i < n + 3; i++) {
      await sample("switch.cold.ready", switchProbe(i), () => page.locator(row(i)).click());
    }
    // Fixed warm-up, discarded. Only two destinations remain hot; no eviction between samples.
    for (const i of [0, 1, 0, 1, 0]) await switchTo(i);
    for (let i = 0; i < n; i++) {
      const destination = (i + 1) % 2;
      await sample("switch.warm.ready", switchProbe(destination), () =>
        page.locator(row(destination)).click(),
      );
      const composer = page.locator(input);
      await composer.focus();
      await expect(composer).toBeFocused();
      await sample(
        "composer.input",
        { event: "keydown", target: input, present: [input], value: "x" },
        () => composer.press("x"),
      );
      await expect(composer).toHaveValue("x");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await composer.fill("");
    }
    // Keep one resolved session so the expanded lane survives repeated resolve/restore cycles.
    await switchTo(0);
    await page
      .locator(`.session-item[data-session-id="${sessionId(2)}"] .session-resolve-action`)
      .click();
    await page.getByRole("button", { name: "Expand Resolved", exact: true }).click();
    await page
      .getByRole("button", { name: "Expand Performance project resolved", exact: true })
      .last()
      .click();
    const resolvedRow = (i: number) =>
      `[aria-label="Resolved sessions"] .session-item[data-session-id="${sessionId(i)}"]`;
    for (let i = 0; i < n; i++) {
      await switchTo(0);
      await switchTo(1);
      const resolve = `.session-item[data-session-id="${sessionId(1)}"] .session-resolve-action`;
      await sample(
        "session.resolve",
        {
          event: "mousedown",
          target: resolve,
          present: [resolvedRow(1), `${pane(0)} ${live}`, input],
        },
        () => page.locator(resolve).click(),
      );
      await page.locator(`${resolvedRow(1)} .session-row`).click();
      await expect(page.getByTestId("resolved-session-notice")).toBeVisible();
      const restore = page.locator(resolvedRow(1)).getByRole("button", { name: /^Restore / });
      const restoreSelector = `${resolvedRow(1)} button[aria-label^="Restore "]`;
      await sample(
        "session.restore",
        {
          event: "mousedown",
          target: restoreSelector,
          present: [
            `.session-item[data-session-id="${sessionId(1)}"] .session-resolve-action`,
            `${pane(1)} ${input}`,
          ],
          absent: ['[data-testid="resolved-session-notice"]', resolvedRow(1)],
        },
        () => restore.click(),
      );
    }
    await switchTo(0);
    // Three discarded send warmups establish a ready Pi runtime and HTTP path.
    for (let i = -3; i < n; i++) {
      const composer = page.locator(input);
      const text = `Performance submission ${i}`;
      await composer.focus();
      await composer.pressSequentially(text);
      await expect(composer).toHaveValue(text);
      const send = page.getByRole("button", { name: "Send", exact: true });
      await expect(send).toBeEnabled();
      const before = calls;
      const probe: Probe = {
        event: "mousedown",
        target: 'button[aria-label="Send"]',
        present: [live, 'button[aria-label="Stop"]', input],
        text,
        value: "",
      };
      if (i >= 0) await sample("message.feedback", probe, () => send.click());
      else await send.click();
      await expect.poll(() => calls).toBe(before + 1);
      if (i >= 0) metrics["message.feedback"].at(-1)!.providerCalls = calls - before;
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      pending!.writeHead(200, { "content-type": "text/event-stream" });
      pending!.end(
        chunk({ role: "assistant", content: `Fixture acknowledgement ${i}` }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
      );
      pending = undefined;
      await expect(
        page.locator(live).getByText(`Fixture acknowledgement ${i}`, { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    }
    expect(calls).toBe(n + 3);
    expect(errors).toEqual([]);
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible() && !w.isFocused()),
      ),
    ).toBe(true);
    run.metrics = metrics;
    await writeFile(process.env.CAKE_PERFORMANCE_RUN!, JSON.stringify(run, null, 2) + "\n");
  } finally {
    await writeFile(
      testInfo.outputPath("partial-samples.json"),
      JSON.stringify({ metrics, errors, calls }, null, 2),
    );
    try {
      if (cdp) await saveTrace(cdp, testInfo.outputPath("renderer-trace.json.gz"));
    } finally {
      pending?.end();
      await application.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await f.cleanup();
    }
  }
});
