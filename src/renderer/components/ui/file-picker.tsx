import { useRef } from "react";
import { Button } from "./button";

/** Native, user-selected file data only; folder paths are relative to the selected source. */
export function FilePicker({
  children,
  directory = false,
  disabled,
  onFiles,
}: {
  children: string;
  directory?: boolean;
  disabled?: boolean;
  onFiles(files: readonly File[]): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {children}
      </Button>
      <input
        ref={input}
        type="file"
        className="hidden"
        aria-label={children}
        accept=".json,.jsonc"
        multiple
        {...(directory ? { webkitdirectory: "" } : {})}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}
