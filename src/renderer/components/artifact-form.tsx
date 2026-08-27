import { useId, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { CheckIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { JsonValue } from "../../ipc/json-contract";

export interface ArtifactFormField {
  id: string;
  label: string;
  type: "text" | "textarea" | "number" | "checkbox" | "select";
  placeholder?: string;
  options?: { value: string; label: string }[];
}

type ArtifactFormValue = string | number | boolean;

const inputClassName =
  "w-full rounded-md border border-border bg-background text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const radioRowClassName = cn(
  "flex items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-sm text-foreground hover:bg-muted",
  "has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-inset has-[input:focus-visible]:ring-ring",
);

const answersSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

function answersRecord(value: JsonValue | undefined): Record<string, ArtifactFormValue> | null {
  const parsed = answersSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Shared answer form for form artifacts and form-view request artifacts.
 *  Select fields render every option as a radio row plus a deterministic
 *  "Other" row with a free-text input, the actions are the static Skip/Submit
 *  pair, and once an answer has been submitted the form stays visible but
 *  disabled with the submitted values so it cannot be submitted again. */
export function ArtifactForm({
  fields,
  requested,
  submittedAnswer,
  onSubmit,
  onSkip,
}: {
  fields: ArtifactFormField[];
  requested: boolean;
  submittedAnswer?: JsonValue;
  onSubmit?: (value: JsonValue) => void;
  onSkip?: () => void;
}) {
  const [values, setValues] = useState<Record<string, ArtifactFormValue>>({});
  const [localAnswers, setLocalAnswers] = useState<Record<string, ArtifactFormValue> | null>(null);
  const [customRows, setCustomRows] = useState<ReadonlySet<string>>(new Set());
  const otherInputs = useRef(new Map<string, HTMLInputElement>());
  const group = useId();
  const answers = answersRecord(submittedAnswer) ?? localAnswers;
  const submitted = answers !== null;
  const shown = answers ?? values;
  const isCustomRow = (field: ArtifactFormField) => {
    if (customRows.has(field.id)) return true;
    const text = String(shown[field.id] ?? "");
    return text !== "" && !field.options?.some((option) => option.value === text);
  };
  const selectCustomRow = (field: ArtifactFormField) => {
    setCustomRows((rows) => (rows.has(field.id) ? rows : new Set(rows).add(field.id)));
    setValues((current) =>
      field.options?.some((option) => option.value === current[field.id])
        ? { ...current, [field.id]: "" }
        : current,
    );
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (submitted) return;
    setLocalAnswers({ ...values });
    onSubmit?.(values);
  };
  return (
    <form className="grid gap-3" onSubmit={submit}>
      {submitted && (
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground" role="status">
          <CheckIcon />
          Submitted
        </p>
      )}
      {fields.map((field) =>
        field.type === "checkbox" ? (
          <label key={field.id} className="flex items-center gap-2.5 text-sm text-foreground">
            <input
              type="checkbox"
              className="accent-primary"
              disabled={submitted}
              checked={Boolean(shown[field.id])}
              onChange={(event) => setValues({ ...values, [field.id]: event.target.checked })}
            />
            {field.label}
          </label>
        ) : (
          <div key={field.id} className="grid gap-1.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor={`${group}-${field.id}`}
            >
              {field.label}
            </label>
            {field.type === "textarea" ? (
              <textarea
                id={`${group}-${field.id}`}
                className={cn(inputClassName, "min-h-28 resize-y py-2")}
                placeholder={field.placeholder}
                disabled={submitted}
                value={String(shown[field.id] ?? "")}
                onChange={(event) => setValues({ ...values, [field.id]: event.target.value })}
              />
            ) : field.type === "select" ? (
              <div aria-label={field.label} className="grid gap-1" role="radiogroup">
                {field.options?.map((option) => (
                  <label
                    key={option.value}
                    className={cn(
                      radioRowClassName,
                      "cursor-pointer",
                      shown[field.id] === option.value ? "border-ring bg-muted" : "border-border",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${group}-${field.id}`}
                      className="accent-primary outline-none"
                      value={option.value}
                      disabled={submitted}
                      checked={shown[field.id] === option.value}
                      onChange={() => {
                        setCustomRows((rows) => {
                          if (!rows.has(field.id)) return rows;
                          const next = new Set(rows);
                          next.delete(field.id);
                          return next;
                        });
                        setValues({ ...values, [field.id]: option.value });
                      }}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
                <div
                  className={cn(
                    radioRowClassName,
                    isCustomRow(field) ? "border-ring bg-muted" : "border-border",
                  )}
                >
                  <input
                    type="radio"
                    name={`${group}-${field.id}`}
                    className="accent-primary outline-none"
                    aria-label="Other"
                    disabled={submitted}
                    checked={isCustomRow(field)}
                    onChange={() => {
                      selectCustomRow(field);
                      otherInputs.current.get(field.id)?.focus();
                    }}
                  />
                  <input
                    type="text"
                    aria-label={`${field.label} other option`}
                    placeholder="Other…"
                    className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                    disabled={submitted}
                    value={isCustomRow(field) ? String(shown[field.id] ?? "") : ""}
                    onFocus={() => selectCustomRow(field)}
                    onChange={(event) => {
                      selectCustomRow(field);
                      setValues((current) => ({ ...current, [field.id]: event.target.value }));
                    }}
                    ref={(element) => {
                      if (element) otherInputs.current.set(field.id, element);
                      else otherInputs.current.delete(field.id);
                    }}
                  />
                </div>
              </div>
            ) : (
              <input
                id={`${group}-${field.id}`}
                type={field.type}
                className={cn(inputClassName, "h-9 px-2.5")}
                placeholder={field.placeholder}
                disabled={submitted}
                value={String(shown[field.id] ?? "")}
                onChange={(event) =>
                  setValues({
                    ...values,
                    [field.id]:
                      field.type === "number" ? event.target.valueAsNumber : event.target.value,
                  })
                }
              />
            )}
          </div>
        ),
      )}
      {!submitted && (
        <div className="flex justify-end gap-2">
          {requested && (
            <Button variant="outline" onClick={onSkip}>
              Skip
            </Button>
          )}
          <Button type="submit">Submit</Button>
        </div>
      )}
    </form>
  );
}
