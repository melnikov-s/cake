import { LoadingSpinner } from "./loading-state";
import { IconButton } from "./icon-button";
import { Button } from "./button";
import { TooltipBubble, useTooltip } from "./tooltip";
import { AudioLinesIcon, CountdownRingIcon, EarIcon, EarOffIcon, StopIcon } from "./icons";

export interface VoiceConversationControlsProps {
  active: boolean;
  preparing: boolean;
  loadingVoice?: boolean;
  muted: boolean;
  disabled: boolean;
  sendProgress?: number;
  onCancelSend?(): void;
  onEnter(): void;
  onMute(muted: boolean): void;
  onExit(): void;
}

export function VoiceConversationControls(props: VoiceConversationControlsProps) {
  const { anchor, show, hide } = useTooltip();
  return (
    <div className="flex shrink-0 items-center gap-1.5" aria-label="Conversation mode">
      {!props.active && !props.preparing ? (
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 rounded-full bg-muted/50 px-3 text-foreground [&_svg]:size-4"
          aria-label="Enter conversation mode"
          disabled={props.disabled}
          onMouseEnter={(event) => show(event.currentTarget)}
          onMouseLeave={hide}
          onFocus={(event) => {
            if (event.currentTarget.matches(":focus-visible")) show(event.currentTarget);
          }}
          onBlur={hide}
          onClick={() => {
            hide();
            props.onEnter();
          }}
        >
          <AudioLinesIcon />
          Voice
          {anchor && <TooltipBubble label="Enter conversation mode" anchor={anchor} />}
        </Button>
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
          {props.loadingVoice && (
            <IconButton
              tooltip="Loading voice…"
              ariaLabel="Loading voice"
              aria-busy
              disabled
              className="rounded-full"
            >
              <span aria-hidden="true" className="grid">
                <LoadingSpinner />
              </span>
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
