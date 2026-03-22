import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
  try {
    // Arch-based: check for AUR helper
    if (execSync("which paru 2>/dev/null", { encoding: "utf-8" }).trim()) {
      return { manager: "pacman", helper: "paru" };
    }
    if (execSync("which yay 2>/dev/null", { encoding: "utf-8" }).trim()) {
      return { manager: "pacman", helper: "yay" };
    }
    if (execSync("which pacman 2>/dev/null", { encoding: "utf-8" }).trim()) {
      return { manager: "pacman" };
    }

    // Fedora/RHEL
    if (execSync("which dnf 2>/dev/null", { encoding: "utf-8" }).trim()) {
      return { manager: "dnf" };
    }
    if (execSync("which yum 2>/dev/null", { encoding: "utf-8" }).trim()) {
      return { manager: "yum" };
    }

    // Debian/Ubuntu
    if (execSync("which apt 2>/dev/null", { encoding: "utf-8" }).trim()) {
      return { manager: "apt" };
    }

    // openSUSE
    if (execSync("which zypper 2>/dev/null", { encoding: "utf-8" }).trim()) {
      return { manager: "zypper" };
    }

    // Alpine
    if (execSync("which apk 2>/dev/null", { encoding: "utf-8" }).trim()) {
      return { manager: "apk" };
    }

    // Nix
    if (execSync("which nix 2>/dev/null", { encoding: "utf-8" }).trim()) {
      return { manager: "nix" };
    }

    return { manager: "unknown" };
  } catch {
    return { manager: "unknown" };
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const distro = getDistroInfo();
    const init = execSync("ps -o comm= 1 2>/dev/null", { encoding: "utf-8" }).trim();
    const { manager, helper } = detectPackageManager();

    const systemInfo = `

## System
${distro}
Init: ${init}
Package manager: ${manager}${helper ? ` (${helper} available)` : ""}`;

    return { systemPrompt: event.systemPrompt + systemInfo };
  });
}
