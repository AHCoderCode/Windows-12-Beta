import { describe, expect, it } from 'vitest';
import { parseTerminalArguments } from './terminal-utils';

describe('AeroShell terminal argument parsing', () => {
  it('keeps double-quoted filenames together', () => {
    expect(parseTerminalArguments('cp "meeting notes.txt" "meeting notes copy.txt"').map(item => item.value))
      .toEqual(['cp', 'meeting notes.txt', 'meeting notes copy.txt']);
  });

  it('keeps single-quoted filenames together', () => {
    expect(parseTerminalArguments("mv 'draft v1.txt' 'draft v2.txt'").map(item => item.value))
      .toEqual(['mv', 'draft v1.txt', 'draft v2.txt']);
  });

  it('preserves whitespace inside quoted filenames', () => {
    expect(parseTerminalArguments('"two   spaces.txt"').map(item => item.value))
      .toEqual(['two   spaces.txt']);
  });

  it('provides offsets so write can preserve text after a filename', () => {
    const source = '"meeting notes.txt" first line with spaces';
    const [target] = parseTerminalArguments(source);
    expect(target).toMatchObject({ value: 'meeting notes.txt', start: 0 });
    expect(source.slice(target.end).trimStart()).toBe('first line with spaces');
  });

  it('supports escaped spaces in unquoted names', () => {
    expect(parseTerminalArguments('touch notes\\ file.txt').map(item => item.value))
      .toEqual(['touch', 'notes file.txt']);
  });

  it('handles empty input without creating empty arguments', () => {
    expect(parseTerminalArguments('   \t  ')).toEqual([]);
  });
});
