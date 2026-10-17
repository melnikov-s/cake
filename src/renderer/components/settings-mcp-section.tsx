import { useEffect } from "react";
import { observer } from "r-state-tree/react";
import type { McpSettingsStore } from "../stores/McpSettingsStore";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { Callout } from "./ui/callout";
import { mcpText } from "../lib/mcp-config-draft";
import { SettingsToggle } from "./settings/settings-toggle";

export const SettingsMcpSection = observer(function SettingsMcpSection({
  settings,
}: {
  settings: McpSettingsStore;
}) {
  useEffect(() => {
    void settings.load();
  }, [settings]);
  const target = settings.projectScope ? "project" : "backend";
  return (
    <section id="mcp-settings-title" className="grid gap-1.5" aria-label="MCP configuration">
      <header className="flex flex-wrap items-center justify-between gap-2 px-0.5">
        <h2 className="text-xs font-semibold text-foreground">MCP servers</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="rounded-sm"
            disabled={settings.busy || settings.authenticating}
            onClick={() => void settings.load()}
          >
            Refresh MCP
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="rounded-sm"
            disabled={settings.busy || settings.authenticating || settings.editing}
            onClick={() => void settings.load(true)}
          >
            Reveal configured secrets
          </Button>
          <Button
            size="sm"
            className="rounded-sm"
            disabled={settings.busy || !settings.scopeMatches || settings.authenticating}
            onClick={() => settings.add()}
          >
            Add MCP server
          </Button>
        </div>
      </header>
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">Configuration scope</strong>
            <small className="truncate text-[11px] text-muted-foreground">
              {settings.projectScope && settings.projectPath
                ? settings.projectPath
                : "Project entries override backend-wide servers of the same name."}
            </small>
          </div>
          <Select
            aria-label="MCP configuration scope"
            className="h-8 w-56 rounded-sm text-xs"
            value={settings.projectScope ? "project" : "backend"}
            disabled={settings.busy || settings.authenticating}
            onChange={(event) => void settings.selectScope(event.target.value === "project")}
          >
            <option value="backend">Backend-wide (personal)</option>
            <option value="project" disabled={!settings.projectPath}>
              Current Project / Working Directory
            </option>
          </Select>
        </div>
        {!settings.busy && settings.snapshot && settings.entries.length === 0 && (
          <p className="px-3.5 py-3 text-xs text-muted-foreground">No MCP servers configured.</p>
        )}
        {settings.entries.map((entry) => (
          <div
            key={`${entry.scope}:${entry.name}`}
            className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-xs font-medium text-foreground">{entry.name}</strong>
                <span className="text-[11px] text-muted-foreground">
                  {entry.scope} · {String(entry.config.exposure ?? "codemode")}
                  {entry.config.enabled === false ? " · Disabled" : ""}
                </span>
                {entry.overridden && (
                  <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    Overridden by Project
                  </span>
                )}
              </div>
              <small className="truncate font-mono text-[11px] text-muted-foreground">
                {entry.source}
              </small>
              {mcpText(entry.config.description) && (
                <small className="text-[11px] text-muted-foreground">
                  {mcpText(entry.config.description)}
                </small>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="rounded-sm"
                disabled={settings.busy || settings.authenticating}
                onClick={() => settings.edit(entry)}
              >
                {entry.scope === target
                  ? `Edit ${entry.name}`
                  : `Override ${entry.name} in Project`}
              </Button>
              {entry.scope === target && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-sm"
                    disabled={settings.busy || settings.authenticating}
                    onClick={() =>
                      void settings.mutate(
                        entry.name,
                        entry.config.enabled === false ? "enable" : "disable",
                      )
                    }
                  >
                    {entry.config.enabled === false ? "Enable" : "Disable"} {entry.name}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-sm"
                    disabled={settings.busy || settings.authenticating}
                    onClick={() => void settings.mutate(entry.name, "remove")}
                  >
                    Remove {entry.name}
                  </Button>
                </>
              )}
              {!entry.overridden &&
                (["login", "logout", "reconnect"] as const).map((action) => (
                  <Button
                    key={action}
                    variant="outline"
                    size="sm"
                    className="rounded-sm"
                    disabled={
                      !settings.nativeActionsAvailable || settings.busy || settings.authenticating
                    }
                    onClick={() => void settings.nativeAction(entry.name, action)}
                  >
                    {action === "login"
                      ? "Sign in"
                      : action === "logout"
                        ? "Sign out"
                        : "Reconnect"}{" "}
                    {entry.name}
                  </Button>
                ))}
            </div>
          </div>
        ))}
      </div>
      {settings.snapshot && !settings.scopeMatches && (
        <Callout variant="warning">
          The current Project changed. Refresh MCP settings before editing.
        </Callout>
      )}
      {settings.error && <Callout variant="error">{settings.error}</Callout>}
      {settings.notice && <Callout variant="info">{settings.notice}</Callout>}
      {settings.busy && (
        <p role="status" className="px-0.5 text-[11px] text-muted-foreground">
          Updating MCP settings…
        </p>
      )}
      {settings.authenticating && (
        <p role="status" className="px-0.5 text-[11px] text-muted-foreground">
          Running native Pi command… Sign-in can be cancelled in its native dialog.
        </p>
      )}
      {settings.editing && settings.scopeMatches && (
        <div
          className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50"
          aria-label="MCP server editor"
        >
          <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-xs">
            <span className="font-medium text-foreground">Server name</span>
            <Input
              aria-label="MCP server name"
              className="h-8 w-64 rounded-sm font-mono text-xs"
              value={settings.name}
              disabled={settings.existing || settings.busy}
              onChange={(event) => {
                settings.name = event.target.value;
              }}
            />
          </label>
          <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-xs">
            <span className="font-medium text-foreground">Transport</span>
            <Select
              aria-label="MCP transport"
              className="h-8 w-64 rounded-sm text-xs"
              value={settings.transport}
              onChange={(event) => {
                settings.transport = event.target.value;
              }}
            >
              <option value="stdio">Local executable (stdio)</option>
              <option value="http">Streamable HTTP</option>
            </Select>
          </label>
          <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-xs">
            <span className="font-medium text-foreground">
              {settings.transport === "stdio" ? "Executable" : "HTTP URL"}
            </span>
            <Input
              aria-label="MCP executable or URL"
              className="h-8 w-64 rounded-sm font-mono text-xs"
              value={settings.endpoint}
              onChange={(event) => {
                settings.endpoint = event.target.value;
              }}
            />
          </label>
          {settings.transport === "stdio" && (
            <>
              <label className="grid gap-1.5 px-3.5 py-2.5 text-xs">
                <span className="font-medium text-foreground">Arguments (one per line)</span>
                <Textarea
                  aria-label="MCP arguments"
                  className="min-h-16 rounded-sm font-mono text-xs"
                  value={settings.args}
                  onChange={(event) => {
                    settings.args = event.target.value;
                  }}
                />
              </label>
              <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-xs">
                <span className="font-medium text-foreground">Working directory</span>
                <Input
                  aria-label="MCP working directory"
                  className="h-8 w-64 rounded-sm font-mono text-xs"
                  value={settings.cwd}
                  onChange={(event) => {
                    settings.cwd = event.target.value;
                  }}
                />
              </label>
              <label className="grid gap-1.5 px-3.5 py-2.5 text-xs">
                <span className="font-medium text-foreground">Environment (JSON)</span>
                <Textarea
                  aria-label="MCP environment"
                  className="min-h-16 rounded-sm font-mono text-xs"
                  value={settings.env}
                  onChange={(event) => {
                    settings.env = event.target.value;
                  }}
                />
              </label>
            </>
          )}
          <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-xs">
            <span className="font-medium text-foreground">Description</span>
            <Input
              aria-label="MCP description"
              className="h-8 w-64 rounded-sm text-xs"
              value={settings.description}
              onChange={(event) => {
                settings.description = event.target.value;
              }}
            />
          </label>
          <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-xs">
            <span className="font-medium text-foreground">Tool exposure</span>
            <Select
              aria-label="MCP tool exposure"
              className="h-8 w-64 rounded-sm text-xs"
              value={settings.exposure}
              onChange={(event) => {
                settings.exposure = event.target.value;
              }}
            >
              <option value="codemode">Codemode (discovered in scripts)</option>
              <option value="deferred">Deferred (tool search)</option>
              <option value="direct">Direct (declared to model)</option>
              <option value="hidden">Hidden (unreachable)</option>
            </Select>
          </label>
          <SettingsToggle
            label="Enabled in configuration"
            description="Connect when an eligible session starts or reloads."
            checked={settings.enabled}
            onChange={(value) => {
              settings.enabled = value;
            }}
          />
          <label className="grid gap-1.5 px-3.5 py-2.5 text-xs">
            <span className="font-medium text-foreground">Advanced configuration (JSON)</span>
            <Textarea
              aria-label="MCP advanced configuration"
              className="min-h-24 rounded-sm font-mono text-xs"
              rows={5}
              value={settings.advanced}
              onChange={(event) => {
                settings.advanced = event.target.value;
              }}
            />
          </label>
          <div className="flex items-center justify-end gap-2 px-3.5 py-2.5">
            <Button
              variant="outline"
              size="sm"
              className="rounded-sm"
              disabled={settings.busy}
              onClick={() => settings.cancelEdit()}
            >
              Cancel edit
            </Button>
            <Button
              size="sm"
              className="rounded-sm"
              disabled={settings.busy || !settings.name.trim() || !settings.endpoint.trim()}
              onClick={() => void settings.save()}
            >
              Save MCP server
            </Button>
          </div>
        </div>
      )}
    </section>
  );
});
