import { describe, expect, it } from 'vitest';
import { evaluateFormula, shownCell, toColumnLabel, type CellMap } from './formulas';

describe('safe spreadsheet formula evaluator', () => {
  it('handles arithmetic precedence and parentheses', () => {
    expect(evaluateFormula('2 + 3 * 4', {})).toBe(14);
    expect(evaluateFormula('(2 + 3) * 4', {})).toBe(20);
    expect(evaluateFormula('-4 + 10 / 2', {})).toBe(1);
  });

  it('supports cell references and nested formulas', () => {
    const cells: CellMap = { A1: '5', A2: '7', B1: '=A1 + A2', C1: '=B1 * 2' };
    expect(evaluateFormula('B1 + 1', cells)).toBe(13);
    expect(shownCell('C1', cells)).toBe('24');
  });

  it('supports range functions with positive and negative values', () => {
    const cells: CellMap = { A1: '8', A2: '3', A3: '-2', B1: '=SUM(A1:A3)', B2: '=AVERAGE(A1:A3)' };
    expect(evaluateFormula('SUM(A1:A3)', cells)).toBe(9);
    expect(evaluateFormula('AVERAGE(A1:A3)', cells)).toBe(3);
    expect(evaluateFormula('MIN(A1:A2)', cells)).toBe(3);
    expect(evaluateFormula('MAX(A1:A3)', cells)).toBe(8);
    expect(shownCell('B1', cells)).toBe('9');
    expect(shownCell('B2', cells)).toBe('3');
  });

  it('rejects circular references, invalid input and zero division', () => {
    expect(() => evaluateFormula('A1 + 1', { A1: '=A1 + 1' })).toThrow(/Circular/);
    expect(() => evaluateFormula('9 / 0', {})).toThrow(/Division by zero/);
    expect(() => evaluateFormula('window.alert(1)', {})).toThrow();
    expect(() => evaluateFormula('2 ** 8', {})).toThrow();
    expect(shownCell('A1', { A1: '=A1 + 1' })).toBe('#ERROR');
  });

  it('supports additional Excel-style numeric functions', () => {
    const cells: CellMap = { A1: '2', A2: '4', A3: '6', B1: 'note', C1: '=SUM(A1:A3)' };
    expect(evaluateFormula('PRODUCT(A1:A3)', cells)).toBe(48);
    expect(evaluateFormula('MEDIAN(A1:A3)', cells)).toBe(4);
    expect(evaluateFormula('COUNT(A1:A3)', cells)).toBe(3);
    expect(evaluateFormula('COUNTA(A1:C1)', cells)).toBe(3);
    expect(evaluateFormula('ROUND(3.14159, 2)', cells)).toBe(3.14);
    expect(evaluateFormula('ABS(-9)', cells)).toBe(9);
    expect(evaluateFormula('SQRT(81)', cells)).toBe(9);
    expect(evaluateFormula('POWER(2, 5)', cells)).toBe(32);
    expect(evaluateFormula('IF(A2>=4, 1, 0)', cells)).toBe(1);
    expect(evaluateFormula('IF(A1>4, 1, 0)', cells)).toBe(0);
  });

  it('converts spreadsheet column numbers', () => {
    expect(toColumnLabel(1)).toBe('A');
    expect(toColumnLabel(26)).toBe('Z');
    expect(toColumnLabel(27)).toBe('AA');
  });
});