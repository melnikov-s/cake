import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../../stores/RootStore";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Select } from "../ui/select";
import { PlusIcon, RepeatIcon, SettingsIcon, ContextIcon } from "../ui/icons";
import { LoadingState } from "../ui/loading-state";
import { cn } from "../../lib/utils";

export const AutomationOverview = observer(function AutomationOverview() {
  const root = useStore(RootStore);
  const hub = root.automationsStore;
  const projects = root.projectCatalogStore.projects;
  return (
    <section className="h-full min-h-0 overflow-auto px-8 py-7" aria-label="Automation overview">
      <header className="flex items-center justify-between gap-3">
        <h1 className="font-display text-xl font-semibold tracking-tight">Automations</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void hub.showGlobalHistory()}>
            History
          </Button>
          <Button className="gap-2" onClick={() => root.navigationStore.createAutomation()}>
            <PlusIcon />
            New automation
          </Button>
        </div>
      </header>
      <div
        className="mt-6 flex flex-wrap items-center gap-5 border-b border-border/65 pb-5 text-xs"
        aria-label="Automation totals"
      >
        <span>
          <strong>{hub.runningAutomationCount}</strong> automations running
        </span>
        <span>
          <strong>{hub.activeSessionCount}</strong> active sessions
        </span>
        <span>
          <strong>{hub.queuedOccurrenceCount}</strong> queued occurrences
        </span>
      </div>
      <div className="my-4 flex flex-wrap items-center justify-between gap-4">
        <nav className="flex flex-wrap gap-3" aria-label="Automation lifecycle">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "rounded-none border-b-2 border-transparent px-0",
              !hub.state && !hub.runningOnly && "border-accent text-foreground",
            )}
            aria-pressed={!hub.state && !hub.runningOnly}
            onClick={() => hub.setState(undefined)}
          >
            All
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "rounded-none border-b-2 border-transparent px-0",
              hub.runningOnly && "border-accent text-foreground",
            )}
            aria-pressed={hub.runningOnly}
            onClick={() => hub.showRunning()}
          >
            Running
          </Button>
          {(["active", "paused", "suspended", "archived"] as const).map((state) => (
            <Button
              key={state}
              size="sm"
              variant="ghost"
              aria-pressed={hub.state === state}
              onClick={() => hub.setState(state)}
              className={cn(
                "rounded-none border-b-2 border-transparent px-0",
                hub.state === state && "border-accent text-foreground",
              )}
            >
              {state[0]!.toUpperCase() + state.slice(1)}
            </Button>
          ))}
        </nav>
        <Select
          className="w-48"
          aria-label="Filter by project"
          value={
            hub.project?._tag === "Project"
              ? hub.project.projectPath
              : hub.project?._tag === "Global"
                ? "global"
                : "all"
          }
          onChange={(event) =>
            hub.setProject(
              event.currentTarget.value === "all"
                ? undefined
                : event.currentTarget.value === "global"
                  ? { _tag: "Global" }
                  : { _tag: "Project", projectPath: event.currentTarget.value },
            )
          }
        >
          <option value="all">All projects</option>
          <option value="global">Global</option>
          {projects.map((project) => (
            <option key={project.path} value={project.path}>
              {project.name}
            </option>
          ))}
        </Select>
      </div>
      {!hub.catalog.loaded ? (
        <LoadingState label="Loading automations" />
      ) : (
        <div className="overflow-auto">
          <table className="w-full min-w-[650px] text-left text-xs" aria-label="Automations">
            <thead className="text-muted-foreground">
              <tr>
                {["Automation", "Project", "Next run", "State", "Activity", ""].map((label) => (
                  <th key={label} className="border-b border-border/65 py-3 pr-4 font-normal">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {hub.filtered.map((item) => (
                <tr key={item.id} className="border-b border-border/65">
                  <td className="py-4 pr-4">
                    <Button
                      variant="ghost"
                      className="h-auto justify-start gap-3 px-0 text-left font-medium"
                      onClick={() => {
                        if (item.id) void root.navigationStore.editAutomation(item.id);
                      }}
                    >
                      <RepeatIcon />
                      {item.name}
                    </Button>
                  </td>
                  <td className="pr-4">
                    {item.context._tag === "Global"
                      ? "Global"
                      : root.projectCatalogStore.nameForPath(item.context.projectPath)}
                  </td>
                  <td className="pr-4 text-muted-foreground">
                    {item.nextScheduledAt ? new Date(item.nextScheduledAt).toLocaleString() : "—"}
                  </td>
                  <td
                    className={cn(
                      "pr-4",
                      item.state._tag === "active" && "text-success",
                      item.state._tag === "suspended" && "text-warning",
                    )}
                  >
                    {item.state._tag}
                    <span className="mt-1 block text-muted-foreground">
                      {item.state._tag === "suspended" ? item.state.reason : null}
                    </span>
                  </td>
                  <td className="pr-4">
                    {item.activity.runningSessions
                      ? `${item.activity.runningSessions} running`
                      : "Idle"}
                    {item.activity.queuedOccurrences
                      ? ` · ${item.activity.queuedOccurrences} queued`
                      : ""}
                  </td>
                  <td>
                    <div className="flex justify-end gap-1">
                      <IconButton
                        tooltip={`Memory for ${item.name}`}
                        onClick={() => {
                          if (item.id)
                            void root.navigationStore
                              .editAutomation(item.id)
                              .then(() => hub.showTab("memory"));
                        }}
                      >
                        <ContextIcon />
                      </IconButton>
                      <IconButton
                        tooltip={`Settings for ${item.name}`}
                        onClick={() => {
                          if (item.id) void root.navigationStore.editAutomation(item.id);
                        }}
                      >
                        <SettingsIcon />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hub.filtered.length === 0 && (
            <p className="py-8 text-sm text-muted-foreground">No matching automations.</p>
          )}
        </div>
      )}
    </section>
  );
});
