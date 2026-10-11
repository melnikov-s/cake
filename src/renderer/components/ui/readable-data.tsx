import { useState } from "react";
import { Predicate } from "effect";
import type { JsonValue } from "../../../ipc/json-contract";
import { AttachmentTile } from "./attachment-tile";
import { DisclosureTrigger } from "./disclosure-trigger";
import {
  structuredDataFields,
  structuredDataImage,
  structuredDataText,
} from "../../lib/structured-data";

/** Literal readable data, not Markdown or raw serialization. Only document sections fold;
 * values are complete, arrays retain order, and remote image references are never fetched. */
export function ReadableData({
  value,
  title,
  defaultOpen = true,
}: {
  value: JsonValue;
  title?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const image = structuredDataImage(value);
  const fields = structuredDataFields(value);
  const text = fields?.find(([key]) => key === "text")?.[1];
  const textBlock =
    fields &&
    !Array.isArray(value) &&
    Predicate.isString(text) &&
    fields.every(
      ([key, child]) =>
        key === "text" ||
        (key === "type" && ["text", "input_text", "output_text"].includes(String(child))),
    );
  const visibleFields = image ? imageMetadata(fields ?? []) : fields;
  const content = (
    <div className="space-y-3 text-sm leading-relaxed [overflow-wrap:anywhere]">
      {image && <AttachmentTile name="Context image" imageSrc={image} />}
      {textBlock && Predicate.isString(text) ? (
        <p className="whitespace-pre-wrap">{text}</p>
      ) : Array.isArray(value) ? (
        value.length ? (
          value.map((child, index) => <ReadableData key={index} value={child} />)
        ) : (
          <p>None</p>
        )
      ) : visibleFields ? (
        visibleFields.length ? (
          <dl className="space-y-3">
            {visibleFields.map(([key, child]) => (
              <div key={key}>
                <dt className="mb-1 font-medium">{key}</dt>
                <dd className="pl-3">
                  <ReadableData value={child} />
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          !image && <p>None</p>
        )
      ) : (
        !image && <p className="whitespace-pre-wrap">{structuredDataText(value)}</p>
      )}
    </div>
  );
  if (!title) return content;
  return (
    <section className="space-y-3" data-slot="readable-data">
      <DisclosureTrigger
        className="text-sm font-semibold"
        title={title}
        open={open}
        onClick={() => setOpen(!open)}
      />
      {open && content}
    </section>
  );
}

/** Images represent the full encoded bytes; retain every other field as readable metadata. */
function imageMetadata(fields: ReadonlyArray<readonly [string, JsonValue]>) {
  return fields
    .filter(([key]) => key !== "data")
    .map(([key, child]) => {
      if (key !== "source") return [key, child] as const;
      const source = structuredDataFields(child);
      if (!source) return [key, child] as const;
      return [
        key,
        Object.fromEntries(
          source.map(([name, value]) => {
            if (name !== "bytes") return [name, value];
            const bytes = structuredDataFields(value);
            return [
              name,
              bytes ? Object.fromEntries(bytes.filter(([field]) => field !== "data")) : value,
            ];
          }),
        ),
      ] as const;
    });
}
