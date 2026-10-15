import { useEffect, useState } from "react";
import { IconButton } from "./icon-button";
import { CheckIcon, LinkIcon } from "./icons";

/** Copies an exact reference without fetching its destination or contents. */
export function CopyReferenceButton({
  reference,
  label,
  className,
}: {
  reference: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      className={className}
      tooltip={copied ? `Copied ${label}` : `Copy ${label}`}
      ariaLabel={copied ? `Copied ${label}` : `Copy ${label}`}
      onClick={() => void navigator.clipboard.writeText(reference).then(() => setCopied(true))}
    >
      {copied ? <CheckIcon /> : <LinkIcon />}
    </IconButton>
  );
}
