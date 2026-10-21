export type CellMap = Record<string, string>;

function columnNumber(label: string): number {
  let result = 0;
  for (const char of label.toUpperCase()) result = result * 26 + char.charCodeAt(0) - 64;
  return result;
}

function columnLabel(value: number): string {
  let n = value;
  let result = '';
  while (n > 0) {
    n -= 1;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

function resolveCell(reference: string, cells: CellMap, visiting: Set<string>): number {
  const key = reference.toUpperCase();
  if (!/^[A-Z]{1,3}\d{1,4}$/.test(key)) throw new Error('Invalid cell reference');
  if (visiting.has(key)) throw new Error('Circular reference');
  const raw = cells[key] ?? '';
  if (!raw.startsWith('=')) {
    if (raw.trim() === '') return 0;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error('Cell is not numeric');
    return value;
  }
  const next = new Set(visiting);
  next.add(key);
  return evaluateFormula(raw.slice(1), cells, next);
}

function rangeReferences(first: string, last: string): string[] {
  const from = first.toUpperCase().match(/^([A-Z]+)(\d+)$/);
  const to = last.toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!from || !to) throw new Error('Invalid range');
  const c1 = columnNumber(from[1]);
  const c2 = columnNumber(to[1]);
  const r1 = Number(from[2]);
  const r2 = Number(to[2]);
  if (Math.abs(c1 - c2) > 100 || Math.abs(r1 - r2) > 100) throw new Error('Range is too large');
  const refs: string[] = [];
  for (let row = Math.min(r1, r2); row <= Math.max(r1, r2); row += 1) {
    for (let col = Math.min(c1, c2); col <= Math.max(c1, c2); col += 1) refs.push(columnLabel(col) + row);
  }
  return refs;
}

function rangeValues(first: string, last: string, cells: CellMap, visiting: Set<string>): number[] {
  return rangeReferences(first, last).map(reference => resolveCell(reference, cells, new Set(visiting)));
}

/**
 * Evaluates a deliberately small spreadsheet formula language.
 * It supports arithmetic, cell references, range statistics, selected numeric functions and a numeric IF condition.
 * It never executes JavaScript supplied by a user.
 */
export function evaluateFormula(input: string, cells: CellMap, visiting = new Set<string>()): number {
  let source = input.trim();
  if (!source) return 0;
  if (source.length > 1000) throw new Error('Formula is too long');

  source = source.replace(/\b(SUM|AVERAGE|MIN|MAX|PRODUCT|MEDIAN|COUNT|COUNTA)\(\s*([A-Z]+\d+)\s*:\s*([A-Z]+\d+)\s*\)/gi,
    (_match, name: string, first: string, last: string) => {
      const fn = name.toUpperCase();
      const refs = rangeReferences(first, last);
      if (fn === 'COUNTA') return String(refs.filter(ref => (cells[ref] ?? '').trim() !== '').length);
      if (fn === 'COUNT') return String(refs.filter(ref => { const raw = (cells[ref] ?? '').trim(); if (!raw) return false; try { resolveCell(ref, cells, new Set(visiting)); return true; } catch { return false; } }).length);
      const values = refs.map(ref => resolveCell(ref, cells, new Set(visiting)));
      if (fn === 'SUM') return String(values.reduce((sum, value) => sum + value, 0));
      if (fn === 'AVERAGE') return String(values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
      if (fn === 'MIN') return String(values.length ? Math.min(...values) : 0);
      if (fn === 'MAX') return String(values.length ? Math.max(...values) : 0);
      if (fn === 'PRODUCT') return String(values.reduce((product, value) => product * value, 1));
      const sorted = [...values].sort((a, b) => a - b);
      return String(sorted.length ? sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : 0);
    });

  source = source.replace(/\b(ABS|SQRT)\(\s*([^()]*)\s*\)/gi,
    (_match, name: string, argument: string) => {
      const value = evaluateFormula(argument, cells, new Set(visiting));
      if (name.toUpperCase() === 'SQRT' && value < 0) throw new Error('Square root of a negative number');
      return String(name.toUpperCase() === 'ABS' ? Math.abs(value) : Math.sqrt(value));
    });
  source = source.replace(/\b(ROUND|POWER)\(\s*([^()]*)\s*\)/gi,
    (_match, name: string, args: string) => {
      const pieces = args.split(',');
      if (pieces.length !== 2) throw new Error(name.toUpperCase() + ' requires two arguments');
      const left = evaluateFormula(pieces[0], cells, new Set(visiting));
      const right = evaluateFormula(pieces[1], cells, new Set(visiting));
      if (name.toUpperCase() === 'POWER') return String(Math.pow(left, right));
      const factor = Math.pow(10, Math.max(-10, Math.min(10, Math.trunc(right))));
      return String(Math.round((left + Number.EPSILON) * factor) / factor);
    });
  source = source.replace(/\bIF\(\s*([^,()]+)\s*,\s*([^,()]+)\s*,\s*([^()]+)\s*\)/gi,
    (_match, condition: string, whenTrue: string, whenFalse: string) => {
      const comparison = condition.trim().match(/^(.*?)(>=|<=|<>|!=|=|>|<)(.*)$/);
      let passed: boolean;
      if (comparison) {
        const left = evaluateFormula(comparison[1], cells, new Set(visiting));
        const right = evaluateFormula(comparison[3], cells, new Set(visiting));
        const operator = comparison[2];
        passed = operator === '>' ? left > right : operator === '<' ? left < right : operator === '>=' ? left >= right : operator === '<=' ? left <= right : operator === '=' ? left === right : left !== right;
      } else passed = evaluateFormula(condition, cells, new Set(visiting)) !== 0;
      return String(evaluateFormula(passed ? whenTrue : whenFalse, cells, new Set(visiting)));
    });

  source = source.replace(/\b([A-Z]{1,3}\d{1,4})\b/gi,
    (_match, reference: string) => String(resolveCell(reference, cells, new Set(visiting))));

  const compact = source.replace(/\s/g, '');
  const tokens = compact.match(/\d+(?:\.\d+)?|[()+\-*/]/g);
  if (!tokens || tokens.join('') !== compact) throw new Error('Unsupported formula syntax');

  let index = 0;
  const parseFactor = (): number => {
    const token = tokens[index++];
    if (token === '+') return parseFactor();
    if (token === '-') return -parseFactor();
    if (token === '(') {
      const value = parseExpression();
      if (tokens[index++] !== ')') throw new Error('Missing closing parenthesis');
      return value;
    }
    if (!token || !/^\d+(?:\.\d+)?$/.test(token)) throw new Error('Expected a number');
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error('Invalid number');
    return value;
  };
  const parseTerm = (): number => {
    let value = parseFactor();
    while (tokens[index] === '*' || tokens[index] === '/') {
      const operator = tokens[index++];
      const right = parseFactor();
      if (operator === '/' && right === 0) throw new Error('Division by zero');
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  };
  const parseExpression = (): number => {
    let value = parseTerm();
    while (tokens[index] === '+' || tokens[index] === '-') {
      const operator = tokens[index++];
      const right = parseTerm();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  };

  const result = parseExpression();
  if (index !== tokens.length || !Number.isFinite(result)) throw new Error('Invalid formula result');
  return result;
}

export function shownCell(reference: string, cells: CellMap): string {
  const raw = cells[reference.toUpperCase()] ?? '';
  if (!raw.startsWith('=')) return raw;
  try {
    const result = evaluateFormula(raw.slice(1), cells, new Set([reference.toUpperCase()]));
    return String(Number(result.toFixed(8)));
  } catch {
    return '#ERROR';
  }
}

export function toColumnLabel(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 18278) throw new Error('Invalid column number');
  return columnLabel(value);
}