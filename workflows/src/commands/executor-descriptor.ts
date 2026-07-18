import { spawnSync } from "node:child_process";

export interface CommandExecutableDiagnostic {
  path: string;
  version?: string;
}

export interface HostCommandExecutorDescriptor {
  id: string;
  sandbox: "bwrap-systemd" | "fake";
  executables?: {
    bubblewrap: CommandExecutableDiagnostic;
    systemdRun: CommandExecutableDiagnostic;
    systemctl: CommandExecutableDiagnostic;
  };
}

export interface SandboxedCommandExecutorOptions {
  bwrapPath?: string;
  systemdRunPath?: string;
  systemctlPath?: string;
}

/** Executable diagnostics and run-owned safety are evidence, not replay identity. */
export function sandboxedCommandExecutorDescriptor(
  options: SandboxedCommandExecutorOptions = {},
): HostCommandExecutorDescriptor {
  const bwrap = options.bwrapPath ?? "/usr/bin/bwrap";
  const systemdRun = options.systemdRunPath ?? "/usr/bin/systemd-run";
  const systemctl = options.systemctlPath ?? "/usr/bin/systemctl";
  return Object.freeze({
    id: "sandboxed-command",
    sandbox: "bwrap-systemd",
    executables: {
      bubblewrap: executableDiagnostic(bwrap, ["--version"]),
      systemdRun: executableDiagnostic(systemdRun, ["--version"]),
      systemctl: executableDiagnostic(systemctl, ["--version"]),
    },
  });
}

export function sameCommandExecutorProtocol(
  left: HostCommandExecutorDescriptor,
  right: HostCommandExecutorDescriptor,
): boolean {
  return left.id === right.id && left.sandbox === right.sandbox;
}

function executableDiagnostic(filePath: string, args: string[]): CommandExecutableDiagnostic {
  const result = spawnSync(filePath, args, { encoding: "utf8", timeout: 2_000, maxBuffer: 8_192 });
  const firstLine = `${result.stdout ?? ""}${result.stderr ?? ""}`.split(/\r?\n/, 1)[0]?.trim();
  return { path: filePath, ...(firstLine ? { version: firstLine.slice(0, 512) } : {}) };
}
