import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");
test("configures Cake's built-in MCP server through Settings and connects without a bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-local-mcp-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  const scenario = findVisualCaptureScenario("local-mcp-server");
  if (!scenario) throw new Error("Missing local MCP capture scenario");
  await scenario.seed(paths, "dark");
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.on("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const testPort = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const application = await electron.launch({
    args: ["--force-device-scale-factor=1", repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: paths.userData,
      CAKE_HOME: paths.cakeHome,
      PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await application.firstWindow();
    await scenario.prepare(page, "default", application);
    const section = page.getByRole("region", { name: "Cake MCP server", exact: true });
    const port = section.getByRole("textbox", { name: "MCP server port" });
    await expect(port).toHaveValue("4318");
    await port.focus();
    await port.press("ControlOrMeta+A");
    await port.pressSequentially("0");
    await expect(port).toBeFocused();
    await expect(port).toHaveValue("0");
    await section.getByRole("switch", { name: "Enable MCP server", exact: true }).click();
    await expect(
      section.getByText("Port must be an integer from 1 to 65535.", { exact: true }),
    ).toBeVisible();
    await expect(section.getByText("Off", { exact: true })).toBeVisible();
    await port.fill(String(testPort));
    await section.getByRole("switch", { name: "Enable MCP server", exact: true }).click();
    await expect(section.getByText("Running", { exact: true })).toBeVisible();
    await section
      .getByRole("button", { name: "Copy MCP client configuration", exact: true })
      .click();
    await expect(
      section.getByRole("button", { name: "Copied MCP client configuration", exact: true }),
    ).toBeVisible();
    const text = await application.evaluate(({ clipboard }) => clipboard.readText());
    const config = JSON.parse(text).mcpServers.cake;
    expect(config.type).toBe("http");
    expect(config.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const client = new McpClient({ name: "cake-desktop-test", version: "1" });
    const transport = new StreamableHttpTransport({
      url: config.url,
      headers: config.headers,
      openGetStream: false,
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).map((tool) => tool.name)).toEqual(["cake"]);
      const result = await client.callTool("cake", { command: "projects.list" });
      expect(JSON.stringify(result.content)).toContain(paths.project);
      const help = await client.callTool("cake", { command: "sessions.cake.help" });
      expect(JSON.stringify(help.content)).toContain("sessions.cake");
      await client.callTool("cake", {
        command: "projects.rename",
        input: { path: paths.project, name: "Renamed over MCP" },
      });
      expect(
        JSON.stringify(
          (
            await client.callTool("cake", {
              command: "projects.info",
              input: { path: paths.project },
            })
          ).content,
        ),
      ).toContain("Renamed over MCP");
    } finally {
      await client.close();
    }
    await section.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(section.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
    expect(
      JSON.parse(await readFile(join(paths.cakeHome, "state", "mcp-server.json"), "utf8"))
        .configuration,
    ).toEqual({ enabled: true, port: testPort });
    await section.getByRole("switch", { name: "Enable MCP server", exact: true }).click();
    await expect(section.getByText("Off", { exact: true })).toBeVisible();
    await expect(async () => {
      await expect(fetch(config.url, { headers: config.headers })).rejects.toThrow();
    }).toPass();
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
