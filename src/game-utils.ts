export type Direction2048 = 'left' | 'right' | 'up' | 'down';

export function spawn2048(board: number[], random = Math.random): number[] {
  const empty = board.map((value, index) => value === 0 ? index : -1).filter(index => index >= 0);
  if (!empty.length) return board;
  const next = [...board];
  const slot = empty[Math.floor(random() * empty.length)];
  next[slot] = random() < 0.9 ? 2 : 4;
  return next;
}

export function move2048(board: number[], direction: Direction2048): { board: number[]; moved: boolean; gained: number } {
  if (board.length !== 16) return { board: [...board], moved: false, gained: 0 };
  const next = Array<number>(16).fill(0);
  let gained = 0;
  for (let line = 0; line < 4; line++) {
    const positions = Array.from({ length: 4 }, (_, offset) =>
      direction === 'left' ? line * 4 + offset
        : direction === 'right' ? line * 4 + (3 - offset)
        : direction === 'up' ? offset * 4 + line
        : (3 - offset) * 4 + line);
    const values = positions.map(index => board[index]).filter(value => value !== 0);
    const merged: number[] = [];
    for (let i = 0; i < values.length; i++) {
      if (values[i] === values[i + 1]) {
        const value = values[i] * 2;
        merged.push(value);
        gained += value;
        i++;
      } else merged.push(values[i]);
    }
    positions.forEach((index, offset) => { next[index] = merged[offset] ?? 0; });
  }
  return { board: next, moved: next.some((value, index) => value !== board[index]), gained };
}

export function has2048Moves(board: number[]): boolean {
  if (board.length !== 16) return false;
  if (board.some(value => value === 0)) return true;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const i = row * 4 + col;
      if (col < 3 && board[i] === board[i + 1]) return true;
      if (row < 3 && board[i] === board[i + 4]) return true;
    }
  }
  return false;
}

export function createSnakeFood(occupied: number[], random = Math.random, boardSize = 100): number | null {
  const blocked = new Set(occupied);
  const available: number[] = [];
  for (let i = 0; i < boardSize; i++) if (!blocked.has(i)) available.push(i);
  if (!available.length) return null;
  return available[Math.min(available.length - 1, Math.floor(random() * available.length))];
}

export function createMineLayout(
  safeIndex: number | null = null,
  mineCount = 10,
  boardSize = 81,
  random = Math.random,
): number[] {
  const eligible = Array.from({ length: boardSize }, (_, index) => index).filter(index => index !== safeIndex);
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }
  return eligible.slice(0, Math.max(0, Math.min(mineCount, eligible.length)));
}

export function mineNeighbors(index: number, columns = 9, rows = 9): number[] {
  const x = index % columns;
  const y = Math.floor(index / columns);
  const neighbors: number[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < columns && ny >= 0 && ny < rows) neighbors.push(ny * columns + nx);
  }
  return neighbors;
}

export function paintStrokeStyle(color: string, size: number, scale: number, eraser: boolean) {
  return {
    strokeStyle: color,
    lineWidth: Math.max(1, size * scale),
    globalCompositeOperation: eraser ? 'destination-out' : 'source-over',
    lineCap: 'round' as const,
    lineJoin: 'round' as const,
  };
}
