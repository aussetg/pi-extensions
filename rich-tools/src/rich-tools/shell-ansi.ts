export function hasAnsiEscapes(text: string): boolean {
  return ansiEscapePattern().test(text);
}

export function stripAnsiEscapes(text: string): string {
  return text.replace(ansiEscapePattern(), "");
}

export function ansiEscapePattern(): RegExp {
  return /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[=>]|\x1b[@-_]/g;
}
