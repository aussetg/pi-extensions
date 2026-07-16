import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommandProfileRegistry,
  normalizeCommandProfile,
  resolveCommandInvocation,
} from "../src/commands/profiles.js";
import { stableHash } from "../src/utils/hashes.js";
import { parseStructuredWorkflow } from "../src/definition/workflow-definition.js";
import { prepareWorkflowExecutionResources } from "../src/agents/resources.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe("reviewed command profiles", () => {
  it("loads exact trusted namespaces, rejects symlinks, and pins semantic content", async () => {
    const root = await temporary("command-profiles-");
    const user = path.join(root, "user");
    const project = path.join(root, "project");
    await fs.promises.mkdir(user);
    await fs.promises.mkdir(project);
    await fs.promises.writeFile(path.join(user, "inspect.json"), JSON.stringify(profile({ name: "inspect" })));
    await fs.promises.writeFile(path.join(project, "inspect.json"), JSON.stringify(profile({ name: "inspect", argv: ["/usr/bin/printf", "%s", "project"] })));
    await fs.promises.symlink(path.join(user, "inspect.json"), path.join(project, "linked.json"));

    const registry = new CommandProfileRegistry();
    await registry.refresh(root, { builtins: [], userDir: user, projectDir: project, includeProject: false });
    expect(registry.resolve("inspect").id).toBe("user:inspect");
    await registry.refresh(root, { builtins: [], userDir: user, projectDir: project, includeProject: true });
    expect(() => registry.resolve("inspect")).toThrow(/ambiguous/i);
    expect(registry.listInvalid()).toEqual([
      expect.objectContaining({ namespace: "project", name: "linked", error: expect.stringMatching(/symlink/i) }),
    ]);
    const exact = registry.resolve("project:inspect");
    expect(exact.argv).toEqual(["/usr/bin/printf", "%s", "project"]);
    expect(exact.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(exact)).toBe(true);
  });

  it("substitutes one bounded argv token without shell interpolation or argument splitting", () => {
    const definition = profile({
      name: "literal",
      argv: ["/usr/bin/printf", "%s", "${value}"],
      arguments: { value: { type: "string", maximumBytes: 128 } },
      effects: ["read-only", "candidate"],
    });
    const snapshot = snapshotOf(definition);
    const hostile = "$(touch /workspace/pwned); two words";
    const invocation = resolveCommandInvocation(snapshot, { value: hostile }, "candidate");
    expect(invocation.argv).toEqual(["/usr/bin/printf", "%s", hostile]);
    expect(invocation.argumentsHash).toMatch(/^sha256:/);
    expect(invocation.hash).toMatch(/^sha256:/);
    expect(Object.isFrozen(invocation)).toBe(true);
  });

  it("enforces declarations, defaults, effects, and normalized project paths", () => {
    const snapshot = snapshotOf(profile({
      name: "bounded",
      argv: ["/usr/bin/printf", "%s", "${path}", "${count}", "${mode}"],
      arguments: {
        path: { type: "project-path" },
        count: { type: "integer", minimum: 1, maximum: 3, default: 2 },
        mode: { type: "string", enum: ["check", "fix"], default: "check" },
      },
      effects: ["temporary"],
    }));
    expect(resolveCommandInvocation(snapshot, { path: "src/file.ts" }, "temporary").argv)
      .toEqual(["/usr/bin/printf", "%s", "src/file.ts", "2", "check"]);
    expect(() => resolveCommandInvocation(snapshot, { path: "../secret" }, "temporary")).toThrow(/project-relative/i);
    expect(() => resolveCommandInvocation(snapshot, { path: "src", extra: true }, "temporary")).toThrow(/unknown argument/i);
    expect(() => resolveCommandInvocation(snapshot, { path: "src", count: 4 }, "temporary")).toThrow(/integer bounds/i);
    expect(() => resolveCommandInvocation(snapshot, { path: "src" }, "candidate")).toThrow(/does not permit/i);
  });

  it("resolves and snapshots every selected profile before run launch", async () => {
    const project = await temporary("command-launch-");
    const directory = path.join(project, ".pi", "commands");
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(path.join(directory, "check.json"), JSON.stringify(profile({
      name: "check",
      argv: ["/usr/bin/printf", "%s", "${suite}"],
      arguments: { suite: { type: "string", enum: ["focused"] } },
      effects: ["temporary"],
    })));
    const parsed = parseStructuredWorkflow(`
      export default defineWorkflow({
        name: "command-launch",
        description: "command launch fixture",
        inputSchema: { type: "object", additionalProperties: false },
        outputSchema: {},
        capabilities: ["host-command"],
        modelVisible: false,
        async run(flow, args) {
          void args;
          return await flow.command("check", {
            profile: "project:check",
            args: { suite: "focused" },
            effect: "temporary",
          });
        },
      });
    `);
    const resources = await prepareWorkflowExecutionResources(parsed, {
      cwd: project,
      includeProjectCommands: true,
      commandExecutorDescriptor: { id: "fake-command", protocolVersion: 1, sandbox: "fake" },
    });
    expect(resources.commands).toEqual([
      expect.objectContaining({ id: "project:check", effects: ["temporary"], hash: expect.stringMatching(/^sha256:/) }),
    ]);
    await fs.promises.writeFile(path.join(directory, "check.json"), JSON.stringify(profile({ name: "check" })));
    expect(resources.commands[0]?.argv).toEqual(["/usr/bin/printf", "%s", "${suite}"]);
  });

  it.each([
    ["unknown field", { extra: true }, /unknown field/i],
    ["relative executable", { argv: ["printf", "x"] }, /absolute path/i],
    ["dynamic executable", { argv: ["${program}", "x"], arguments: { program: { type: "string" } } }, /executable must be fixed/i],
    ["partial interpolation", { argv: ["/usr/bin/printf", "prefix-${value}"], arguments: { value: { type: "string" } } }, /complete.*token/i],
    ["unused argument", { arguments: { value: { type: "string" } } }, /never used/i],
    ["reserved environment", { env: { PATH: "/tmp" } }, /reserved/i],
  ])("rejects %s", (_label, patch, expected) => {
    expect(() => normalizeCommandProfile({ ...profile(), ...patch })).toThrow(expected);
  });
});

function profile(patch: Record<string, unknown> = {}) {
  return {
    name: "fixture",
    description: "Fixed command profile fixture.",
    argv: ["/usr/bin/printf", "%s", "fixed"],
    timeoutMs: 5_000,
    outputLimitBytes: 64 * 1024,
    effects: ["read-only"],
    ...patch,
  };
}

function snapshotOf(value: ReturnType<typeof profile>) {
  const definition = normalizeCommandProfile(value);
  const namespace = "project" as const;
  return {
    ...definition,
    id: `${namespace}:${definition.name}` as const,
    namespace,
    path: `<builtin:${definition.name}>`,
    hash: hash(namespace, definition),
  };
}

function hash(namespace: string, definition: unknown): string {
  return stableHash({ namespace, definition });
}

async function temporary(prefix: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
