import { readFile } from "node:fs/promises";

export async function readJsonLines(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
