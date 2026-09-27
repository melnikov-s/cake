import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const signInUrl = "https://auth.example.test/device";
const manualSignInUrl = "https://auth.example.test/authorize?state=fixture";
const providerId = "cake-auth-fixture";

async function writeProvider(home: string) {
  const extensionDirectory = join(home, "pi", "extensions");
  await mkdir(extensionDirectory, { recursive: true });
  // The external OAuth adapter is deterministic, while Pi's ModelRuntime,
  // auth persistence, Cake's handler, transport and renderer remain real.
  await writeFile(
    join(extensionDirectory, "auth-fixture.js"),
    `export default function (pi) {
      let attempts = 0;
      pi.registerProvider({
        id: ${JSON.stringify(providerId)}, name: "Cake auth fixture",
        auth: { oauth: {
          name: "Cake auth fixture",
          async login(interaction) {
            const firstAttempt = ++attempts === 1;
            if (firstAttempt)
              interaction.notify({ type: "device_code", verificationUri: ${JSON.stringify(signInUrl)}, userCode: "TEST-CODE" });
            else
              interaction.notify({ type: "auth_url", url: ${JSON.stringify(manualSignInUrl)}, instructions: "Authorize on this device." });
            const answer = await interaction.prompt({ type: firstAttempt ? "secret" : "manual_code", message: firstAttempt ? "Enter the test token" : "Paste redirect URL" });
            if (answer !== "fixture-secret") throw new Error("Incorrect fixture token");
            return { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000 };
          },
          async refresh(credential) { return credential; },
          async toAuth(credential) { return { apiKey: credential.access }; },
        } },
        getModels() { return [{ id: "fixture-model", name: "Fixture model", provider: ${JSON.stringify(providerId)}, api: "openai-completions", baseUrl: "https://unused.example.test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 }]; },
        stream() { throw new Error("Fixture does not make provider requests"); },
        streamSimple() { throw new Error("Fixture does not make provider requests"); },
      });
    }\n`,
  );
}

async function startServer(home: string, root: string) {
  const server = spawn(process.execPath, [join(repositoryRoot, "out/server/main.mjs")], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      CAKE_HOME: home,
      CAKE_SERVER_ENABLED: "true",
      CAKE_SERVER_ALLOW_MISSING_ORIGIN: "true",
      CAKE_SERVER_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const url = await new Promise<string>((resolveUrl, reject) => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /ws:\/\/127\.0\.0\.1:\d+\/rpc/.exec(output);
      if (match) resolveUrl(match[0]);
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", onData);
    server.once("exit", () => reject(new Error(`Auth fixture server stopped: ${output}`)));
    server.once("error", reject);
  });
  return { server, url };
}

async function closeServer(server: ChildProcess) {
  if (server.exitCode !== null) return;
  const stopped = new Promise<void>((resolveStop) => server.once("exit", () => resolveStop()));
  server.kill("SIGTERM");
  await stopped;
}

for (const mode of ["local", "remote"] as const) {
  test(`${mode} Electron presents server-owned device authentication and submits from this device`, async () => {
    test.setTimeout(90_000);
    const root = await mkdtemp(join(tmpdir(), `cake-${mode}-auth-`));
    const serverHome = join(root, "server-home");
    const userData = join(root, "desktop");
    await mkdir(userData, { recursive: true });
    await writeProvider(serverHome);
    let server: ChildProcess | undefined;
    let application: ElectronApplication | undefined;
    try {
      if (mode === "remote") {
        const remote = await startServer(serverHome, root);
        server = remote.server;
        await writeFile(
          join(userData, "desktop-host.json"),
          JSON.stringify({ kind: "remote", url: remote.url }),
        );
        await mkdir(
          join(userData, "remote-hosts", createHash("sha256").update(remote.url).digest("hex")),
          { recursive: true },
        );
      }
      application = await electron.launch({
        args: [repositoryRoot],
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CAKE_ELECTRON_SMOKE: "1",
          CAKE_ELECTRON_USER_DATA: userData,
          CAKE_HOME: mode === "local" ? serverHome : join(root, "local-backend-must-not-exist"),
        },
      });
      const opened = application;
      const page = await opened.firstWindow();
      page.setDefaultTimeout(15_000);
      await opened.evaluate(({ shell }) => {
        Object.defineProperty(shell, "openExternal", {
          configurable: true,
          value: async (url: string) => {
            (
              globalThis as typeof globalThis & { cakeTestExternalUrls?: string[] }
            ).cakeTestExternalUrls ??= [];
            (
              globalThis as typeof globalThis & { cakeTestExternalUrls: string[] }
            ).cakeTestExternalUrls.push(url);
          },
        });
      });
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await page.getByRole("button", { name: /^Providers/ }).click();
      const provider = page.locator("article").filter({ hasText: "Cake auth fixture" });
      await expect(provider.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
      await provider.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(provider.getByText("TEST-CODE", { exact: true })).toBeVisible();
      await expect(provider.getByText(signInUrl, { exact: true })).toBeVisible();
      const form = page.getByRole("alertdialog", {
        name: `Provider authentication · ${providerId}`,
      });
      await expect(form).toBeVisible();
      await expect(form.getByText("TEST-CODE", { exact: true })).toBeVisible();
      await form.getByRole("button", { name: "Open verification page on this device" }).click();
      await expect
        .poll(() =>
          opened.evaluate(
            () =>
              (globalThis as typeof globalThis & { cakeTestExternalUrls?: string[] })
                .cakeTestExternalUrls ?? [],
          ),
        )
        .toEqual([signInUrl]);
      const secret = form.locator('input[type="password"]');
      await secret.click();
      await expect(secret).toBeFocused();
      await secret.pressSequentially("fixture-secret");
      await expect(secret).toHaveValue("fixture-secret");
      await expect(form.getByRole("button", { name: "Continue" })).toBeEnabled();
      await form.getByRole("button", { name: "Continue" }).click();
      await expect(provider.getByText(/Connected/)).toBeVisible();
      expect(await readFile(join(serverHome, "pi", "auth.json"), "utf8")).toContain(
        "fixture-access",
      );
      if (mode === "remote") {
        await expect
          .poll(async () =>
            readFile(join(root, "local-backend-must-not-exist", "pi", "auth.json", "utf8")).then(
              () => true,
              () => false,
            ),
          )
          .toBe(false);
      }
      await provider.getByRole("button", { name: "Disconnect", exact: true }).click();
      await expect(provider.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
      expect(await readFile(join(serverHome, "pi", "auth.json"), "utf8")).not.toContain(
        "fixture-access",
      );
      await provider.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(form).toBeVisible();
      await expect(form.getByText(manualSignInUrl, { exact: true })).toBeVisible();
      await expect(
        form.getByText(/If your browser cannot reach the server's callback address/),
      ).toBeVisible();
      await form.getByRole("button", { name: "Open sign-in page on this device" }).click();
      await expect
        .poll(() =>
          opened.evaluate(
            () =>
              (globalThis as typeof globalThis & { cakeTestExternalUrls?: string[] })
                .cakeTestExternalUrls ?? [],
          ),
        )
        .toEqual([signInUrl, manualSignInUrl]);
      await form.getByRole("button", { name: "Cancel" }).click();
      await expect(form).toBeHidden();
      expect(await readFile(join(serverHome, "pi", "auth.json"), "utf8")).not.toContain(
        "fixture-access",
      );
    } finally {
      await application?.close();
      if (server) await closeServer(server);
      await rm(root, { recursive: true, force: true });
    }
  });
}
