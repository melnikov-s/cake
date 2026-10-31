import { describeError } from "../lib/error-details";
import { ErrorNotice } from "./error-notice";
import { Button } from "./ui/button";
import { FatalErrorSurface } from "./ui/fatal-error-surface";

export function StartupError({ error }: { error: unknown }) {
  const described = describeError(error, "Starting Cake");
  return (
    <FatalErrorSurface>
      <main className="grid min-h-screen place-items-center overflow-auto bg-background p-6">
        <section className="grid w-full max-w-lg gap-4 rounded-xl border border-border/80 bg-card p-6 shadow-xl">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Cake could not start
          </h1>
          <ErrorNotice title="Startup failed" {...described} />
          <div className="flex justify-end">
            <Button size="sm" onClick={() => window.location.reload()}>
              Reload Cake
            </Button>
          </div>
        </section>
      </main>
    </FatalErrorSurface>
  );
}
