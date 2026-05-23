#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const separatorIndex = process.argv.indexOf("--", 2);
const logPath = process.argv[2];
const command = separatorIndex >= 0 ? process.argv[separatorIndex + 1] : undefined;
const commandArgs = separatorIndex >= 0 ? process.argv.slice(separatorIndex + 2) : [];

if (!logPath || !command) {
  process.stderr.write("usage: lsp-stdio-proxy.mjs LOG_PATH -- COMMAND [ARGS...]\n");
  process.exit(2);
}

const child = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"] });

observeAndForward(process.stdin, child.stdin, "client-to-server");
observeAndForward(child.stdout, process.stdout, "server-to-client");

child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("error", (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

process.on("SIGTERM", () => exitAfterKillingChild("SIGTERM"));
process.on("SIGINT", () => exitAfterKillingChild("SIGINT"));

function exitAfterKillingChild(signal) {
  child.kill(signal);
  setTimeout(() => process.exit(1), 100).unref();
}

function observeAndForward(readable, writable, direction) {
  let buffer = Buffer.alloc(0);

  readable.on("data", (chunk) => {
    if (writable.writable) writable.write(chunk);
    buffer = Buffer.concat([buffer, chunk]);
    buffer = drainObservedMessages(buffer, direction);
  });

  readable.on("end", () => {
    if (writable.writable) writable.end();
  });
}

function drainObservedMessages(buffer, direction) {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return buffer;

    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) return buffer.subarray(headerEnd + 4);

    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return buffer;

    observeMessage(direction, buffer.subarray(bodyStart, bodyEnd));
    buffer = buffer.subarray(bodyEnd);
  }
}

function observeMessage(direction, body) {
  try {
    const message = JSON.parse(body.toString("utf8"));
    appendFileSync(logPath, `${JSON.stringify(summarizeMessage(direction, body.length, message))}\n`, "utf8");
  } catch {
    appendFileSync(logPath, `${JSON.stringify({ direction, bodyBytes: body.length, parseError: true })}\n`, "utf8");
  }
}

function summarizeMessage(direction, bodyBytes, message) {
  const params = isRecord(message.params) ? message.params : undefined;
  const textDocument = isRecord(params?.textDocument) ? params.textDocument : undefined;
  const contentChanges = Array.isArray(params?.contentChanges) ? params.contentChanges : [];

  return pruneUndefined({
    at: Date.now(),
    direction,
    bodyBytes,
    id: typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined,
    method: typeof message.method === "string" ? message.method : undefined,
    uri: typeof textDocument?.uri === "string" ? textDocument.uri : undefined,
    version: typeof textDocument?.version === "number" ? textDocument.version : undefined,
    paramsTextBytes: textBytes(params?.text),
    textDocumentTextBytes: textBytes(textDocument?.text),
    contentChangeCount: contentChanges.length,
    contentChangeTextBytes: sum(contentChanges.map((change) => textBytes(isRecord(change) ? change.text : undefined) ?? 0)),
    contentChangeRangeCount: contentChanges.filter((change) => isRecord(change) && isRecord(change.range)).length,
    contentChangeFullTextCount: contentChanges.filter((change) => isRecord(change) && !isRecord(change.range) && typeof change.text === "string").length,
  });
}

function textBytes(value) {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : undefined;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function pruneUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}
