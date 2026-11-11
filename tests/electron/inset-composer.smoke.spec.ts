import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import type { InsetFixtureControls } from "./inset-composer-fixture";

const repository = resolve(import.meta.dirname, "../..");
const output = join(repository, ".visual-captures/inset-composer");
test("production inset composer: exclusive disclosures, live counts, keyboard, focus and theme/width evidence", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-inset-composer-"));
  await mkdir(output, { recursive: true });
  await build({
    entryPoints: [join(import.meta.dirname, "inset-composer-fixture.tsx")],
    outfile: join(directory, "fixture.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    target: "es2022",
    loader: { ".css": "empty", ".svg": "text", ".png": "dataurl" },
    plugins: [
      {
        name: "asset-urls",
        setup(builder) {
          builder.onResolve({ filter: /\?url$/ }, ({ path }) => ({ path, namespace: "asset-url" }));
          builder.onLoad({ filter: /.*/, namespace: "asset-url" }, ({ path }) => ({
            contents: `export default ${JSON.stringify(path)}`,
            loader: "js",
          }));
        },
      },
    ],
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
  });
  const assets = join(repository, "out/renderer/assets");
  const css = (await readdir(assets)).find(
    (name) => name.startsWith("index-") && name.endsWith(".css"),
  )!;
  const cssUrl = pathToFileURL(join(assets, css)).href;
  const html = join(directory, "fixture.html");
  await writeFile(
    html,
    `<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="${cssUrl}"></head><body><div id="root" style="height:760px;width:820px;margin:auto;position:relative"></div><script type="module" src="./fixture.js"></script></body></html>`,
  );
  const app = await electron.launch({
    args: [repository],
    cwd: repository,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: join(directory, "user-data"),
      CAKE_HOME: join(directory, "cake"),
      PI_CODING_AGENT_DIR: join(directory, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    await app.firstWindow();
    const errors: string[] = [];
    await app.evaluate(async ({ BrowserWindow }) => {
      const window = new BrowserWindow({
        show: false,
        width: 1100,
        height: 850,
        webPreferences: { sandbox: true },
      });
      await window.loadURL("about:blank#cake-inset-fixture");
    });
    const fixtureUrl = "about:blank#cake-inset-fixture";
    await expect.poll(() => app.windows().some((page) => page.url() === fixtureUrl)).toBe(true);
    const page = app.windows().find((page) => page.url() === fixtureUrl)!;
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    await page.goto(pathToFileURL(html).href);
    const activity = page.getByRole("button", { name: /^Activity ·/ });
    const attention = page.getByRole("button", { name: /^Needs attention ·/ });
    const activityPanel = page.getByRole("region", { name: "Conversation activity" });
    const attentionPanel = page.getByRole("region", { name: "Needs attention" });
    const composer = page.getByRole("combobox");
    await expect(activity, errors.join("\n")).toHaveAttribute("aria-label", "Activity · 3 running");
    await expect(activity).toHaveAttribute(
      "aria-description",
      "2 Project Sessions and 1 Temporary subagents",
    );
    await expect(attention).toHaveAttribute("aria-label", "Needs attention · 2 to-dos");
    await composer.fill("Keep this unsent draft");
    for (const theme of ["light", "dark"] as const) {
      for (const width of [820, 360]) {
        await page.evaluate(
          ({ theme, width }) => {
            document.documentElement.dataset.theme = theme;
            document.getElementById("root")!.style.width = `${width}px`;
          },
          { theme, width },
        );
        await expect(activity).toHaveAttribute("aria-expanded", "false");
        await expect(attention).toHaveAttribute("aria-expanded", "false");
        await page
          .locator("#root")
          .screenshot({ path: join(output, `${theme}-${width}-collapsed.png`) });
        await activity.focus();
        await activity.press("Enter");
        await expect(activityPanel).toBeVisible();
        expect(await activity.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
        expect(await activity.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe(
          "none",
        );
        await page
          .locator("#root")
          .screenshot({ path: join(output, `${theme}-${width}-activity.png`) });
        await activity.press("ArrowDown");
        await expect(attention).toBeFocused();
        await attention.press("Space");
        await expect(activityPanel).toHaveCount(0);
        await expect(attentionPanel).toBeVisible();
        await attention.press("Home");
        await expect(activity).toBeFocused();
        await activity.press("End");
        await expect(attention).toBeFocused();
        await attention.press("ArrowUp");
        await expect(activity).toBeFocused();
        await composer.focus();
        await composer.press("Escape");
        await expect(composer).toBeFocused();
        await expect(attentionPanel).toBeVisible();
        await page
          .locator("#root")
          .screenshot({ path: join(output, `${theme}-${width}-attention.png`) });
        const metrics = await page
          .locator('[data-slot="inset-disclosures"]')
          .evaluate((element) => {
            const headers = Array.from(element.querySelectorAll<HTMLElement>("[aria-expanded]"));
            const panel = element.querySelector<HTMLElement>('[role="region"]:not([hidden])')!;
            const form = element.closest(".workbench-composer")!.querySelector("form")!;
            const input = form.querySelector('[role="combobox"]')!.getBoundingClientRect();
            return {
              equal: headers.every((header) => header.getBoundingClientRect().height === 32),
              fit: headers.every((header) => header.scrollWidth <= header.clientWidth),
              height: panel.getBoundingClientRect().height,
              bound: Math.min(168, innerHeight * 0.25),
              rule: getComputedStyle(panel).borderLeftWidth,
              joined:
                Math.abs(
                  element.parentElement!.getBoundingClientRect().bottom -
                    form.getBoundingClientRect().top,
                ) < 2,
              topCorners: getComputedStyle(form).borderTopLeftRadius,
              composerVisible: input.top > 0 && input.bottom < innerHeight,
            };
          });
        expect(metrics).toMatchObject({
          equal: true,
          fit: true,
          rule: "1px",
          joined: true,
          topCorners: "0px",
          composerVisible: true,
        });
        expect(metrics.height).toBeLessThanOrEqual(metrics.bound + 1);
        await attentionPanel.getByRole("button").first().press("Escape");
        await expect(attention).toBeFocused();
        await expect(attentionPanel).toHaveCount(0);
      }
    }
    const update = async (activity: number, attention: number) =>
      page.evaluate(
        ({ activity, attention }) => {
          (window as Window & { insetFixture: InsetFixtureControls }).insetFixture.update(
            activity,
            attention,
          );
        },
        { activity, attention },
      );
    await composer.focus();
    await update(4, 10);
    await expect(activity).toHaveAttribute("aria-label", "Activity · 4 running");
    await expect(activity).toHaveAttribute(
      "aria-description",
      "3 Project Sessions and 1 Temporary subagents",
    );
    await expect(attention).toHaveAttribute("aria-label", "Needs attention · 10 to-dos");
    await expect(composer).toBeFocused();
    await expect(attention).toHaveAttribute("aria-expanded", "false");
    await attention.click();
    await composer.focus();
    await update(5, 11);
    await expect(composer).toBeFocused();
    await expect(attention).toHaveAttribute("aria-expanded", "true");
    await attentionPanel.hover();
    await page.mouse.wheel(0, 600);
    await expect
      .poll(() => attentionPanel.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(composer).toHaveValue("Keep this unsent draft");
    await update(0, 1);
    await expect(activity).toHaveCount(0);
    await expect(attentionPanel.getByRole("listitem")).toHaveCount(1);
    await update(1, 0);
    await expect(attention).toHaveCount(0);
    await expect(activity).toHaveAttribute("aria-expanded", "false");
    await update(0, 0);
    await expect(page.locator('[data-slot="inset-disclosures"]')).toHaveCount(0);
    await update(3, 2);
    await expect(activity).toHaveAttribute("aria-expanded", "false");
    await expect(attention).toHaveAttribute("aria-expanded", "false");
    expect(
      await page.evaluate(
        () => (window as Window & { insetFixture: InsetFixtureControls }).insetFixture.calls,
      ),
    ).toEqual([]);
    expect(errors).toEqual([]);

    // Optional comparison captures are pinned by source hash, never an artifact's "latest".
    if (process.env.CAKE_INSET_REFERENCE) {
      const source = await readFile(process.env.CAKE_INSET_REFERENCE, "utf8");
      expect(createHash("sha256").update(source).digest("hex")).toBe(
        "791d985e4e165cc9ec4c3f47b24ccec1c021f6da9669af708c50adccca9e467a",
      );
      const reference = join(directory, "reference.html");
      await writeFile(
        reference,
        source.replace("</head>", `<link rel="stylesheet" href="${cssUrl}"></head>`),
      );
      await page.goto(pathToFileURL(reference).href);
      for (const theme of ["light", "dark"]) {
        for (const width of ["wide", "narrow"]) {
          for (const open of [null, "activity", "attention"]) {
            await page.evaluate(
              ({ theme, width, open }) => {
                const api = (
                  window as Window & {
                    prototypeReview: {
                      selectVariant(v: number): void;
                      setView(v: string): void;
                      setWidth(v: string): void;
                      setOpen(v: string | null): void;
                    };
                  }
                ).prototypeReview;
                document.documentElement.dataset.theme = theme;
                api.selectVariant(5);
                api.setView("conversation");
                api.setWidth(width);
                api.setOpen(open);
              },
              { theme, width, open },
            );
            await page.locator(".app").screenshot({
              path: join(output, `reference-5-${theme}-${width}-${open ?? "collapsed"}.png`),
            });
          }
        }
      }
    }
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
