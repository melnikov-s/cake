import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { CheckIcon, CopyIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export function CopyFilePathButton({ path, className }: { path: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <IconButton
      className={cn(
        "pointer-events-none size-6 shrink-0 opacity-0 transition-opacity group-hover/path:pointer-events-auto group-hover/path:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
        className,
      )}
      tooltip={copied ? "Copied" : "Copy file path"}
      ariaLabel={copied ? `Copied ${path}` : `Copy ${path}`}
      onClick={() => {
        void navigator.clipboard.writeText(path).then(() => setCopied(true));
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
}
