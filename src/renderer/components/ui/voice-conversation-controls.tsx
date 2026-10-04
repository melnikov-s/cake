import { Button } from "./button";
import { Badge } from "./badge";
import { Callout } from "./callout";
import { IconButton } from "./icon-button";
import { AudioLinesIcon, StopIcon } from "./icons";

export interface VoiceConversationControlsProps {
  active: boolean;
  preparing: boolean;
  muted: boolean;
  listening: boolean;
  speaking: boolean;
  disabled: boolean;
  error?: string;
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
          <Badge>
            {props.preparing
              ? "Preparing voice…"
              : props.speaking
                ? "Speaking"
                : props.muted
                  ? "Input muted"
                  : props.listening
                    ? "Listening"
                    : "Voice"}
          </Badge>
          {!props.preparing && (
            <Button size="sm" variant="ghost" onClick={() => props.onMute(!props.muted)}>
              {props.muted ? "Unmute input" : "Mute input"}
            </Button>
          )}
          <IconButton tooltip="Exit conversation mode" onClick={props.onExit}>
            <StopIcon />
          </IconButton>
        </>
      )}
      {props.error && <Callout variant="error">{props.error}</Callout>}
    </div>
  );
}
