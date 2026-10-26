import type { CourseId } from "./logic";

export interface PlatformSpec { x: number; top: number; z: number; width: number; depth: number; }
export interface SolidSpec { x: number; y: number; z: number; width: number; height: number; depth: number; kind: "platform" | "wall" | "beam" | "vault"; }
export interface CheckpointSpec { x: number; top: number; z: number; }
export interface TokenSpec { id: string; x: number; top: number; z: number; }
export interface HintSpec { z: number; text: string; }
export interface CourseSpec {
  id: CourseId; number: string; title: string; label: string; description: string; difficulty: string;
  spawn: { x: number; top: number; z: number }; startLineZ: number; finishZ: number; finishTop: number;
  platforms: PlatformSpec[]; walls: SolidSpec[]; obstacles: SolidSpec[];
  checkpoints: CheckpointSpec[]; tokens: TokenSpec[]; hints: HintSpec[];
  goldTime: number; silverTime: number; fallLimit: number;
}

const TRACK_LENGTH = 18_000;
const SEGMENT_STEP = 9.25;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Creates one deterministic, uninterrupted course. The geometry is generated once per load,
 * not randomly recolored or reshuffled during play, so route difficulty and visuals remain stable.
 */
export function generateLongCourse(): CourseSpec {
  let seed = 0x51a7c0de;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const finishZ = -TRACK_LENGTH;
  const segmentCount = Math.ceil(TRACK_LENGTH / SEGMENT_STEP);
  const platforms: PlatformSpec[] = [{ x: 0, top: 0, z: 5, width: 12, depth: 14 }];
  const walls: SolidSpec[] = [];
  const obstacles: SolidSpec[] = [];
  const checkpoints: CheckpointSpec[] = [];
  const tokens: TokenSpec[] = [];
  let x = 0;
  let top = 0;

  for (let i = 1; ; i++) {
    const z = 3.2 - i * SEGMENT_STEP;
    if (z <= finishZ + 6) break;
    const progress = clamp(i / segmentCount, 0, 1);

    // Keep lateral transitions readable early; progressively tighten the landing surface later.
    const maxSideStep = 0.42 + progress * 0.78;
    x = clamp(x + (random() * 2 - 1) * maxSideStep, -2.55, 2.55);
    const width = clamp(5.7 - progress * 2.7 + (random() - 0.5) * 0.45, 2.8, 5.9);
    const depth = clamp(7.5 - progress * 2.1 + (random() - 0.5) * 0.36, 5.15, 7.7);
    const maxRise = 0.3 + progress * 0.42;
    top = clamp(top + (random() - 0.5) * maxRise, 0, 3.25);
    platforms.push({ x, top, z, width, depth });

    // Checkpoints are part of this one route and are spaced about every 420 metres.
    if (i % Math.round(420 / SEGMENT_STEP) === 0) checkpoints.push({ x, top, z });

    // A collectible is a harmless optional route marker, not a gate or alternate objective.
    if (i % 33 === 9) tokens.push({ id: "marker-" + i, x, top, z });

    // Long side walls are deliberately positioned alongside landings for wall-running and wall-jumps.
    const wallCadence = progress < 0.4 ? 24 : progress < 0.75 ? 18 : 14;
    if (i > 7 && i % wallCadence === Math.floor(wallCadence / 2)) {
      const side = i % 2 === 0 ? -1 : 1;
      walls.push({
        x: x + side * (width / 2 + 0.43), y: top + 1.8,
        z: z - SEGMENT_STEP * 0.45, width: 0.34, height: 3.6,
        depth: SEGMENT_STEP * 1.62, kind: "wall"
      });
    }

    // Low crossbars teach sliding; lower barriers can be vaulted. Density rises later in the route.
    const obstacleCadence = Math.max(10, Math.round(21 - progress * 8));
    if (progress > 0.08 && i % obstacleCadence === 4) {
      obstacles.push({
        x, y: top + 1.31, z: z - 0.15,
        width: Math.max(2.15, width * (0.74 + progress * 0.1)),
        height: 0.28, depth: 0.32, kind: "beam"
      });
    } else if (progress > 0.2 && i % (obstacleCadence * 2) === 9) {
      obstacles.push({
        x, y: top + 0.68, z: z - 0.15,
        width: Math.max(1.6, width * 0.68), height: 1.22, depth: 0.5, kind: "vault"
      });
    }
  }

  // A wider landing gives the continuous route a clean and readable finish.
  platforms.push({ x, top, z: finishZ + 2, width: 12, depth: 15 });
  return {
    id: "line",
    number: "01",
    title: "THE LONG LINE",
    label: "CONTINUOUS / 01",
    description: "One continuous 18-kilometre first-person parkour course, with progressively harder traversal.",
    difficulty: "PROGRESSIVE",
    spawn: { x: 0, top: 0, z: 10 },
    startLineZ: 7.5,
    finishZ,
    finishTop: top,
    platforms,
    walls,
    obstacles,
    checkpoints,
    tokens,
    hints: [
      { z: 6, text: "ONE ROUTE. THE TIMER RUNS FROM THE START GATE TO THE FINISH." },
      { z: -160, text: "JUMP LATE AT THE EDGE. SPRINT HELPS CLEAR THE LONGER GAPS." },
      { z: -1_850, text: "WALL-RUN: KEEP MOVING FORWARD WHILE YOU STAY BESIDE A SIDE WALL." },
      { z: -4_100, text: "WALL-JUMP: TAP JUMP AGAIN WHILE THE WALL-RUN IS ACTIVE TO LAUNCH AWAY." },
      { z: -6_450, text: "LANDINGS NARROW GRADUALLY. AIM FOR THE MIDDLE, THEN REBUILD SPEED." },
      { z: -8_900, text: "SLIDE UNDER THE LOW CROSSBARS; VAULT THE SHORT BARRIERS WHEN CLOSE." },
      { z: -11_400, text: "CHECKPOINTS ARE AUTOMATIC. A FALL RETURNS YOU TO THE LAST ONE." },
      { z: -14_000, text: "THE LATER ROUTE NEEDS CLEANER LINES, LATER JUMPS, AND QUICK WALL TRANSFERS." },
      { z: -16_500, text: "FINAL STRETCH. KEEP YOUR MOMENTUM AND LOOK FOR THE FINISH GATE." }
    ],
    goldTime: 20 * 60 * 1000,
    silverTime: 40 * 60 * 1000,
    fallLimit: -22
  };
}

export const LONG_COURSE_LENGTH = TRACK_LENGTH;
