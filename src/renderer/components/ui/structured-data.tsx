import { useState } from "react";
import { DisclosureTrigger } from "./disclosure-trigger";
import { AttachmentTile } from "./attachment-tile";
import type { JsonValue } from "../../../ipc/json-contract";
import {
  structuredDataFields,
  structuredDataImage,
  structuredDataText,
} from "../../lib/structured-data";

/** Lossless, lazy disclosure of JSON-like data. Search matches complete values (including
 * collapsed content); remote URLs are never fetched. Embedded raster images can be previewed.
 * Strings are rendered literally, not as Markdown or HTML. No truncation or syntax rewriting. */
export function StructuredData({
  value,
  label = "Payload",
  query = "",
  showEmpty = false,
}: {
  value: JsonValue;
  label?: string;
  query?: string;
  showEmpty?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const serialized = JSON.stringify(value) ?? String(value);
  const needle = query.toLocaleLowerCase();
  if (needle && !`${label} ${serialized}`.toLocaleLowerCase().includes(needle))
    return showEmpty ? (
      <p className="py-3 text-xs text-muted-foreground">
        No matching fields. Search covers the complete captured payload.
      </p>
    ) : null;
  const children = structuredDataFields(value);
  const open = expanded || Boolean(needle);
  const image = structuredDataImage(value);
  return (
    <div className="min-w-0 border-l border-border pl-3 py-1" data-slot="structured-data">
      <DisclosureTrigger
        title={label}
        subtitle={
          children
            ? `${children.length} fields`
            : `${serialized.length.toLocaleString()} characters`
        }
        open={open}
        onClick={() => setExpanded(!expanded)}
      />
      {image && <AttachmentTile name={label} imageSrc={image} />}
      {open &&
        (children ? (
          children.length ? (
            children.map(([key, child]) => (
              <StructuredData
                key={key}
                label={Array.isArray(value) ? `[${key}]` : key}
                value={child}
                query={needle && !label.toLocaleLowerCase().includes(needle) ? query : ""}
              />
            ))
          ) : (
            <p className="py-2 font-mono text-xs">{serialized}</p>
          )
        ) : (
          <p className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-all py-2 font-mono text-xs leading-relaxed">
            {structuredDataText(value)}
          </p>
        ))}
    </div>
  );
}
