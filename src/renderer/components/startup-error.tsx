import { describeError } from "../lib/error-details";
import { ErrorNotice } from "./error-notice";
import { Button } from "./ui/button";
import { FatalErrorSurface } from "./ui/fatal-error-surface";

export function StartupError({ error }: { error: unknown }) {
  const described = describeError(error, "Starting Cake");
  return (
    <FatalErrorSurface>
      <main className="grid min-h-screen place-items-center overflow-auto bg-background p-8">
        <section className="grid w-full max-w-lg gap-4">
          <h1 className="text-2xl font-bold text-foreground">Cake could not start</h1>
          <ErrorNotice title="Startup failed" {...described} />
          <Button onClick={() => window.location.reload()}>Reload Cake</Button>
        </section>
      </main>
    </FatalErrorSurface>
  );
}
