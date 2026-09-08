export function DesktopBridgeError() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-8" role="alert">
      <section className="max-w-lg rounded-2xl border border-border bg-card p-8 shadow-2xl">
        <h1 className="text-2xl font-bold text-foreground">Cake could not start</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Cake&apos;s desktop bridge did not load. Restart the app and inspect the preload
          diagnostics.
        </p>
      </section>
    </main>
  );
}
