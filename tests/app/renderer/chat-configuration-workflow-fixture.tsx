import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type { ConversationSnapshot } from "../../../src/ipc/conversation-data";
import type { ModelOption, ModelPreset } from "../../../src/ipc/session-contract";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export function configurationModel(overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    provider: "openai",
    providerName: "OpenAI",
    id: "gpt-5",
    name: "GPT-5",
    reasoning: true,
    availableThinkingLevels: ["off", "medium", "high"],
    fastMode: false,
    input: ["text"],
    authenticated: true,
    authTypes: [],
    ...overrides,
  };
}

export function configurationSnapshot(
  sessionId: string,
  models: readonly ModelOption[],
): ConversationSnapshot {
  const current = models[0];
  return {
    sessionId,
    sessionFile: `/project/${sessionId}.jsonl`,
    parts: [],
    ...(current
      ? { model: { provider: current.provider, id: current.id, name: current.name } }
      : null),
    models,
    thinkingLevel: "high",
    availableThinkingLevels: current?.availableThinkingLevels ?? ["off"],
    fastMode: false,
    fastModeAvailable: current?.fastMode ?? false,
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
}

export function renderChatConfiguration(options: {
  client?: TestClientOverrides;
  deferred?: boolean;
  models?: readonly ModelOption[];
  secondaryModels?: readonly ModelOption[];
  presets?: readonly ModelPreset[];
}) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: options.deferred
      ? []
      : ["first", ...(options.secondaryModels ? ["second"] : [])].map((sessionId) =>
          sessionSummary({ sessionId, projectPath: "/project" }),
        ),
    client: {
      ...options.client,
      workspaces: {
        loadStagedSlashCommands: async () => [],
        generateSessionTitle: async () => undefined,
        ...options.client?.workspaces,
      },
    },
  });
  fixture.root.settingsStore.applyApplicationState(0, {
    ...defaultApplicationState(),
    modelPresets: [...(options.presets ?? [])],
  });
  const session = options.deferred
    ? fixture.root.sessionRegistry.pendingSessions.prepareStaged("/project", "first")
    : fixture.root.sessionRegistry.load("first", "/project");
  fixture.root.appShellStore.selectProjectSession("first");
  fixture.root.projectWorkbenchStore.showLoadedSession("first");
  let revision = 0;
  function publish(snapshot: ConversationSnapshot) {
    applyConversationUpdate(fixture.models.projectConversation(snapshot.sessionId, "/project"), {
      _tag: "Snapshot",
      revision: ++revision,
      snapshot,
    });
  }
  if (!options.deferred) publish(configurationSnapshot("first", options.models ?? []));
  const second = options.secondaryModels
    ? fixture.root.sessionRegistry.load("second", "/project")
    : undefined;
  if (second) publish(configurationSnapshot("second", options.secondaryModels ?? []));
  const view = render(
    <>
      <section aria-label="First conversation">
        <Chat
          store={session.conversationSessionStore.chatStore}
          embedded
          composerFocusEnabled={false}
        />
      </section>
      {second && (
        <section aria-label="Second conversation">
          <Chat
            store={second.conversationSessionStore.chatStore}
            embedded
            composerFocusEnabled={false}
          />
        </section>
      )}
    </>,
  );
  return {
    user: userEvent.setup(),
    publish(snapshot: ConversationSnapshot) {
      act(() => publish(snapshot));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
