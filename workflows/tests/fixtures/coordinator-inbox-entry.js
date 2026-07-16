#!/usr/bin/env node

import fs from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
      const javascriptPath = fileURLToPath(new URL(specifier, context.parentURL));
      const typeScriptPath = `${javascriptPath.slice(0, -3)}.ts`;
      if (!fs.existsSync(javascriptPath) && fs.existsSync(typeScriptPath)) {
        return nextResolve(pathToFileURL(typeScriptPath).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--run-dir") throw new Error("Missing run directory");
const { RunCoordinator } = await import("../../src/runtime/run-coordinator.ts");
const abort = new AbortController();
process.once("SIGTERM", () => abort.abort());
process.once("SIGINT", () => abort.abort());
await new RunCoordinator(args[1]).run(abort.signal);
