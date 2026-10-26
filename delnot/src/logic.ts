export type CourseId = "line";
export type Medal = "PLATINUM" | "GOLD" | "SILVER" | "BRONZE" | "PRACTICE";

export interface SaveData {
  version: 1;
  unlocked: CourseId[];
  best: Partial<Record<CourseId, number>>;
  medals: Partial<Record<CourseId, Medal>>;
  collected: string[];
}

export interface GameSettings {
  version: 1;
  sensitivity: number;
  fov: number;
  quality: "low" | "medium" | "high" | "ultra";
  masterVolume: number;
  musicVolume: number;
  effectsVolume: number;
  cameraEffects: boolean;
  reducedMotion: boolean;
  showHud: boolean;
}

export const DEFAULT_SETTINGS: GameSettings = {
  version: 1, sensitivity: 0.85, fov: 82, quality: "high",
  masterVolume: 0.75, musicVolume: 0.28, effectsVolume: 0.72,
  cameraEffects: true, reducedMotion: false, showHud: true
};

export const DEFAULT_SAVE: SaveData = {
  version: 1, unlocked: ["line"], best: {}, medals: {}, collected: []
};

const COURSE_IDS: CourseId[] = ["line"];
const MEDALS: Medal[] = ["PLATINUM", "GOLD", "SILVER", "BRONZE", "PRACTICE"];
const QUALITY = ["low", "medium", "high", "ultra"] as const;

export function formatTime(milliseconds: number): string {
  const safe = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  const totalCentiseconds = Math.floor(safe / 10);
  const minutes = Math.floor(totalCentiseconds / 6000);
  const seconds = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0") + "." + String(centiseconds).padStart(2, "0");
}

export function normalizeJoystick(dx: number, dy: number, radius: number): { x: number; y: number } {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(radius) || radius <= 0) return { x: 0, y: 0 };
  const distance = Math.hypot(dx, dy);
  if (distance <= radius * 0.12) return { x: 0, y: 0 };
  const scale = Math.min(1, radius / distance) / radius;
  return { x: dx * scale, y: dy * scale };
}

export function progressBetween(positionZ: number, startZ: number, finishZ: number): number {
  const span = startZ - finishZ;
  if (!Number.isFinite(positionZ) || !Number.isFinite(startZ) || !Number.isFinite(finishZ) || span <= 0) return 0;
  return Math.min(1, Math.max(0, (startZ - positionZ) / span));
}

export function medalForTime(milliseconds: number, goldThreshold: number, silverThreshold: number): Medal {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "BRONZE";
  if (milliseconds <= goldThreshold * 0.72) return "PLATINUM";
  if (milliseconds <= goldThreshold) return "GOLD";
  if (milliseconds <= silverThreshold) return "SILVER";
  return "BRONZE";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeSave(value: unknown): SaveData {
  const output: SaveData = { version: 1, unlocked: ["line"], best: {}, medals: {}, collected: [] };
  if (!isRecord(value)) return output;
  if (Array.isArray(value.unlocked)) {
    const unlocked = value.unlocked.filter((id): id is CourseId => typeof id === "string" && COURSE_IDS.includes(id as CourseId));
    output.unlocked = Array.from(new Set(["line" as CourseId, ...unlocked]));
  }
  if (isRecord(value.best)) {
    for (const id of COURSE_IDS) {
      const time = value.best[id];
      if (typeof time === "number" && Number.isFinite(time) && time > 0 && time < 24 * 60 * 60 * 1000) output.best[id] = time;
    }
  }
  if (isRecord(value.medals)) {
    for (const id of COURSE_IDS) {
      const medal = value.medals[id];
      if (typeof medal === "string" && MEDALS.includes(medal as Medal)) output.medals[id] = medal as Medal;
    }
  }
  if (Array.isArray(value.collected)) {
    output.collected = Array.from(new Set(value.collected.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length < 100).slice(0, 500)));
  }
  return output;
}

export function parseSave(raw: string | null): SaveData {
  if (!raw) return normalizeSave(null);
  try { return normalizeSave(JSON.parse(raw) as unknown); }
  catch { return normalizeSave(null); }
}

export function normalizeSettings(value: unknown): GameSettings {
  const result = { ...DEFAULT_SETTINGS };
  if (!isRecord(value)) return result;
  const bounded = (key: string, fallback: number, min: number, max: number): number => {
    const candidate = value[key];
    return typeof candidate === "number" && Number.isFinite(candidate) ? Math.min(max, Math.max(min, candidate)) : fallback;
  };
  result.sensitivity = bounded("sensitivity", result.sensitivity, 0.1, 2.5);
  result.fov = bounded("fov", result.fov, 65, 105);
  result.masterVolume = bounded("masterVolume", result.masterVolume, 0, 1);
  result.musicVolume = bounded("musicVolume", result.musicVolume, 0, 1);
  result.effectsVolume = bounded("effectsVolume", result.effectsVolume, 0, 1);
  if (typeof value.quality === "string" && QUALITY.includes(value.quality as GameSettings["quality"])) result.quality = value.quality as GameSettings["quality"];
  if (typeof value.cameraEffects === "boolean") result.cameraEffects = value.cameraEffects;
  if (typeof value.reducedMotion === "boolean") result.reducedMotion = value.reducedMotion;
  if (typeof value.showHud === "boolean") result.showHud = value.showHud;
  return result;
}

export function parseSettings(raw: string | null): GameSettings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  try { return normalizeSettings(JSON.parse(raw) as unknown); }
  catch { return { ...DEFAULT_SETTINGS }; }
}
