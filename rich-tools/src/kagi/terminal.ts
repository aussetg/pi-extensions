/** Remove terminal control sequences from text crossing an external-data boundary. */

const OSC_SEQUENCE = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c)/g;
const STRING_SEQUENCE = /(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c)/g;
const CSI_SEQUENCE = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;
const ESCAPE_SEQUENCE = /\x1b[ -/]*[@-~]/g;
const UNSAFE_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/**
 * Preserve ordinary text, tabs, and line breaks while removing sequences that
 * a terminal could execute. Carriage returns become line breaks rather than
 * being allowed to overwrite already-rendered text.
 */
export function stripTerminalControls(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(OSC_SEQUENCE, "")
    .replace(STRING_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(UNSAFE_CONTROLS, "");
}

/** Sanitize every string value in a JSON-compatible response payload. */
export function stripTerminalControlsDeep<T>(value: T): T {
  if (typeof value === "string") return stripTerminalControls(value) as T;
  if (Array.isArray(value)) return value.map((item) => stripTerminalControlsDeep(item)) as T;
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, stripTerminalControlsDeep(item)]),
  ) as T;
}
