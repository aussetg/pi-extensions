import * as fs from "node:fs";

export function readUtf8IfExists(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const content = fs.readFileSync(filePath, "utf8");
    return content.includes("\0") ? undefined : content;
  } catch {
    return undefined;
  }
}

