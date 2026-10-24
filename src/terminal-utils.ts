export type TerminalArgument = { value: string; start: number; end: number };

/**
 * Parse shell-like arguments for AeroShell's simulated terminal.
 * Quoting groups filenames with spaces; backslashes escape the next
 * character outside single quotes and inside double quotes.
 * This parser never executes a host shell.
 */
export function parseTerminalArguments(input: string): TerminalArgument[] {
  const argumentsFound: TerminalArgument[] = [];
  let index = 0;

  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index])) index += 1;
    if (index >= input.length) break;

    const start = index;
    let value = '';
    let quote: "'" | '"' | null = null;
    let escaped = false;

    while (index < input.length) {
      const character = input[index];

      if (escaped) {
        value += character;
        escaped = false;
        index += 1;
        continue;
      }

      if (character === '\\' && quote !== "'") {
        escaped = true;
        index += 1;
        continue;
      }

      if (quote !== null) {
        if (character === quote) quote = null;
        else value += character;
        index += 1;
        continue;
      }

      if (character === '"' || character === "'") {
        quote = character;
        index += 1;
        continue;
      }

      if (/\s/.test(character)) break;
      value += character;
      index += 1;
    }

    if (escaped) value += '\\';
    argumentsFound.push({ value, start, end: index });
  }

  return argumentsFound;
}
