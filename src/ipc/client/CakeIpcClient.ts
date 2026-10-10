import { Context, Effect, Layer } from "effect";
import { RpcClient, type Rpc, type RpcClientError, type RpcGroup } from "effect/unstable/rpc";
import { CakeRpc } from "../protocol/CakeRpc";
import { NativePreviewTunnelRpc } from "../protocol/NativePreviewTunnelRpc";
import { groupRpcClient, type GroupedRpcClient } from "./grouped-rpc-client";
import { bindRpcAdapters } from "./rpc-adapters";

export const CakeClientRpc = CakeRpc.merge(NativePreviewTunnelRpc);
type Rpcs = RpcGroup.Rpcs<typeof CakeClientRpc>;
type Generated = GroupedRpcClient<Rpcs>;
type Payload<Tag extends Rpcs["_tag"]> = Rpc.Payload<Extract<Rpcs, { readonly _tag: Tag }>>;

/** Only semantic payload adaptations live here. All other operations are generated. */
export const cakeIpcAdapters = {
  speechOutput: {
    setProvider: (
      rpc: Generated["speechOutput"],
      provider: Payload<"speechOutput.setProvider">["provider"],
    ) => rpc.setProvider({ provider }),
    setApiKey: (rpc: Generated["speechOutput"], key: Payload<"speechOutput.setApiKey">["key"]) =>
      rpc.setApiKey({ key }),
    setVoice: (
      rpc: Generated["speechOutput"],
      voiceId: Payload<"speechOutput.setVoice">["voiceId"],
    ) => rpc.setVoice({ voiceId }),
    setSpeed: (rpc: Generated["speechOutput"], speed: Payload<"speechOutput.setSpeed">["speed"]) =>
      rpc.setSpeed({ speed }),
  },
  dictation: {
    setModelPath: (rpc: Generated["dictation"], path: Payload<"dictation.setModelPath">["path"]) =>
      rpc.setModelPath({ path }),
  },
  windowState: {
    save: (rpc: Generated["windowState"], snapshot: Payload<"windowState.save">["snapshot"]) =>
      rpc.save({ snapshot }),
  },
  piSettings: {
    update: (rpc: Generated["piSettings"], update: Payload<"piSettings.update">["update"]) =>
      rpc.update({ update }),
  },
  modelPresets: {
    remove: (rpc: Generated["modelPresets"], id: Payload<"modelPresets.remove">["id"]) =>
      rpc.remove({ id }),
    setDefault: (rpc: Generated["modelPresets"], id?: Payload<"modelPresets.setDefault">["id"]) =>
      rpc.setDefault({ id }),
    resolve: (rpc: Generated["modelPresets"], id: Payload<"modelPresets.resolve">["id"]) =>
      rpc.resolve({ id }),
  },
  cakeChats: {
    setUnread: (rpc: Generated["cakeChats"], unread: Payload<"cakeChats.setUnread">["unread"]) =>
      rpc.setUnread({ unread }),
    inspect: (rpc: Generated["cakeChats"], sessionId: Payload<"cakeChats.inspect">["sessionId"]) =>
      rpc.inspect({ sessionId }),
    respondControl: (
      rpc: Generated["cakeChats"],
      controlRequestId: Payload<"cakeChats.respondControl">["controlRequestId"],
      result: Payload<"cakeChats.respondControl">["result"],
    ) => rpc.respondControl({ controlRequestId, result }),
  },
  savedDrafts: {
    list: (rpc: Generated["savedDrafts"]) => rpc.list({}),
    observe: (rpc: Generated["savedDrafts"]) => rpc.observe({}),
    update: (
      rpc: Generated["savedDrafts"],
      record: Payload<"savedDrafts.update">["record"],
      expectedRevision: Payload<"savedDrafts.update">["expectedRevision"],
    ) => rpc.update({ record, expectedRevision }),
    remove: (
      rpc: Generated["savedDrafts"],
      sessionId: Payload<"savedDrafts.remove">["sessionId"],
      expectedRevision: Payload<"savedDrafts.remove">["expectedRevision"],
    ) => rpc.remove({ sessionId, expectedRevision }),
    recoverUncertain: (
      rpc: Generated["savedDrafts"],
      sessionId: Payload<"savedDrafts.recoverUncertain">["sessionId"],
      expectedRevision: Payload<"savedDrafts.recoverUncertain">["expectedRevision"],
    ) => rpc.recoverUncertain({ sessionId, expectedRevision, confirmedNoTurn: true }),
  },
  scheduledMessages: {
    observe: (
      rpc: Generated["scheduledMessages"],
      targetSessionId: Payload<"scheduledMessages.observe">["targetSessionId"],
    ) => rpc.observe({ targetSessionId }),
    list: (
      rpc: Generated["scheduledMessages"],
      targetSessionId?: Payload<"scheduledMessages.list">["targetSessionId"],
    ) => rpc.list(targetSessionId ? { targetSessionId } : {}),
    cancel: (rpc: Generated["scheduledMessages"], id: Payload<"scheduledMessages.cancel">["id"]) =>
      rpc.cancel({ id }),
  },
  projectSessions: {
    respondControl: (
      rpc: Generated["projectSessions"],
      sessionId: Payload<"projectSessions.respondControl">["sessionId"],
      controlRequestId: Payload<"projectSessions.respondControl">["controlRequestId"],
      result: Payload<"projectSessions.respondControl">["result"],
    ) => rpc.respondControl({ sessionId, controlRequestId, result }),
  },
  subagents: {
    observe: (
      rpc: Generated["subagents"],
      parentSessionId: Payload<"subagents.observe">["parentSessionId"],
    ) => rpc.observe({ parentSessionId }),
  },
  vscode: {
    release: (rpc: Generated["vscode"], leaseId: Payload<"vscode.release">["leaseId"]) =>
      rpc.release({ leaseId }),
    setVisible: (rpc: Generated["vscode"], visible: Payload<"vscode.setVisible">["visible"]) =>
      rpc.setVisible({ visible }),
    setTheme: (rpc: Generated["vscode"], theme: Payload<"vscode.setTheme">["theme"]) =>
      rpc.setTheme({ theme }),
  },
  artifacts: {
    effective: (
      rpc: Generated["artifacts"],
      sessionId: Payload<"artifacts.effective">["sessionId"],
    ) => rpc.effective({ sessionId }),
    detail: (rpc: Generated["artifacts"], lineageId: Payload<"artifacts.detail">["lineageId"]) =>
      rpc.detail({ lineageId }),
    readExact: (
      rpc: Generated["artifacts"],
      lineageId: Payload<"artifacts.readExact">["lineageId"],
      revision: Payload<"artifacts.readExact">["revision"],
    ) => rpc.readExact({ lineageId, revision }),
    referenceMetadata: (
      rpc: Generated["artifacts"],
      reference: Payload<"artifacts.referenceMetadata">["reference"],
    ) => rpc.referenceMetadata({ reference }),
    compareText: (
      rpc: Generated["artifacts"],
      lineageId: Payload<"artifacts.compareText">["lineageId"],
      fromRevision: Payload<"artifacts.compareText">["fromRevision"],
      toRevision: Payload<"artifacts.compareText">["toRevision"],
    ) => rpc.compareText({ lineageId, fromRevision, toRevision }),
    materialize: (
      rpc: Generated["artifacts"],
      sessionId: Payload<"artifacts.materialize">["sessionId"],
      lineageId: Payload<"artifacts.materialize">["lineageId"],
      revision: Payload<"artifacts.materialize">["revision"],
    ) => rpc.materialize({ sessionId, lineageId, revision }),
  },
};

