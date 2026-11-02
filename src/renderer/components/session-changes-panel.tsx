import { observer } from "r-state-tree/react";
import { BranchIcon, VsCodeIcon } from "./ui/icons";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { Select } from "./ui/select";
import { LoadingState } from "./ui/loading-state";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { ChangeStats } from "./ui/change-stats";
import { SessionChangeCommit } from "./session-change-commit";
import { SessionChangeFile } from "./session-change-file";
import { changeTotals } from "../../contracts/worktrees/worktree-changes";
import type { SessionChangesStore } from "../stores/SessionChangesStore";

export const SessionChangesPanel = observer(function SessionChangesPanel({
  store,
}: {
  store: SessionChangesStore;
}) {
  const data = store.data;
  if (!data && store.loading && !store.error) return <LoadingState />;
  const dirty = data ? [...data.staged, ...data.unstaged] : [];
  const dirtyCount = new Set(dirty.map((file) => file.path)).size;
  return (
    <div className="h-full overflow-y-auto bg-sidebar/30 pb-4">
      {store.error && <Callout variant="error">{store.error}</Callout>}
      {data && (
        <>
          <div className="flex min-w-0 items-center gap-2 px-4 pt-3 pb-2 text-xs text-muted-foreground">
            <span className="shrink-0">
              <BranchIcon />
            </span>
            <span className="truncate font-medium text-foreground" title={data.branch}>
              {data.branch}
            </span>
            <span>→</span>
            {data.base === null ? (
              <span className="truncate">No parent branch</span>
            ) : data.baseAlternatives.length > 1 ? (
              <Select
                size="sm"
                aria-label="Compare with"
                className="h-6 w-auto min-w-0 truncate"
                value={data.base}
                onChange={(event) => store.selectBase(event.target.value)}
              >
                {(data.baseAlternatives.some((candidate) => candidate.branch === data.base)
                  ? data.baseAlternatives
                  : [{ branch: data.base }, ...data.baseAlternatives]
                ).map(({ branch }) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </Select>
            ) : (
              <span className="truncate" title={data.base}>
                {data.base}
              </span>
            )}
          </div>
          <div className="px-4 pb-4">
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1.5"
              onClick={() => void store.openWorkspaceChanges()}
            >
              <VsCodeIcon />
              Open in VS Code
            </Button>
          </div>
          <DisclosureTrigger
            title="Commits"
            open={store.commitsExpanded}
            chevronPosition="start"
            className="px-4 py-2 hover:bg-muted/55"
            subtitle={data.totalCommits}
            trailing={
              <ChangeStats {...changeTotals(data.commits.flatMap((commit) => commit.files))} />
            }
            onClick={() => store.toggleCommits()}
          />
          {store.commitsExpanded && (
            <div>
              {data.commits.length === 0 && (
                <p className="px-4 py-3 text-xs text-muted-foreground">No commits</p>
              )}
              {data.commits.map((commit) => (
                <SessionChangeCommit key={commit.hash} commit={commit} store={store} />
              ))}
              {data.totalCommits > data.commits.length && (
                <p className="px-4 py-2 text-xs text-muted-foreground">
                  Showing {data.commits.length} of {data.totalCommits} commits
                </p>
              )}
            </div>
          )}
          <section className="mt-3 border-t border-border/75 pt-1.5">
            <DisclosureTrigger
              title="Uncommitted"
              open={store.uncommittedExpanded}
              chevronPosition="start"
              className="px-4 py-2 hover:bg-muted/55"
              subtitle={dirtyCount}
              trailing={<ChangeStats {...changeTotals(dirty)} />}
              onClick={() => store.toggleUncommitted()}
            />
            {store.uncommittedExpanded && (
              <>
                {dirtyCount === 0 && (
                  <p className="px-4 py-3 text-xs text-muted-foreground">Working tree clean</p>
                )}
                {(["staged", "unstaged"] as const).map(
                  (group) =>
                    data[group].length > 0 && (
                      <section key={group} aria-label={group === "staged" ? "Staged" : "Unstaged"}>
                        <div className="flex items-center gap-2 px-4 pt-2 pb-1 text-xs text-muted-foreground">
                          <span>{group === "staged" ? "Staged" : "Unstaged"}</span>
                          <span>{data[group].length}</span>
                          <span className="flex-1" />
                          <ChangeStats {...changeTotals(data[group])} />
                        </div>
                        {data[group].map((file) => (
                          <SessionChangeFile key={file.path} file={file} store={store} />
                        ))}
                      </section>
                    ),
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
});
