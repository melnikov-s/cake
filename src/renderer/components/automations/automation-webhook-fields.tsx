import { useEffect, useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import type { AutomationId } from "../../../contracts/automations/automation-data";
import type {
  GitHubWebhookFilter,
  GitHubWebhookPreview,
  GitHubWebhookStatus,
} from "../../../contracts/automations/github-webhooks";
import { RootStore } from "../../stores/RootStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Callout } from "../ui/callout";

const actions = ["submitted", "edited", "dismissed"] as const;
const fields = [
  { value: "title", label: "PR title" },
  { value: "reviewer", label: "Reviewer login" },
  { value: "state", label: "Review state" },
  { value: "body", label: "Review comment (up to 2,048 characters)" },
] as const;

export const AutomationWebhookFields = observer(function AutomationWebhookFields({
  filter,
}: {
  filter: GitHubWebhookFilter;
}) {
  const editor = useStore(RootStore).automationsStore.editor;
  const saved =
    editor.automation?.definition.trigger._tag === "Webhook" ? editor.automation : undefined;
  const update = (patch: Partial<GitHubWebhookFilter>) =>
    editor.patch({ trigger: { _tag: "Webhook", filter: { ...filter, ...patch } } });
  return (
    <div className="grid min-w-0 gap-3 text-xs">
      <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3">
        <span className="text-muted-foreground">Repository</span>
        <Input
          value={filter.repository}
          placeholder="owner/repository"
          maxLength={256}
          onChange={(event) => update({ repository: event.currentTarget.value.trim() })}
        />
      </label>
      <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3">
        <span className="text-muted-foreground">Event</span>
        <Select
          value={filter.action}
          onChange={(event) => {
            const action = actions.find((action) => action === event.currentTarget.value);
            if (action) update({ action });
          }}
        >
          {actions.map((action) => (
            <option key={action} value={action}>
              Pull request review {action}
            </option>
          ))}
        </Select>
      </label>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
        <legend className="mb-2 text-muted-foreground">Include in report input</legend>
        {fields.map(({ value, label }) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={filter.fields.includes(value)}
              onChange={(event) =>
                update({
                  fields: event.currentTarget.checked
                    ? [...filter.fields, value]
                    : filter.fields.filter((field) => field !== value),
                })
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      <p className="text-muted-foreground">
        Reports use the saved task and model without tools, project files, or extensions.
      </p>
      {saved ? (
        <WebhookSetup key={saved.id} automationId={saved.id} />
      ) : (
        <p className="text-muted-foreground">
          Save paused to set up delivery and preview a payload.
        </p>
      )}
    </div>
  );
});

function WebhookSetup({ automationId }: { automationId: AutomationId }) {
  const editor = useStore(RootStore).automationsStore.editor;
  const [status, setStatus] = useState<GitHubWebhookStatus>();
  const [secret, setSecret] = useState<string>();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [event, setEvent] = useState("pull_request_review");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<GitHubWebhookPreview>();
  useEffect(() => {
    const request = new AbortController();
    void editor.webhookStatus(automationId, request.signal).then(setStatus, () => {
      if (!request.signal.aborted) setError("Could not read webhook setup.");
    });
    return () => request.abort();
  }, [automationId, editor]);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch {
      setError("Webhook operation failed. Refresh status before trying again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-3 border-l border-border/65 pl-4" aria-label="GitHub webhook setup">
      {status?.endpoint ? (
        <>
          <label className="grid gap-1 text-muted-foreground">
            Local forwarding target
            <Input readOnly value={status.endpoint} className="font-mono" />
          </label>
          <p className="text-muted-foreground">
            Set GitHub’s payload URL to your HTTPS proxy or tunnel for this target. Use
            application/json. Cake must be online.
          </p>
        </>
      ) : (
        status && (
          <p className="text-muted-foreground">
            Ingress is off. Launch the backend with CAKE_GITHUB_WEBHOOK_PORT to receive deliveries.
          </p>
        )
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || !status}
          onClick={() =>
            void perform(async () => {
              const result = await editor.rotateWebhookSecret(automationId);
              setSecret(result.secret);
              setVisible(false);
              setStatus(await editor.webhookStatus(automationId));
            })
          }
        >
          {status?.hasSecret ? "Rotate secret" : "Generate secret"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() =>
            void perform(async () => setStatus(await editor.webhookStatus(automationId)))
          }
        >
          Refresh status
        </Button>
      </div>
      {secret && (
        <div className="grid gap-2">
          <label className="grid gap-1 text-muted-foreground">
            New GitHub secret (shown here once)
            <Input
              type={visible ? "text" : "password"}
              autoComplete="off"
              readOnly
              value={secret}
              className="font-mono"
            />
          </label>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setVisible(!visible)}>
              {visible ? "Hide" : "Show"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSecret(undefined)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {status?.lastNote && (
        <p className="text-muted-foreground" role="status">
          Latest ignored or duplicate delivery: {status.lastNote.outcome} ·{" "}
          {new Date(status.lastNote.at).toLocaleString()} · {status.lastNote.reason}
        </p>
      )}
      <details className="grid gap-2">
        <summary className="cursor-pointer font-medium">Preview a test delivery</summary>
        <div className="mt-3 grid gap-2">
          <p className="text-muted-foreground">
            Paste a GitHub delivery to check the saved filter and fields. This does not send a
            request or launch a run.
          </p>
          <label className="grid gap-1 text-muted-foreground">
            GitHub event header
            <Input
              value={event}
              maxLength={64}
              onChange={(input) => {
                setEvent(input.currentTarget.value);
                setPreview(undefined);
              }}
            />
          </label>
          <textarea
            aria-label="Test payload JSON"
            placeholder="Paste request body JSON"
            rows={5}
            maxLength={1024 * 1024}
            className="rounded-md border border-border bg-background p-2 font-mono"
            value={body}
            onChange={(event) => {
              setBody(event.currentTarget.value);
              setPreview(undefined);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={busy || !body || !/^[a-z_]{1,64}$/.test(event)}
            onClick={() =>
              void perform(async () =>
                setPreview(await editor.previewWebhook(automationId, event, body)),
              )
            }
          >
            Preview saved filter
          </Button>
          {preview && (
            <div role="status">
              {preview._tag === "match" ? (
                <>
                  Matches saved filter
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-muted-foreground">
                    {JSON.stringify(preview.fields, null, 2)}
                  </pre>
                </>
              ) : (
                preview.reason
              )}
            </div>
          )}
        </div>
      </details>
      {error && (
        <Callout variant="error" role="alert">
          {error}
        </Callout>
      )}
    </div>
  );
}
