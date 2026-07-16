/**
 * Small command-line tokenizer for Pi slash commands.
 *
 * This is deliberately not a shell parser: quotes only group text and a
 * backslash only quotes the following character. There is no expansion,
 * substitution, globbing, or comment syntax.
 */
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;

  for (const character of input) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }

  if (quote) throw new Error("Unclosed quote");
  if (escaped) throw new Error("Trailing escape");
  if (started) tokens.push(current);
  return tokens;
}
