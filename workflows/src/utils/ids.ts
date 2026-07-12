import crypto from "node:crypto";

export function createRunId(): string {
  return `wr_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
}

export function createTaskId(prefix = "task"): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || "workflow";
}

export function nowIso(): string {
  return new Date().toISOString();
}
