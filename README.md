# Kestrel Sokoban — a push-optimal solver, room by room

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/zicloed/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/zicloed/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A Sokoban solver that answers every level of a set push-optimally. It
reads each level in XSB (`#` wall, space floor, `.` goal, `$` box, `*`
box on a goal, `@` player) and writes the player's moves (`u`/`d`/`l`/`r`,
upper case marking a push) to `solution.txt`.

## How it works

The levels this contest draws are built from one hallway with rooms off
it, and a box that leaves its room can never come back, so the whole
level's push-optimum is the sum of its rooms' optima. The solver:

1. **Cuts the level into rooms** — it drops the dead squares of the
   player's row (the hallway: a box there reaches no goal) out of the
   floor, and each remaining part holding boxes is a room.
2. **Solves each room push-optimally** with a breadth-first search over
   pushes. A state is the boxes' squares plus the player's reachable
   region (named by its lowest square), so the first solved state met is
   optimal. Two deadlocks are pruned: a box pushed onto a dead square
   (found by pulling backwards from the goals) and a box pushed into a
   frozen 2x2 block.
3. **Stitches the rooms together** — the other rooms' boxes stand as
   walls while one room is solved (on their goals once their room is
   done), and the player walks on from where the last room left it.

A room of three or four boxes in a 6x6 slot is a small search; a whole
set of five levels answers in about a second, far inside the 60-second
budget. The search also carries a state cap and a wall-clock deadline,
so a pathological room gives up instead of eating the run.

## Practice score

On the kit's practice set it solves all five levels at exactly their
push-optimal counts (13, 16, 29, 47 and 60 pushes) — 1,000 points each,
score **1,000,000**, the maximum.

## Run it

```
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` is the entrypoint (Node 22, stdlib only — no packages). It
reads every instance under the input directory and writes
`<output>/<id>/solution.txt` for each.

## Entry

Built for the make.fun bounty
[Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121).
