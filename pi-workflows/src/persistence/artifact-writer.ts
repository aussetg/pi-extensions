import fs from "node:fs";
import path from "node:path";
import { stableJson } from "../utils/stable-json.js";
import { ensureDir } from "./paths.js";

export class ArtifactWriter {
  constructor(public readonly runDir: string) {}

  path(...parts: string[]): string {
    return path.join(this.runDir, ...parts);
  }

  async ensure(): Promise<void> {
    await ensureDir(this.runDir);
  }

  async mkdir(...parts: string[]): Promise<string> {
    const dir = this.path(...parts);
    await ensureDir(dir);
    return dir;
  }

  async writeText(relativePath: string, text: string): Promise<string> {
    const filePath = this.path(relativePath);
    await ensureDir(path.dirname(filePath));
    await fs.promises.writeFile(filePath, text, "utf8");
    return filePath;
  }

  async writeJson(relativePath: string, value: unknown, stable = false): Promise<string> {
    const body = stable ? `${stableJson(value)}\n` : `${JSON.stringify(value, null, 2)}\n`;
    return this.writeText(relativePath, body);
  }

  async appendJsonl(relativePath: string, value: unknown): Promise<string> {
    const filePath = this.path(relativePath);
    await ensureDir(path.dirname(filePath));
    await fs.promises.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
    return filePath;
  }
}
