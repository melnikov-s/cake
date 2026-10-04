import { Badge } from "./badge";
import { IconButton } from "./icon-button";
import { AudioLinesIcon, EarIcon, EarOffIcon, StopIcon } from "./icons";

export interface VoiceConversationControlsProps {
  active: boolean;
  preparing: boolean;
  muted: boolean;
  disabled: boolean;
  onEnter(): void;
  onMute(muted: boolean): void;
  onExit(): void;
}

export function VoiceConversationControls(props: VoiceConversationControlsProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Conversation mode">
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
            <Badge>Preparing voice…</Badge>
          ) : (
            <IconButton
              tooltip={props.muted ? "Input muted — unmute input" : "Listening — mute input"}
              ariaLabel={props.muted ? "Unmute input" : "Mute input"}
              aria-pressed={!props.muted}
              onClick={() => props.onMute(!props.muted)}
            >
              {props.muted ? <EarOffIcon /> : <EarIcon />}
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
