import { Option, Schema } from "effect";
import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { observer } from "r-state-tree/react";
import type { InterviewStore } from "../stores/InterviewStore";
import type { InterviewField } from "../../contracts/interviews/interview";
import { listedOptions, type InterviewFormValue } from "../lib/interview-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CheckIcon } from "@/components/ui/icons";
import { StepProgress } from "@/components/ui/step-progress";
import { cn } from "@/lib/utils";
import type { JsonValue } from "../../ipc/json-contract";

const inputClassName =
  "w-full rounded-md border border-border bg-background text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const radioRowClassName = cn(
  "flex items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-sm text-foreground hover:bg-muted",
  "has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-inset has-[input:focus-visible]:ring-ring",
);

const answersSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
);

function answersRecord(value: JsonValue | undefined): Record<string, InterviewFormValue> | null {
  const parsed = Schema.decodeUnknownOption(answersSchema)(value);
  return Option.isSome(parsed) ? { ...parsed.value } : null;
}

function answerText(field: InterviewField, value: InterviewFormValue | undefined) {
  if (field.type === "checkbox") return value ? "Yes" : "No";
  if (value === undefined || value === "" || Number.isNaN(value)) return undefined;
  if (field.type === "select")
    return listedOptions(field)?.find((option) => option.value === value)?.label ?? String(value);
  return String(value);
}

/** The session-owned interview's stepped form.
 *  Select fields render listed options as radio rows plus one deterministic
 *  freeform "Other" row (discarding a redundant listed Other option).
 *  Multi-question forms step through one question at a time with Back/Next
 *  navigation and end on a review page, the only step that submits (the
 *  progress bar can jump there early); Skip is available on every step and
 *  nothing is sent until the user submits. Once an answer
 *  has been submitted the form shows every question disabled with the
 *  submitted values so it cannot be submitted again. Prose answers, including
 *  Other, use the shared dictation field; numeric choices stay keyboard-only. */
