import { useEffect, useState } from "react";
import { IconButton } from "./icon-button";
import { CheckIcon, CopyIcon } from "./icons";

/** Runs a clipboard action, reporting success only after the write completes. */
export function CopyButton({
  getText,
  copy,
  onError,
  disabled,
  label = "message",
  className,
}: {
  /** Omit when a failed copy needs no explanation beyond the missing confirmation. */
  onError?(error: unknown): void;
  disabled?: boolean;
  label?: string;
  className?: string;
} & ({ getText(): Promise<string>; copy?: never } | { copy(): Promise<void>; getText?: never })) {
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      iconSize="inline"
      className={className}
      tooltip={copied ? `Copied ${label}` : `Copy ${label}`}
      ariaLabel={copied ? `Copied ${label}` : `Copy ${label}`}
      disabled={disabled || copying}
      aria-busy={copying}
      onClick={async () => {
        setCopied(false);
        setCopying(true);
        try {
          if (copy) await copy();
          else await navigator.clipboard.writeText(await getText());
          setCopied(true);
        } catch (error) {
          onError?.(error);
        } finally {
          setCopying(false);
        }
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
}
