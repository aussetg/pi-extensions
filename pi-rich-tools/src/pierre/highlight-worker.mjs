import { buildPiHighlightedDiffInWorker } from "./highlight.ts";

let queue = Promise.resolve();

process.on("message", (message) => {
  queue = queue.then(
    () => handleRequest(message),
    () => handleRequest(message),
  );
});

process.on("disconnect", () => process.exit(0));

async function handleRequest(message) {
  const id = message && typeof message === "object" ? message.id : undefined;
  if (typeof id !== "number") return;

  try {
    const highlighted = await buildPiHighlightedDiffInWorker(
      message.metadata,
      message.config,
    );
    process.send?.({ id, highlighted });
  } catch (error) {
    process.send?.({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
