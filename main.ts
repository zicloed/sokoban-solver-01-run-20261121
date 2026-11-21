// Kestrel Sokoban — a push-optimal solver, room by room.
//
// The levels this contest draws are built from one hallway with rooms
// off it, and a box that leaves its room can never come back, so the
// whole level's push-optimum is the sum of its rooms' optima. This
// program cuts the level into its rooms, solves each room with a
// breadth-first search over pushes (dead squares and frozen 2x2 blocks
// pruned), and stitches the rooms' move strings together with walks
// along the hallway. A room of three or four boxes in a 6x6 slot is a
// small search; a whole set of five levels answers in well under a
// second, far inside the 60-second budget.
//
// stdlib only: it runs in a plain Node 22 image with no packages.
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
/** The most states one room search keeps before it gives up. */
const MAX_ROOM_STATES = 250_000;
/** Stop starting new levels after this long, so the run always finishes. */
const RUN_BUDGET_MS = 45_000;

interface Vec {
  dx: number;
  dy: number;
  step: string;
  push: string;
}
const DIRS: Vec[] = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** An XSB level (# wall, space floor, . goal, $ box, * box on a goal, @ player). */
function parseBoard(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The cells a box can stand on and still reach a goal: pull backwards
 * from the goals. A box on `y` can be pulled to a live cell `x` (one step
 * in direction d, so y = x - d) when both `y` and the square behind it,
 * `y - d`, are open floor — the player has to stand there to make the push.
 */
function liveCells(board: Board): Uint8Array {
  const { w, wall, goals } = board;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const d of DIRS) {
      const step = d.dy * w + d.dx;
      const y = x - step;
      const behind = y - step;
      if (y < 0 || y >= wall.length || behind < 0 || behind >= wall.length) continue;
      if (wall[y] === 0 && wall[behind] === 0 && live[y] === 0) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood-fill the free region around `from` (walls and `blocked` cells are
 * shut), stamping every cell it reaches in `seen` with `stamp`, and return
 * the region's lowest cell number — the region's name for state keys.
 */
function markRegion(
  board: Board,
  blocked: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = board;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && blocked[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four
 * cells of walls and boxes with a box among them off its goal. A box in
 * such a block can never move again, so the state is dead.
 */
function frozenBlock(board: Board, blocked: Uint8Array, isGoal: Uint8Array, t: number): boolean {
  const { w, wall } = board;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    if (a % w === w - 1) continue; // the block would wrap to the next row
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    const filled = (i: number): boolean => wall[i] === 1 || blocked[i] === 1;
    if (!filled(a) || !filled(b) || !filled(c) || !filled(d)) continue;
    const offGoal = (i: number): boolean => blocked[i] === 1 && isGoal[i] === 0;
    if (offGoal(a) || offGoal(b) || offGoal(c) || offGoal(d)) return true;
  }
  return false;
}

/**
 * The shortest walk from `from` to `to` around walls and `blocked` cells,
 * as lower-case step letters (the first step first on ties). Throws when
 * `to` cannot be reached.
 */
function shortestWalk(board: Board, blocked: Uint8Array, from: number, to: number): string {
  const { w, wall } = board;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 1 || blocked[q] === 1 || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walk target out of reach');
  let out = '';
  for (let p = to; p !== from; p = prev[p]) out = how[p] + out;
  return out;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from`. */
function afterMoves(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

interface PushPlan {
  pushes: number;
  moves: string;
}

/**
 * The push-optimal way to put every box on a goal, searching at most
 * `maxStates` states and giving up past `deadlineMs`, so a pathological
 * room cannot eat the run's whole budget: a breadth-first search over
 * pushes, so the first solved state met is optimal. A state is the boxes'
 * squares plus the player's reachable region (named by its lowest square).
 * Two deadlocks are pruned: a box pushed onto a dead square, and a box
 * pushed into a frozen 2x2 block. Returns null when the search gives up.
 */
function solvePushes(board: Board, maxStates: number, deadlineMs: number): PushPlan | null {
  const { w, wall, goals } = board;
  const size = wall.length;
  const isGoal = new Uint8Array(size);
  for (const g of goals) isGoal[g] = 1;
  const live = liveCells(board);
  const allSolved = (boxes: number[]): boolean => boxes.every((b) => isGoal[b] === 1);
  if (board.boxes.some((b) => live[b] === 0)) return null;
  if (allSolved(board.boxes)) return { pushes: 0, moves: '' };

  const blocked = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const stateKey = (boxes: number[], low: number): string => low + '|' + boxes.join(',');

  // The states, in the order found: boxes, the player's square, and the
  // push that made the state from its parent.
  const stateBoxes: number[][] = [board.boxes.slice()];
  const statePlayer: number[] = [board.player];
  const parent: number[] = [-1];
  const madeBy: { box: number; dir: Vec }[] = [{ box: -1, dir: DIRS[0] }];

  for (const b of board.boxes) blocked[b] = 1;
  const startLow = markRegion(board, blocked, board.player, seen, ++stamp, stack);
  for (const b of board.boxes) blocked[b] = 0;
  const visited = new Map<string, number>();
  visited.set(stateKey(board.boxes, startLow), 0);

  let found = -1;
  for (let head = 0; found < 0 && head < stateBoxes.length; head++) {
    if ((head & 1023) === 0 && Date.now() > deadlineMs) return null;
    const boxes = stateBoxes[head];
    for (const b of boxes) blocked[b] = 1;
    markRegion(board, blocked, statePlayer[head], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (const d of DIRS) {
        const step = d.dy * w + d.dx;
        const behind = b - step;
        const target = b + step;
        if (behind < 0 || behind >= size || target < 0 || target >= size) continue;
        if (seen[behind] !== here) continue; // the player cannot reach the push square
        if (wall[target] === 1 || blocked[target] === 1 || live[target] === 0) continue;
        // Tentatively push the box, and check the frozen-block deadlock.
        blocked[b] = 0;
        blocked[target] = 1;
        const frozen = frozenBlock(board, blocked, isGoal, target);
        let key = '';
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = target;
          next.sort((x, y) => x - y);
          const low = markRegion(board, blocked, b, mark, ++stamp, stack);
          key = stateKey(next, low);
        }
        blocked[target] = 0;
        blocked[b] = 1;
        if (frozen || visited.has(key)) continue;
        if (stateBoxes.length >= maxStates) {
          for (const x of boxes) blocked[x] = 0;
          return null;
        }
        visited.set(key, stateBoxes.length);
        stateBoxes.push(next!);
        statePlayer.push(b);
        parent.push(head);
        madeBy.push({ box: b, dir: d });
        if (allSolved(next!)) {
          found = stateBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) blocked[x] = 0;
  }
  if (found < 0) return null;

  // The pushes, root first, then the moves: walk to each push's square,
  // then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = board.player;
  let boxes = board.boxes.slice();
  for (const s of path) {
    const nextBoxes = stateBoxes[s];
    const { box: from, dir } = madeBy[s];
    const step = dir.dy * w + dir.dx;
    for (const b of boxes) blocked[b] = 1;
    moves += shortestWalk(board, blocked, player, from - step);
    for (const b of boxes) blocked[b] = 0;
    moves += dir.push;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

interface Room {
  cells: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the
 * hallway — a box there reaches no goal) out of the floor, and each part
 * left that holds a box is a room. Null when some part holds more or fewer
 * boxes than goals, or a box starts in the hallway: then the level is no
 * set of rooms.
 */
function findRooms(board: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = board;
  const live = liveCells(board);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (wall[i] === 0 && live[i] === 0) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b] === 1)) return null;
  const comp = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] === 1 || cut[s] === 1 || comp[s] >= 0) continue;
    const cells: number[] = [s];
    comp[s] = rooms.length;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      for (const d of DIRS) {
        const q = c + d.dy * w + d.dx;
        if (q < 0 || q >= wall.length) continue;
        if (wall[q] === 0 && cut[q] === 0 && comp[q] < 0) {
          comp[q] = rooms.length;
          cells.push(q);
        }
      }
    }
    rooms.push({ cells, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) {
    if (comp[b] < 0) return null;
    rooms[comp[b]].boxes.push(b);
  }
  for (const g of goals) {
    if (comp[g] < 0) return null;
    rooms[comp[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in
 * turn, the other rooms' boxes standing as walls (on their goals once
 * their room is done), the player walking on from where the last room
 * left it. A box never leaves its room (a push through a door lands it in
 * the hallway, where it reaches no goal), so the rooms' optima add up to
 * the level's. Falls back to a search over the whole level when the level
 * is no set of rooms.
 */
function solveRooms(board: Board, deadlineMs: number): PushPlan | null {
  const rooms = findRooms(board);
  if (rooms === null) return solvePushes(board, MAX_ROOM_STATES, deadlineMs);
  let player = board.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = board.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      const squares = other.done ? other.goals : other.boxes;
      for (const s of squares) wall[s] = 1;
    }
    const sub: Board = {
      w: board.w,
      h: board.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushes(sub, MAX_ROOM_STATES, deadlineMs);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = afterMoves(board.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** One level's answer: its push-optimal move string, or '' when unsolved. */
function solveLevel(text: string, deadlineMs: number): string {
  const solved = solveRooms(parseBoard(text), deadlineMs);
  return solved === null ? '' : solved.moves;
}

function main(): void {
  const started = Date.now();
  const deadline = started + RUN_BUDGET_MS;
  for (const id of readdirSync(INPUT_DIR).sort()) {
    let moves = '';
    try {
      if (Date.now() - started < RUN_BUDGET_MS) {
        moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'), deadline);
      }
    } catch {
      moves = '';
    }
    mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
    writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), moves + '\n');
  }
}

main();
