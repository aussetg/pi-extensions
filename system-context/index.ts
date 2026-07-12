import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { accessSync, constants, readFileSync, statSync } from "node:fs";

let cachedSystemInfo: string | undefined;

function getSystemInfo(): string {
  cachedSystemInfo ??= buildSystemInfo();
  return cachedSystemInfo;
}

function buildSystemInfo(): string {
  const distro = getDistroInfo();
  const init = getInitSystem();
  const { manager, helper } = detectPackageManager();

  return `

## System
${distro}
Init: ${init}
Package manager: ${manager}${helper ? ` (${helper} available)` : ""}`;
}

function getDistroInfo(): string {
  try {
    const content = readFileSync("/etc/os-release", "utf-8");
    const id = content.match(/^ID=(.*)$/m)?.[1] || "unknown";
    const idLike = content.match(/^ID_LIKE=(.*)$/m)?.[1];
    return `distro: ${id}${idLike ? ` (based on: ${idLike})` : ""}`;
  } catch {
    return "distro: unknown";
  }
}

function detectPackageManager(): { manager: string; helper?: string } {
  if (commandExists("paru")) return { manager: "pacman", helper: "paru" };
  if (commandExists("yay")) return { manager: "pacman", helper: "yay" };
  if (commandExists("pacman")) return { manager: "pacman" };
  if (commandExists("dnf")) return { manager: "dnf" };
  if (commandExists("yum")) return { manager: "yum" };
  if (commandExists("apt")) return { manager: "apt" };
  if (commandExists("zypper")) return { manager: "zypper" };
  if (commandExists("apk")) return { manager: "apk" };
  if (commandExists("nix")) return { manager: "nix" };
  return { manager: "unknown" };
}

function getInitSystem(): string {
  try {
    return readFileSync("/proc/1/comm", "utf-8").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function commandExists(command: string): boolean {
  const pathEnv = (globalThis as { process?: { env?: { PATH?: string } } }).process?.env?.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    if (isExecutableFile(joinPath(dir, command))) return true;
  }
  return false;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  const systemInfo = getSystemInfo();

  pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
    return { systemPrompt: event.systemPrompt + systemInfo };
  });
}