/** Assemble the generated transport capability and its semantic payload adapters. */
function makeCakeIpcClient(client: RpcClient.RpcClient.Flat<Rpcs, RpcClientError.RpcClientError>) {
  const rpc = groupRpcClient(CakeClientRpc, client);
  return {
    ...rpc,
    speechOutput: {
      ...rpc.speechOutput,
      ...bindRpcAdapters(rpc.speechOutput, cakeIpcAdapters.speechOutput),
    },
    dictation: { ...rpc.dictation, ...bindRpcAdapters(rpc.dictation, cakeIpcAdapters.dictation) },
    windowState: {
      ...rpc.windowState,
      ...bindRpcAdapters(rpc.windowState, cakeIpcAdapters.windowState),
    },
    piSettings: {
      ...rpc.piSettings,
      ...bindRpcAdapters(rpc.piSettings, cakeIpcAdapters.piSettings),
    },
    modelPresets: {
      ...rpc.modelPresets,
      ...bindRpcAdapters(rpc.modelPresets, cakeIpcAdapters.modelPresets),
    },
    cakeChats: { ...rpc.cakeChats, ...bindRpcAdapters(rpc.cakeChats, cakeIpcAdapters.cakeChats) },
    savedDrafts: {
      ...rpc.savedDrafts,
      ...bindRpcAdapters(rpc.savedDrafts, cakeIpcAdapters.savedDrafts),
    },
    scheduledMessages: {
      ...rpc.scheduledMessages,
      ...bindRpcAdapters(rpc.scheduledMessages, cakeIpcAdapters.scheduledMessages),
    },
    projectSessions: {
      ...rpc.projectSessions,
      ...bindRpcAdapters(rpc.projectSessions, cakeIpcAdapters.projectSessions),
    },
    subagents: { ...rpc.subagents, ...bindRpcAdapters(rpc.subagents, cakeIpcAdapters.subagents) },
    vscode: { ...rpc.vscode, ...bindRpcAdapters(rpc.vscode, cakeIpcAdapters.vscode) },
    artifacts: { ...rpc.artifacts, ...bindRpcAdapters(rpc.artifacts, cakeIpcAdapters.artifacts) },
    events: {
      application: rpc.application.observeEvents,
      artifacts: rpc.artifacts.observeEvents,
      terminals: rpc.terminals.observeEvents,
      vscode: rpc.vscode.observeEvents,
      surfaces: rpc.electron.observeSurfaceEvents,
    },
  };
}

export type CakeIpcClientService = ReturnType<typeof makeCakeIpcClient>;

export class CakeIpcClient extends Context.Service<CakeIpcClient, CakeIpcClientService>()(
  "cake/ipc/client/CakeIpcClient",
) {}

export const CakeIpcClientLive = Layer.effect(
  CakeIpcClient,
  Effect.gen(function* () {
    const client = yield* RpcClient.make(CakeClientRpc, {
      flatten: true,
      spanPrefix: "CakeIpcClient",
    });
    return CakeIpcClient.of(makeCakeIpcClient(client));
  }),
);
