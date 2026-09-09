import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { UiPart } from "../../../ipc/session-contract";
import { projectRetryNotice } from "./cake-runtime-event-projection";
import { ResponseRetryController } from "./response-retry";
import {
  INTERRUPTED_TURN_NOTICE_PART_ID,
  TURN_RECOVERY_MAX_AUTO_CONTINUATIONS,
  TURN_RECOVERY_NOTICE_PART_ID,
  classifyTurnFailure,
  interruptedTurnResumePrompt,
  shouldAutoResumeInterruptedTurn,
  turnRecoveryPrompt,
} from "./turn-recovery";

export interface CakeRuntimeRecovery {
  readonly transientParts: () => UiPart[];
  readonly withResponseRetries: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly cancelResponseRetries: () => void;
  readonly onUserInput: () => void;
  readonly onAbort: () => void;
  readonly handleSettledTurn: () => Promise<void>;
  readonly resumeInterruptedTurn: () => Promise<void>;
  readonly dispose: () => void;
}

export function createCakeRuntimeRecovery(input: {
  readonly session: AgentSession;
  readonly retryEnabled: () => boolean;
  readonly isDisposed: () => boolean;
  readonly emitPart: (part: UiPart) => void;
  readonly removePart: (partId: string) => void;
}): CakeRuntimeRecovery {
  const { session } = input;
  let responseRetryTurnDepth = 0;
  let userAbortRequested = false;
  let turnRecoveryContinuations = 0;
  let failureDetail: string | undefined;

  const responseRetries = new ResponseRetryController({
    enabled: () => responseRetryTurnDepth > 0 && input.retryEnabled(),
    onRetry: (event) => input.emitPart(projectRetryNotice(event)),
    onFinished: () => input.removePart("active-retry"),
  });
  session.agent.streamFunction = responseRetries.wrap(session.agent.streamFunction);

  const removeRecoveryNotice = () => {
    failureDetail = undefined;
    input.removePart(TURN_RECOVERY_NOTICE_PART_ID);
  };

  const recoveryFailureNotice = (detail: string): Extract<UiPart, { kind: "notice" }> => ({
    id: TURN_RECOVERY_NOTICE_PART_ID,
    kind: "notice",
    tone: "error",
    title: "Response could not be completed",
    detail: `${detail} Automatic recovery stopped. Send another message to retry manually.`,
  });

  const emitRecoveryFailure = (detail: string) => {
    failureDetail = detail;
    input.emitPart(recoveryFailureNotice(detail));
  };

  const withResponseRetries = async <T>(operation: () => Promise<T>): Promise<T> => {
    responseRetryTurnDepth += 1;
    try {
      return await operation();
    } finally {
      responseRetryTurnDepth -= 1;
    }
  };

  const continueTurnHidden = async (content: string) => {
    try {
      await withResponseRetries(() =>
        session.sendCustomMessage(
          {
            customType: "cake.turn-recovery",
            content,
            display: false,
          },
          { triggerTurn: true, deliverAs: "followUp" },
        ),
      );
      return true;
    } catch (error) {
      if (!input.isDisposed())
        emitRecoveryFailure(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  return {
    transientParts: () => (failureDetail ? [recoveryFailureNotice(failureDetail)] : []),
    withResponseRetries,
    cancelResponseRetries: () => responseRetries.cancel(),
    onUserInput() {
      userAbortRequested = false;
      turnRecoveryContinuations = 0;
      removeRecoveryNotice();
    },
    onAbort() {
      userAbortRequested = true;
      turnRecoveryContinuations = 0;
      removeRecoveryNotice();
    },
    async handleSettledTurn() {
      // A user prompt or another run may have started while the settled snapshot
      // was being assembled. It supersedes recovery of the previous turn.
      if (input.isDisposed() || session.isStreaming) return;
      const last = session.messages.at(-1);
      const failure = classifyTurnFailure(
        last?.role === "assistant" ? last : undefined,
        userAbortRequested,
      );
      if (!failure) {
        if (turnRecoveryContinuations > 0) {
          turnRecoveryContinuations = 0;
          removeRecoveryNotice();
          input.removePart(INTERRUPTED_TURN_NOTICE_PART_ID);
        }
        return;
      }
      if (
        !input.retryEnabled() ||
        turnRecoveryContinuations >= TURN_RECOVERY_MAX_AUTO_CONTINUATIONS
      ) {
        input.removePart(INTERRUPTED_TURN_NOTICE_PART_ID);
        emitRecoveryFailure(failure.detail);
        return;
      }
      turnRecoveryContinuations += 1;
      await continueTurnHidden(turnRecoveryPrompt(failure.kind));
    },
    async resumeInterruptedTurn() {
      if (input.isDisposed() || session.isStreaming) return;
      const tail = session.messages.at(-1);
      const settledFailure = classifyTurnFailure(tail?.role === "assistant" ? tail : undefined);
      if (settledFailure?.kind === "empty") {
        emitRecoveryFailure(settledFailure.detail);
        return;
      }
      if (!input.retryEnabled() || !shouldAutoResumeInterruptedTurn(session.messages)) return;
      turnRecoveryContinuations = TURN_RECOVERY_MAX_AUTO_CONTINUATIONS;
      input.emitPart({
        id: INTERRUPTED_TURN_NOTICE_PART_ID,
        kind: "notice",
        tone: "info",
        title: "Resuming interrupted turn",
      });
      if (!(await continueTurnHidden(interruptedTurnResumePrompt)) && !input.isDisposed())
        input.removePart(INTERRUPTED_TURN_NOTICE_PART_ID);
    },
    dispose() {
      responseRetries.cancel();
    },
  };
}
