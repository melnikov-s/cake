import { useId, useState, type FormEvent } from "react";
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
  "w-full rounded-md border border-border bg-background text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

function describeAnswer(field: ArtifactFormField, value: ArtifactFormValue | undefined): string {
  if (field.type === "checkbox") return value ? "Yes" : "No";
  const text = String(value ?? "");
  if (!text) return "—";
  if (field.type === "select")
    return field.options?.find((option) => option.value === text)?.label ?? text;
  return text;
}

/** Shared answer form for form artifacts and form-view request artifacts.
 *  Select fields render every option as a radio row, the actions are the
 *  static Skip/Submit pair, and a submitted form is replaced by a summary of
 *  the submitted answers. */
export function ArtifactForm({
  fields,
  requested,
  onSubmit,
  onSkip,
}: {
  fields: ArtifactFormField[];
  requested: boolean;
  onSubmit?: (value: JsonValue) => void;
  onSkip?: () => void;
}) {
  const [values, setValues] = useState<Record<string, ArtifactFormValue>>({});
  const [answers, setAnswers] = useState<Record<string, ArtifactFormValue> | null>(null);
  const group = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAnswers({ ...values });
    onSubmit?.(values);
  };
  if (answers)
    return (
      <div aria-label="Submitted answers" className="grid gap-2" role="status">
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <CheckIcon />
          Submitted
        </p>
        <dl className="grid gap-1 text-sm">
          {fields.map((field) => (
            <div key={field.id} className="flex gap-2">
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="font-medium text-foreground">
                {describeAnswer(field, answers[field.id])}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    );
  return (
    <form className="grid gap-3" onSubmit={submit}>
      {fields.map((field) =>
        field.type === "checkbox" ? (
          <label key={field.id} className="flex items-center gap-2.5 text-sm text-foreground">
            <input
              type="checkbox"
              className="accent-primary"
              checked={Boolean(values[field.id])}
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
                value={String(values[field.id] ?? "")}
                onChange={(event) => setValues({ ...values, [field.id]: event.target.value })}
              />
            ) : field.type === "select" ? (
              <div aria-label={field.label} className="grid gap-1" role="radiogroup">
                {field.options?.map((option) => (
                  <label
                    key={option.value}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-sm text-foreground hover:bg-muted",
                      values[field.id] === option.value ? "border-ring bg-muted" : "border-border",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${group}-${field.id}`}
                      className="accent-primary"
                      value={option.value}
                      checked={values[field.id] === option.value}
                      onChange={() => setValues({ ...values, [field.id]: option.value })}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            ) : (
              <input
                id={`${group}-${field.id}`}
                type={field.type}
                className={cn(inputClassName, "h-9 px-2.5")}
                placeholder={field.placeholder}
                value={String(values[field.id] ?? "")}
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
      <div className="flex justify-end gap-2">
        {requested && (
          <Button variant="outline" onClick={onSkip}>
            Skip
          </Button>
        )}
        <Button type="submit">Submit</Button>
      </div>
    </form>
  );
}
