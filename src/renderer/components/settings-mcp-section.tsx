import { useEffect } from "react";
import { observer } from "r-state-tree/react";
import type { McpSettingsStore } from "../stores/McpSettingsStore";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
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
    <section
      id="mcp-settings-title"
      className="grid gap-4 border-t border-border py-5"
      aria-label="MCP configuration"
    >
      <p className="text-xs text-muted-foreground">
        Pi-native server configuration on the connected backend. Project entries replace backend
        entries with the same name. Only trusted Projects can be edited. These are stored settings,
        not connection status.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="MCP configuration scope"
          value={settings.projectScope ? "project" : "backend"}
          disabled={settings.busy || settings.authenticating}
          onChange={(event) => void settings.selectScope(event.target.value === "project")}
        >
          <option value="backend">Backend-wide (personal)</option>
          <option value="project" disabled={!settings.projectPath}>
            Current Project / Working Directory
          </option>
        </Select>
        <Button
          variant="outline"
          size="sm"
          disabled={settings.busy || settings.authenticating}
          onClick={() => void settings.load()}
        >
          Refresh MCP
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={settings.busy || settings.authenticating || settings.editing}
          onClick={() => void settings.load(true)}
        >
          Reveal configured secrets
        </Button>
        <Button
          size="sm"
          disabled={settings.busy || !settings.scopeMatches || settings.authenticating}
          onClick={() => settings.add()}
        >
          Add MCP server
        </Button>
      </div>
      {settings.projectScope && (
        <p className="break-all text-xs text-muted-foreground">
          {settings.projectPath} — personal credentials belong in backend-wide configuration.
        </p>
      )}
      {settings.snapshot && !settings.scopeMatches && (
        <Callout variant="warning">
          The current Project changed. Refresh MCP settings before editing.
        </Callout>
      )}
      {settings.error && <Callout variant="error">{settings.error}</Callout>}
      {settings.notice && <Callout variant="info">{settings.notice}</Callout>}
      {settings.busy && (
        <p role="status" className="text-xs text-muted-foreground">
          Updating MCP settings…
        </p>
      )}
      {!settings.busy && settings.snapshot && settings.entries.length === 0 && (
        <p className="text-sm text-muted-foreground">No MCP servers configured.</p>
      )}
      <div className="grid gap-3">
        {settings.entries.map((entry) => (
          <div
            key={`${entry.scope}:${entry.name}`}
            className="grid gap-2 rounded-md border border-border p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-sm">{entry.name}</strong>
              <Badge variant="outline" size="xs">
                {entry.scope}
              </Badge>
              <Badge variant="outline" size="xs">
                {entry.config.enabled === false ? "Disabled in config" : "Enabled in config"}
              </Badge>
              {entry.overridden && (
                <Badge variant="outline" size="xs">
                  Overridden by Project
                </Badge>
              )}
            </div>
            <p className="break-all text-xs text-muted-foreground">{entry.source}</p>
            {mcpText(entry.config.description) && (
              <p className="text-xs">{mcpText(entry.config.description)}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Exposure: {String(entry.config.exposure ?? "codemode")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
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
      <p className="text-xs text-muted-foreground">
        Live status and tool counts await a public Pi SDK API. Choose Current Project scope for sign
        in, sign out and reconnect: these use the current eligible Project Session’s effective
        configuration and native /mcp command and dialogs. Remote sign-in may ask for the redirected
        URL from your browser; no browser opens on the backend.
      </p>
      {settings.authenticating && (
        <p role="status" className="text-xs text-muted-foreground">
          Running native Pi command… Sign-in can be cancelled in its native dialog.
        </p>
      )}
      {settings.editing && settings.scopeMatches && (
        <div
          className="grid gap-4 rounded-md border border-border p-4"
          aria-label="MCP server editor"
        >
          <label className="grid gap-1 text-xs">
            Server name
            <Input
              aria-label="MCP server name"
              value={settings.name}
              disabled={settings.existing || settings.busy}
              onChange={(event) => {
                settings.name = event.target.value;
              }}
            />
          </label>
          <label className="grid gap-1 text-xs">
            Transport
            <Select
              aria-label="MCP transport"
              value={settings.transport}
              onChange={(event) => {
                settings.transport = event.target.value;
              }}
            >
              <option value="stdio">Local executable (stdio)</option>
              <option value="http">Streamable HTTP</option>
            </Select>
          </label>
          <label className="grid gap-1 text-xs">
            {settings.transport === "stdio" ? "Executable (not a shell command)" : "HTTP URL"}
            <Input
              aria-label="MCP executable or URL"
              value={settings.endpoint}
              onChange={(event) => {
                settings.endpoint = event.target.value;
              }}
            />
          </label>
          {settings.transport === "stdio" && (
            <>
              <label className="grid gap-1 text-xs">
                Arguments (one per line; stored values masked until reveal)
                <Textarea
                  aria-label="MCP arguments"
                  value={settings.args}
                  onChange={(event) => {
                    settings.args = event.target.value;
                  }}
                />
              </label>
              <label className="grid gap-1 text-xs">
                Working directory (relative to session directory)
                <Input
                  aria-label="MCP working directory"
                  value={settings.cwd}
                  onChange={(event) => {
                    settings.cwd = event.target.value;
                  }}
                />
              </label>
              <label className="grid gap-1 text-xs">
                Environment (JSON object)
                <Textarea
                  aria-label="MCP environment"
                  value={settings.env}
                  onChange={(event) => {
                    settings.env = event.target.value;
                  }}
                />
              </label>
            </>
          )}
          <label className="grid gap-1 text-xs">
            Description
            <Input
              aria-label="MCP description"
              value={settings.description}
              onChange={(event) => {
                settings.description = event.target.value;
              }}
            />
          </label>
          <label className="grid gap-1 text-xs">
            Tool exposure
            <Select
              aria-label="MCP tool exposure"
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
            description="Pi connects when an eligible session starts or reloads."
            checked={settings.enabled}
            onChange={(value) => {
              settings.enabled = value;
            }}
          />
          <label className="grid gap-1 text-xs">
            Advanced configuration (JSON object)
            <Textarea
              aria-label="MCP advanced configuration"
              rows={8}
              value={settings.advanced}
              onChange={(event) => {
                settings.advanced = event.target.value;
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Optional headers, oauth (clientId, clientSecret, callbackPort, callbackUrl, scope,
            clientName, authServerMetadataUrl), timeout (seconds), toolExposure (exact names or *
            patterns), and backend-only auth.provider. Use ${"{ENV_NAME}"} references. Stored-value
            placeholders retain existing secrets. !command values execute only when Pi connects,
            never while viewing settings. Basic controls take precedence over advanced keys.
          </p>
          <div className="flex gap-2">
            <Button
              disabled={settings.busy || !settings.name.trim() || !settings.endpoint.trim()}
              onClick={() => void settings.save()}
            >
              Save MCP server
            </Button>
            <Button
              variant="outline"
              disabled={settings.busy}
              onClick={() => settings.cancelEdit()}
            >
              Cancel edit
            </Button>
          </div>
        </div>
      )}
    </section>
  );
});
