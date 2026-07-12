const TRAILING_BASH_EXIT_STATUS_RE = /(?:^|\n\n)Command exited with code (-?\d+)[ \t]*(?:\n[ \t]*)*$/;
const ANSI_CSI_SOURCE = String.raw`\x1b\[[0-?]*[ -/]*[@-~]`;
const SHELL_SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const CLEARED_SPINNER_RE = new RegExp(
  `(?:\r|${ANSI_CSI_SOURCE})*[${SHELL_SPINNER_FRAMES}](?:${ANSI_CSI_SOURCE}|\r)*\x1b\[[0-?]*[ -/]*[JK](?:${ANSI_CSI_SOURCE}|\r)*`,
  "g",
);
const SHELL_CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const BINARY_SIGNAL_MIN = 4;
const BINARY_SIGNAL_RATIO = 0.08;

export function cleanShellPtyArtifacts(text: string): string {
  const withoutLeadingNulGlyph = text.startsWith("^@") ? text.slice(2) : text;
  return withoutLeadingNulGlyph.replace(CLEARED_SPINNER_RE, "");
}

export function withInferredSuccessfulBashExitCode(
  details: unknown,
  isError: boolean | undefined,
): unknown {
  if (bashExitCode(details) !== undefined || isError !== false) return details;
  if (!isRecord(details)) return { exitCode: 0 };
  return { ...details, exitCode: 0 };
}

export function bashModelContextText(text: string, details: unknown): string {
  const safeText = safeBashModelText(text);
  const exitCode = bashExitCode(details);
  if (exitCode === undefined || hasBashExitStatus(safeText, exitCode)) return safeText;

  const status = `Command exited with code ${exitCode}`;
  const body = safeText.trimEnd();
  return body.length > 0 ? `${body}\n\n${status}` : status;
}

export function safeBashModelText(text: string): string {
  return text.split("\n").map(safeBashPlainLine).join("\n");
}

export function safeBashPlainLine(line: string): string {
  if (isBinaryLikeBashLine(line)) return binaryBashLineNotice(line);
  return visualizeShellControlChars(line);
}

export function isBinaryLikeBashLine(line: string): boolean {
  if (line.length === 0) return false;
  const replacementChars = countChar(line, "\ufffd");
  if (replacementChars >= BINARY_SIGNAL_MIN && replacementChars / line.length >= BINARY_SIGNAL_RATIO) {
    return true;
  }

  const controlChars = countMatches(line, SHELL_CONTROL_CHAR_RE);
  return controlChars >= BINARY_SIGNAL_MIN && controlChars / line.length >= BINARY_SIGNAL_RATIO;
}

export function binaryBashLineNotice(line: string): string {
  return `[Binary output omitted: ${line.length} decoded chars]`;
}

export function visualizeShellControlChars(text: string): string {
  return text.replace(SHELL_CONTROL_CHAR_RE, (char) => {
    const code = char.charCodeAt(0);
    return code === 0x7f ? "\u2421" : String.fromCharCode(0x2400 + code);
  });
}

export function stripBashModelExitStatusForDisplay(text: string): string {
  return text.replace(TRAILING_BASH_EXIT_STATUS_RE, "");
}

function bashExitCode(details: unknown): number | undefined {
  if (!isRecord(details)) return undefined;
  const exitCode = (details as { exitCode?: unknown }).exitCode;
  return Number.isInteger(exitCode) ? exitCode as number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasBashExitStatus(text: string, exitCode: number): boolean {
  const match = TRAILING_BASH_EXIT_STATUS_RE.exec(text);
  return match?.[1] === String(exitCode);
}

function countChar(text: string, needle: string): number {
  let count = 0;
  for (const char of text) {
    if (char === needle) count += 1;
  }
  return count;
}

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text)) count += 1;
  return count;
}
