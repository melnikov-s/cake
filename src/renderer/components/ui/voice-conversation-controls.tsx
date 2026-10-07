import { LoadingSpinner } from "./loading-state";
import { IconButton } from "./icon-button";
import { AudioLinesIcon, CountdownRingIcon, EarIcon, EarOffIcon, StopIcon } from "./icons";

export interface VoiceConversationControlsProps {
  active: boolean;
  preparing: boolean;
  muted: boolean;
  disabled: boolean;
  sendProgress?: number;
  onCancelSend?(): void;
  onEnter(): void;
  onMute(muted: boolean): void;
  onExit(): void;
}

export function VoiceConversationControls(props: VoiceConversationControlsProps) {
  return (
    <div className="flex shrink-0 items-center gap-1.5" aria-label="Conversation mode">
      {!props.active && !props.preparing ? (
        <IconButton
          tooltip="Enter conversation mode"
          disabled={props.disabled}
          onClick={props.onEnter}
        >
          <AudioLinesIcon />
        </IconButton>
      ) : (
        <>
          {props.preparing ? (
            <IconButton
              tooltip="Preparing voice…"
              ariaLabel="Preparing conversation mode"
              aria-busy
              disabled
              className="rounded-full"
            >
              <span aria-hidden="true" className="grid">
                <LoadingSpinner />
              </span>
            </IconButton>
          ) : (
            <IconButton
              tooltip={
                props.sendProgress !== undefined
                  ? "Sending after pause — cancel send"
                  : props.muted
                    ? "Input muted — unmute input"
                    : "Listening — mute input"
              }
              ariaLabel={
                props.sendProgress !== undefined
                  ? "Cancel automatic send"
                  : props.muted
                    ? "Unmute input"
                    : "Mute input"
              }
              className="relative rounded-full"
              pressedAppearance="subtle"
              aria-pressed={!props.muted}
              onClick={() =>
                props.sendProgress !== undefined
                  ? props.onCancelSend?.()
                  : props.onMute(!props.muted)
              }
            >
              {props.muted ? <EarOffIcon /> : <EarIcon />}
              {props.sendProgress !== undefined && (
                <CountdownRingIcon progress={props.sendProgress} />
              )}
            </IconButton>
          )}
          <IconButton tooltip="Exit conversation mode" onClick={props.onExit}>
            <StopIcon />
          </IconButton>
        </>
      )}
    </div>
  );
}
