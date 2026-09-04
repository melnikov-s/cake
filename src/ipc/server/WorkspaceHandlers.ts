import { Effect } from "effect";
import * as projects from "../../domain/projects";
import { WorkspaceFiles } from "../../services/filesystem/WorkspaceFiles";
import { WorkspaceRpc } from "../protocol/WorkspaceRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

const withConnection = <A, E, R>(operation: (connectionId: number) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(RendererConnection, ({ connectionId }) => operation(connectionId));

export const workspaceHandlers = WorkspaceRpc.of({
  "filesystem.choose-attachments": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(WorkspaceFiles, (service) => service.chooseAttachments(connectionId, request)),
    ),
  "filesystem.suggest-files": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(WorkspaceFiles, (service) => service.suggestFiles(connectionId, request)),
    ),
  "filesystem.read-workspace-file": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(WorkspaceFiles, (service) => service.readFile(connectionId, request)),
    ),
  "workspaces.reword-composer-selection": (request) =>
    withConnection((connectionId) => projects.rewordComposerSelection(connectionId, request)),
  "workspaces.generate-session-title": (request) =>
    withConnection((connectionId) => projects.generateSessionTitle(connectionId, request)),
  "workspaces.set-utility-model": (request) =>
    withConnection((connectionId) => projects.setUtilityModel(connectionId, request)),
  "workspaces.load-staged-slash-commands": (request) =>
    withConnection((connectionId) => projects.loadStagedSlashCommands(connectionId, request)),
  "workspaces.register-project": (request) =>
    withConnection((connectionId) => projects.register(connectionId, request)),
  "workspaces.rename-project": (request) =>
    withConnection((connectionId) => projects.rename(connectionId, request)),
  "workspaces.set-project-settings": (request) =>
    withConnection((connectionId) => projects.setProjectSettings(connectionId, request)),
  "workspaces.remove-project": (request) =>
    withConnection((connectionId) => projects.remove(connectionId, request)),
  "workspaces.delete-session": (request) =>
    withConnection((connectionId) => projects.deleteSession(connectionId, request)),
  "workspaces.set-session-unread": (request) =>
    withConnection((connectionId) => projects.setSessionUnread(connectionId, request)),
  "workspaces.restart-pi": (request) =>
    withConnection((connectionId) => projects.restartPi(connectionId, request)),
  "workspaces.inspect-workspace": (request) =>
    withConnection((connectionId) => projects.inspect(connectionId, request)),
  "workspaces.respond-workspace-trust": (request) =>
    withConnection((connectionId) => projects.respondTrust(connectionId, request)),
});
