import assert from "node:assert/strict";
import test from "node:test";
import {
  bashModelContextText,
  cleanShellPtyArtifacts,
  safeBashModelText,
  stripBashModelExitStatusForDisplay,
  withInferredSuccessfulBashExitCode,
} from "../src/rich-tools/bash-model-output.ts";

test("bash model context output includes successful exit codes", () => {
  assert.equal(
    bashModelContextText("> tsc --noEmit", { exitCode: 0 }),
    "> tsc --noEmit\n\nCommand exited with code 0",
  );
  assert.equal(
    bashModelContextText("", { exitCode: 0 }),
    "Command exited with code 0",
  );
});

test("bash model context output does not duplicate existing exit codes", () => {
  assert.equal(
    bashModelContextText("nope\n\nCommand exited with code 2", { exitCode: 2 }),
    "nope\n\nCommand exited with code 2",
  );
});

test("bash model context output only recognizes generated exit-code footers", () => {
  assert.equal(
    bashModelContextText("real output: Command exited with code 0", { exitCode: 0 }),
    "real output: Command exited with code 0\n\nCommand exited with code 0",
  );
  assert.equal(
    bashModelContextText("real output\nCommand exited with code 0", { exitCode: 0 }),
    "real output\nCommand exited with code 0\n\nCommand exited with code 0",
  );
});

test("bash display output hides model-only exit-code footer", () => {
  assert.equal(
    stripBashModelExitStatusForDisplay("ok\n\nCommand exited with code 0"),
    "ok",
  );
  assert.equal(
    stripBashModelExitStatusForDisplay("Command exited with code 0"),
    "",
  );
  assert.equal(
    stripBashModelExitStatusForDisplay("ok\n\nCommand exited with code 0\n"),
    "ok",
  );
  assert.equal(
    stripBashModelExitStatusForDisplay("real output: Command exited with code 0"),
    "real output: Command exited with code 0",
  );
  assert.equal(
    stripBashModelExitStatusForDisplay("real output\nCommand exited with code 0"),
    "real output\nCommand exited with code 0",
  );
});

test("bash model context output makes control and binary output safe", () => {
  assert.equal(safeBashModelText("left\x1bright\x7f"), "left␛right␡");
  assert.equal(
    safeBashModelText(`${"\x00".repeat(4)} payload`),
    "[Binary output omitted: 12 decoded chars]",
  );
  assert.equal(
    safeBashModelText(`elf ${"\ufffd".repeat(8)} payload`),
    "[Binary output omitted: 20 decoded chars]",
  );
});

test("bash PTY cleanup preserves NULs for binary detection", () => {
  assert.equal(cleanShellPtyArtifacts("^@hello"), "hello");
  assert.equal(cleanShellPtyArtifacts(`${"\x00".repeat(4)} payload`), `${"\x00".repeat(4)} payload`);
});

test("bash PTY cleanup removes cleared spinner frames", () => {
  assert.equal(cleanShellPtyArtifacts("done\n⠙\x1b[1G\x1b[0K"), "done\n");
  assert.equal(cleanShellPtyArtifacts("literal ⠙"), "literal ⠙");
});

test("bash success details infer exit code zero", () => {
  assert.deepEqual(withInferredSuccessfulBashExitCode(undefined, false), { exitCode: 0 });
  assert.equal(withInferredSuccessfulBashExitCode(undefined, undefined), undefined);
  assert.equal(withInferredSuccessfulBashExitCode(undefined, true), undefined);
  assert.deepEqual(
    withInferredSuccessfulBashExitCode({ fullOutputPath: "/tmp/pi-bash.log" }, false),
    { fullOutputPath: "/tmp/pi-bash.log", exitCode: 0 },
  );
  assert.deepEqual(withInferredSuccessfulBashExitCode({ exitCode: 7 }, false), { exitCode: 7 });
});
