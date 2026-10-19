import { useEffect, useState } from "react";
import { IconButton } from "./icon-button";
import { CheckIcon, CopyIcon } from "./icons";

/** Copies text on demand, reporting success only after the clipboard write completes. */
export function CopyButton({
  getText,
  onError,
  disabled,
  label = "message",
}: {
  getText(): Promise<string>;
  onError(error: unknown): void;
  disabled?: boolean;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      tooltip={copied ? `Copied ${label}` : `Copy ${label}`}
      ariaLabel={copied ? `Copied ${label}` : `Copy ${label}`}
      disabled={disabled || copying}
      aria-busy={copying}
      onClick={async () => {
        setCopied(false);
        setCopying(true);
        try {
          await navigator.clipboard.writeText(await getText());
          setCopied(true);
        } catch (error) {
          onError(error);
        } finally {
          setCopying(false);
        }
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
}
