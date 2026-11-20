import { IconButton, type IconButtonProps } from "./icon-button";
import { SendIcon } from "./icons";
import { cn } from "@/lib/utils";

/** Shared submit treatment for chat and annotation composers. */
export function ComposerSubmitButton(
  props: IconButtonProps & { type?: "submit"; children?: never },
) {
  return (
    <IconButton
      {...props}
      type="submit"
      className={cn(
        "size-8 rounded-full bg-accent text-accent-foreground shadow-xs hover:bg-accent/90 disabled:opacity-40",
        props.className,
      )}
    >
      <SendIcon />
    </IconButton>
  );
}