export const InterviewForm = observer(function InterviewForm({ store }: { store: InterviewStore }) {
  const view = store.record.request.view;
  const fields = view.type === "form" ? view.fields : [];
  const { values, customRows, step, requested } = store;
  const navigated = useRef(false);
  const stepContent = useRef<HTMLDivElement>(null);
  const otherInputs = useRef(new Map<string, HTMLTextAreaElement>());
  const group = useId();
  const answers = answersRecord(store.result?.value);
  const submitted = store.submitted;
  const disabled = submitted || store.responding;
  const shown = answers ?? values;
  const stepped = !submitted && fields.length > 1;
  const reviewing = stepped && step >= fields.length;
  const visibleFields = !stepped ? fields : reviewing ? [] : fields.slice(step, step + 1);
  const answered = (field: InterviewField) =>
    field.type === "checkbox"
      ? shown[field.id] !== undefined
      : answerText(field, shown[field.id]) !== undefined;
  const goTo = (next: number) => {
    navigated.current = true;
    store.goTo(next);
  };
  useEffect(() => {
    // Keep keyboard flow on the new question, but never steal focus on mount.
    if (!navigated.current) return;
    stepContent.current
      ?.querySelector<HTMLElement>(
        "input:checked, input:not([type=radio]), textarea, [data-step-focus]",
      )
      ?.focus();
  }, [step]);
  const isCustomRow = (field: InterviewField) => {
    if (customRows.has(field.id)) return true;
    const text = String(shown[field.id] ?? "");
    return text !== "" && !listedOptions(field)?.some((option) => option.value === text);
  };
  const selectCustomRow = (field: InterviewField) => {
    store.selectCustomRow(field);
  };
  const submitAll = () => {
    if (disabled) return;
    void store.respond({ ...values });
  };
  const advanceFromText = (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    advance();
  };
  const advance = () => {
    if (disabled) return;
    if (stepped && !reviewing) goTo(step + 1);
    else submitAll();
  };
  // Live-request fallback can be inside the chat composer's native form. Own
  // navigation explicitly rather than nesting forms or submitting that composer.
  return (
    <div className="grid gap-3" role="form" aria-label={store.record.request.title}>
      {submitted && (
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground" role="status">
          <CheckIcon />
          Submitted
        </p>
      )}
      {stepped && (
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span aria-live="polite">
              {reviewing ? "Review answers" : `Question ${step + 1} of ${fields.length}`}
            </span>
            <span>
              {fields.filter(answered).length} of {fields.length} answered
            </span>
          </div>
          <StepProgress
            count={fields.length + 1}
            current={step}
            completed={(index) => index < fields.length && answered(fields[index]!)}
            label="Questions"
            stepLabel={(index) =>
              index === fields.length
                ? "Review answers"
                : `Question ${index + 1}: ${fields[index]!.label}`
            }
            onSelect={goTo}
          />
        </div>
      )}
      <div ref={stepContent} className="grid gap-3">
        {reviewing && (
          <dl className="grid gap-1.5" aria-label="Answers">
            {fields.map((field, index) => {
              const text = answerText(field, shown[field.id]);
              return (
                <div
                  key={field.id}
                  className="flex items-start gap-3 rounded-md border border-border px-3 py-2"
                >
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <dt className="text-xs font-medium text-muted-foreground">{field.label}</dt>
                    <dd
                      className={cn(
                        "text-sm break-words whitespace-pre-wrap",
                        text === undefined ? "text-muted-foreground italic" : "text-foreground",
                      )}
                    >
                      {text ?? "No answer"}
                    </dd>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Edit ${field.label}`}
                    onClick={() => goTo(index)}
                  >
                    Edit
                  </Button>
                </div>
              );
            })}
          </dl>
        )}
        {visibleFields.map((field) =>
          field.type === "checkbox" ? (
            <label key={field.id} className="flex items-center gap-2.5 text-sm text-foreground">
              <Input
                type="checkbox"
                className="h-auto w-auto rounded-none border-0 p-0 accent-primary"
                disabled={disabled}
                checked={Boolean(shown[field.id])}
                onChange={(event) => store.setValue(field.id, event.target.checked)}
                onKeyDown={advanceFromText}
              />
              {field.label}
            </label>
          ) : (
            <div key={field.id} className="grid gap-1.5">
              <label
                className={cn(
                  "font-medium",
                  stepped ? "text-sm text-foreground" : "text-xs text-muted-foreground",
                )}
                htmlFor={`${group}-${field.id}`}
              >
                {field.label}
              </label>
              {field.type === "textarea" ? (
                <Textarea
                  dictation
                  id={`${group}-${field.id}`}
                  className={cn(inputClassName, "min-h-28 resize-y py-2")}
                  placeholder={field.placeholder}
                  disabled={disabled}
                  value={String(shown[field.id] ?? "")}
                  onChange={(event) => store.setValue(field.id, event.target.value)}
                />
              ) : field.type === "select" ? (
                <div aria-label={field.label} className="grid gap-1" role="radiogroup">
                  {listedOptions(field)?.map((option) => (
                    <label
                      key={option.value}
                      className={cn(
                        radioRowClassName,
                        "cursor-pointer",
                        shown[field.id] === option.value ? "border-ring bg-muted" : "border-border",
                      )}
                    >
                      <Input
                        type="radio"
                        name={`${group}-${field.id}`}
                        className="h-auto w-auto rounded-none border-0 p-0 accent-primary outline-none"
                        value={option.value}
                        onKeyDown={advanceFromText}
                        disabled={disabled}
                        checked={shown[field.id] === option.value}
                        onChange={() => {
                          store.selectOption(field, option.value);
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
                    <Input
                      type="radio"
                      name={`${group}-${field.id}`}
                      className="h-auto w-auto rounded-none border-0 p-0 accent-primary outline-none"
                      aria-label="Other"
                      onKeyDown={advanceFromText}
                      disabled={disabled}
                      checked={isCustomRow(field)}
                      onChange={() => {
                        selectCustomRow(field);
                        otherInputs.current.get(field.id)?.focus();
                      }}
                    />
                    <Textarea
                      dictation
                      rows={1}
                      aria-label={`${field.label} other option`}
                      placeholder="Other…"
                      className="min-h-9 resize-none border-0 bg-transparent text-sm"
                      disabled={disabled}
                      value={isCustomRow(field) ? String(shown[field.id] ?? "") : ""}
                      onFocus={() => selectCustomRow(field)}
                      onChange={(event) => {
                        selectCustomRow(field);
                        const value = event.target.value;
                        store.setValue(field.id, value);
                      }}
                      onKeyDown={advanceFromText}
                      ref={(element) => {
                        if (element) otherInputs.current.set(field.id, element);
                        else otherInputs.current.delete(field.id);
                      }}
                    />
                  </div>
                </div>
              ) : field.type === "text" ? (
                <Textarea
                  dictation
                  rows={1}
                  id={`${group}-${field.id}`}
                  className={cn(inputClassName, "min-h-9 resize-none px-2.5")}
                  placeholder={field.placeholder}
                  disabled={disabled}
                  value={String(shown[field.id] ?? "")}
                  onChange={(event) => store.setValue(field.id, event.target.value)}
                  onKeyDown={advanceFromText}
                />
              ) : (
                <Input
                  id={`${group}-${field.id}`}
                  type="number"
                  className={cn(inputClassName, "h-9 px-2.5")}
                  placeholder={field.placeholder}
                  disabled={disabled}
                  value={String(shown[field.id] ?? "")}
                  onChange={(event) => store.setValue(field.id, event.target.valueAsNumber)}
                  onKeyDown={advanceFromText}
                />
              )}
            </div>
          ),
        )}
        {!submitted && (
          <div
            className={cn("flex items-center gap-2", stepped ? "justify-between" : "justify-end")}
          >
            {stepped && (
              <Button variant="outline" disabled={step === 0} onClick={() => goTo(step - 1)}>
                Back
              </Button>
            )}
            <div className="flex gap-2">
              {requested && (
                <Button
                  variant="outline"
                  disabled={store.responding}
                  onClick={() => void store.respond(undefined, true)}
                >
                  Skip
                </Button>
              )}
              <Button onClick={advance} disabled={store.responding} data-step-focus>
                {!stepped || reviewing ? "Submit" : step === fields.length - 1 ? "Review" : "Next"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
