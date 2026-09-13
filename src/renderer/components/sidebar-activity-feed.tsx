import { observer } from "r-state-tree/react";
import type { AppearanceSettingsStore } from "../stores/AppearanceSettingsStore";
import type { AppShellStore } from "../stores/AppShellStore";
import type { CakeChatCollectionStore } from "../stores/CakeChatCollectionStore";
import type { ProjectCatalogStore } from "../stores/ProjectCatalogStore";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { SidebarStore } from "../stores/SidebarStore";
import { AnimatedList } from "./ui/animated-list";
import { SidebarSessionItem } from "./sidebar-session-item";

function dayKey(iso: string) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(iso: string, now: number) {
  const date = new Date(iso);
  const today = new Date(now);
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const daysAgo = Math.round((startToday - startDate) / 86_400_000);
  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/** Date-grouped cross-Project navigation for active Project and Cake Chat sessions. */
export const SidebarActivityFeed = observer(function SidebarActivityFeed({
  store,
  projects,
  chat,
  cakeChat,
  shell,
  appearance,
  onOpenSession,
  onOpenCakeChat,
}: {
  store: SidebarStore;
  projects: ProjectCatalogStore;
  chat: ProjectWorkbenchStore;
  cakeChat: CakeChatCollectionStore;
  shell: AppShellStore;
  appearance: AppearanceSettingsStore;
  onOpenSession(sessionId: string): void;
  onOpenCakeChat(sessionId?: string): void;
}) {
  const entries = [
    ...store.activeProjectSessionFamilies.map((family) => ({
      kind: "project" as const,
      modifiedAt: family.latestModifiedAt,
      family,
    })),
    ...store.activeCakeChatSessions.map((session) => ({
      kind: "cake-chat" as const,
      modifiedAt: session.modifiedAt,
      session,
    })),
  ].sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = dayKey(entry.modifiedAt);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  if (entries.length === 0)
    return <p className="mx-2 my-3 text-[13px] text-muted-foreground">No active sessions.</p>;

  return (
    <div data-slot="activity-feed" className="space-y-4">
      {[...groups.values()].map((group) => (
        <section key={dayKey(group[0]!.modifiedAt)}>
          <h2 className="px-2 pb-1.5 text-[13px] font-medium text-muted-foreground">
            {dayLabel(group[0]!.modifiedAt, store.now)}
          </h2>
          <AnimatedList className="flex flex-col space-y-0.5 pl-2">
            {group.map((entry) => {
              if (entry.kind === "cake-chat") {
                const { session } = entry;
                const selected =
                  shell.selection.kind === "cake-chat" &&
                  shell.selection.sessionId === session.sessionId;
                const running = cakeChat.registry.find(session.sessionId)?.streaming === true;
                return (
                  <SidebarSessionItem
                    key={`cake-chat:${session.sessionId}`}
                    store={store}
                    session={session}
                    selected={selected}
                    resolved={false}
                    activity={running ? "running" : undefined}
                    labels={[]}
                    avatarSeed={session.sessionId}
                    avatarsEnabled={false}
                    source={{ kind: "cake-chat", name: "Cake Chat" }}
                    onOpen={onOpenCakeChat}
                    onRename={(sessionId, name) =>
                      void cakeChat.management.renameSession(sessionId, name)
                    }
                    onResolve={(sessionId, resolved) =>
                      void store.setCakeChatSessionResolved(sessionId, resolved)
                    }
                    onDelete={(sessionId) => void store.deleteCakeChatSession(sessionId)}
                  />
                );
              }
              return (
                <div
                  key={`project-family:${entry.family.rootSessionId}`}
                  data-animated-list-key={`project-family:${entry.family.rootSessionId}`}
                  className="flex flex-col space-y-0.5"
                >
                  {entry.family.sessions.map((session) => {
                    const selected =
                      shell.selection.kind === "project-session" &&
                      shell.selection.sessionId === session.sessionId;
                    const projectName = projects.nameForPath(session.projectPath);
                    return (
                      <SidebarSessionItem
                        key={`project:${session.sessionId}`}
                        store={store}
                        session={session}
                        managedWorktree={store.managedWorktree(session.workingDirectory)}
                        selected={selected}
                        paneNumber={chat.paneNumber?.(session.sessionId)}
                        resolved={false}
                        activity={store.sessionActivityForDisplay(session)}
                        labels={store.sessionLabels(session.sessionId)}
                        avatarSeed={store.sessionAvatarSeed(session.sessionId)}
                        avatarsEnabled={appearance.sessionAvatarsEnabled}
                        source={{
                          kind: "project",
                          name: projectName,
                          avatarSeed: projectName,
                          showAvatar: appearance.projectAvatarsEnabled,
                        }}
                        onOpen={onOpenSession}
                        onToggleFamily={(sessionId) => store.toggleFamilyCollapsed(sessionId)}
                        familyCollapsed={store.isFamilyCollapsed(session.sessionId)}
                        onRename={(sessionId, name) =>
                          void chat.sessionManagementStore.renameSession(sessionId, name)
                        }
                        onResolve={(sessionId, resolved) =>
                          void store.setSessionResolved(sessionId, resolved)
                        }
                        onSetLabels={(sessionId, labelIds) =>
                          void store.setSessionLabels(sessionId, labelIds)
                        }
                        onDelete={(sessionId) => void store.deleteSession(sessionId)}
                        onMarkUnread={(sessionId, unread) =>
                          void store.setSessionUnread(sessionId, unread)
                        }
                      />
                    );
                  })}
                </div>
              );
            })}
          </AnimatedList>
        </section>
      ))}
    </div>
  );
});
