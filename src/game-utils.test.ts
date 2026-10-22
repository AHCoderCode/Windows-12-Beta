import { describe, expect, it } from 'vitest';
import { createMineLayout, createSnakeFood, has2048Moves, mineNeighbors, move2048, paintStrokeStyle, spawn2048 } from './game-utils';

describe('2048 rules', () => {
  it('merges equal tiles once per move and calculates the score gain', () => {
    const result = move2048([2,2,2,2,0,0,0,0,0,0,0,0,0,0,0,0], 'left');
    expect(result.board.slice(0,4)).toEqual([4,4,0,0]);
    expect(result.gained).toBe(8);
    expect(result.moved).toBe(true);
  });

  it('does not spawn after a move that has no empty space or report moves on a full dead board', () => {
    const full = [2,4,2,4,4,2,4,2,2,4,2,4,4,2,4,2];
    expect(spawn2048(full, () => 0)).toBe(full);
    expect(has2048Moves(full)).toBe(false);
  });

  it('detects legal merges on a full board', () => {
    const board = [2,2,4,8,4,8,2,4,8,2,4,2,4,8,2,4];
    expect(has2048Moves(board)).toBe(true);
  });
});

describe('Snake and Minesweeper board generation', () => {
  it('never chooses food inside the snake and detects a full board', () => {
    expect(createSnakeFood([0,1,2], () => 0)).toBe(3);
    expect(createSnakeFood(Array.from({length:100},(_,i)=>i))).toBeNull();
  });

  it('keeps the first Minesweeper click safe', () => {
    const mines = createMineLayout(44, 10, 81, () => 0.37);
    expect(mines).toHaveLength(10);
    expect(mines).not.toContain(44);
    expect(new Set(mines).size).toBe(10);
  });

  it('computes corner neighbors within board bounds', () => {
    expect(mineNeighbors(0)).toEqual([1,9,10]);
    expect(mineNeighbors(80)).toEqual([70,71,79]);
  });
});

describe('Paint brush configuration', () => {
  it('uses the current selected color for the next stroke without changing brush size', () => {
    expect(paintStrokeStyle('#ff0000', 7, 1.5, false)).toMatchObject({
      strokeStyle: '#ff0000', lineWidth: 10.5, globalCompositeOperation: 'source-over',
    });
    expect(paintStrokeStyle('#0000ff', 7, 1.5, false)).toMatchObject({
      strokeStyle: '#0000ff', lineWidth: 10.5, globalCompositeOperation: 'source-over',
    });
    expect(paintStrokeStyle('#0000ff', 7, 1.5, true)).toMatchObject({
      strokeStyle: '#0000ff', lineWidth: 10.5, globalCompositeOperation: 'destination-out',
    });
  });
});
