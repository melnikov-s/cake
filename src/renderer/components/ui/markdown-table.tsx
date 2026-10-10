import type { ComponentProps, ReactNode } from "react";
import { TableCopyDropdown } from "streamdown";
import { cn } from "@/lib/utils";
import { FullscreenButton } from "./fullscreen-button";

/** Presents parsed Markdown cells without owning fullscreen state or reparsing their content. */
export function MarkdownTable({
  children,
  className,
  onFullscreen,
  ...props
}: ComponentProps<"table"> & { onFullscreen?(table: ReactNode): void }) {
  return (
    <div className="group/table relative my-4 flex flex-col gap-2" data-streamdown="table-wrapper">
      <div className="flex items-center justify-end gap-1">
        <TableCopyDropdown />
        {onFullscreen && (
          <FullscreenButton
            className="opacity-0 transition-opacity group-hover/table:opacity-100 group-focus-within/table:opacity-100"
            label="View table fullscreen"
            onClick={() =>
              onFullscreen(
                <MarkdownTable {...props} className={className}>
                  {children}
                </MarkdownTable>,
              )
            }
          />
        )}
      </div>
      <div className="overflow-auto rounded-md border border-border bg-background">
        <table
          {...props}
          className={cn(
            "w-full divide-y divide-border [&_thead]:sticky [&_thead]:top-0",
            className,
          )}
          data-streamdown="table"
        >
          {children}
        </table>
      </div>
    </div>
  );
}
