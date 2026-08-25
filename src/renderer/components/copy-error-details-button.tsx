import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyErrorDetailsButton({ details }: { details: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  };

  const label =
    status === "copied"
      ? "Copied full error details"
      : status === "failed"
        ? "Copy failed"
        : "Copy full error details";
  return (
    <Button
      className="copy-error-details mt-0.5 w-fit"
      variant="outline"
      size="sm"
      onClick={() => void copy()}
    >
      {label}
    </Button>
  );
}
