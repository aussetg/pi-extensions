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

try {
  const { agentWorkerMain } = await import("./sdk-worker.ts");
  process.exitCode = await agentWorkerMain(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${Array.from(message).slice(0, 4_096).join("")}\n`);
  process.exitCode = 1;
}
