import { observer, useStore } from "r-state-tree/react";
import { Avatar } from "@/components/ui/avatar";
import { IconButton } from "@/components/ui/icon-button";
import { RootStore } from "../stores/RootStore";

/** Header identity and navigation always belong to the pane's registered Project. */
export const ProjectChatHeaderLink = observer(function ProjectChatHeaderLink({
  projectPath,
}: {
  projectPath: string | undefined;
}) {
  const root = useStore(RootStore);
  const project = projectPath ? root.projectCatalogStore.find(projectPath) : undefined;
  if (!project) return null;
  const chat = root.cakeChatCollectionStore.projectChat(project.path);
  return (
    <IconButton
      className="size-5 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      tooltip={`Go to Project Chat for ${project.name}`}
      disabled={!chat}
      onClick={() => {
        if (chat) void root.navigationStore.openCakeChat(chat.sessionId);
      }}
    >
      <Avatar
        kind="project"
        seed={project.name}
        customIcon={project.settings.icon}
        className="size-5"
        aria-hidden="true"
      />
    </IconButton>
  );
});
