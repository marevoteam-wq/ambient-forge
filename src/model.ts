export const EXTENSION_ID = "com.cucumber.ambient-forge";
export const CHANNEL = `${EXTENSION_ID}/sync`;
export const LOCAL_CHANNEL = `${EXTENSION_ID}/local`;
export const MAX_SYNC_MESSAGE_BYTES = 15 * 1024;

export const LIBRARY_LIMITS = {
  folders: 200,
  scenes: 500,
  tracksPerScene: 50,
  totalTracks: 2000,
  activeScenes: 50,
  nameLength: 80,
  iconLength: 32,
  idLength: 128,
  urlLength: 2048,
} as const;

export type OutputScope = "GLOBAL" | "LOCAL";
export type SourceKind = "auto" | "audio" | "youtube";

export interface Track {
  id: string;
  name: string;
  url: string;
  kind: SourceKind;
  volume: number;
  muted: boolean;
  loop: boolean;
  delayMin: number;
  delayMax: number;
}

export interface Scene {
  id: string;
  folderId: string;
  name: string;
  icon: string;
  color: string;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  tracks: Track[];
}

export interface Folder {
  id: string;
  name: string;
  color: string;
  icon?: string;
}

export interface Library {
  version: 1;
  folders: Folder[];
  scenes: Scene[];
}

export interface ActiveScene {
  scene: Scene;
  startedAt: number;
  pausedAt?: number;
}

export interface PlaybackState {
  version: 1;
  revision: number;
  status: "playing" | "paused";
  scope: OutputScope;
  updatedAt: number;
  pausedAt?: number;
  active: ActiveScene[];
}

export type SyncMessage = { type: "STATE"; state: PlaybackState } | { type: "REQUEST_STATE" };
export type LocalMessage =
  | { type: "UNLOCK" }
  | { type: "PREVIEW"; scene: Scene }
  | { type: "STOP_PREVIEW" }
  | { type: "MASTER"; volume: number; muted: boolean };

export const emptyState = (): PlaybackState => ({
  version: 1,
  revision: 0,
  status: "playing",
  scope: "GLOBAL",
  updatedAt: Date.now(),
  active: [],
});

export const starterLibrary = (): Library => {
  const folderId = crypto.randomUUID();
  return {
    version: 1,
    folders: [{ id: folderId, name: "My scenes", color: "#8b6ff7" }],
    scenes: [],
  };
};

export function sourceKind(track: Track): "audio" | "youtube" {
  if (track.kind !== "auto") return track.kind;
  try {
    const hostname = new URL(track.url).hostname.toLowerCase();
    return hostname === "youtu.be" || hostname === "youtube.com" || hostname.endsWith(".youtube.com") ? "youtube" : "audio";
  } catch { return "audio"; }
}

export function validSourceUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > LIBRARY_LIMITS.urlLength) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:")
      && !!url.hostname
      && !url.username
      && !url.password;
  } catch { return false; }
}

export function youtubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "youtu.be") return parsed.pathname.slice(1).split("/")[0] || null;
    if (hostname !== "youtube.com" && !hostname.endsWith(".youtube.com")) return null;
    if (parsed.pathname.startsWith("/shorts/")) return parsed.pathname.split("/")[2] || null;
    if (parsed.pathname.startsWith("/embed/")) return parsed.pathname.split("/")[2] || null;
    return parsed.searchParams.get("v");
  } catch { return null; }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= LIBRARY_LIMITS.idLength
    && /^[a-z0-9._:-]+$/i.test(value);
}

function validName(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= LIBRARY_LIMITS.nameLength;
}

function validIcon(value: unknown): value is string {
  return typeof value === "string" && value.length <= LIBRARY_LIMITS.iconLength;
}

function validColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function numberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validTrack(value: unknown): value is Track {
  const track = record(value);
  return !!track
    && validId(track.id)
    && validName(track.name)
    && validSourceUrl(track.url)
    && (track.kind === "auto" || track.kind === "audio" || track.kind === "youtube")
    && numberInRange(track.volume, 0, 100)
    && typeof track.muted === "boolean"
    && typeof track.loop === "boolean"
    && numberInRange(track.delayMin, 0, 3600)
    && numberInRange(track.delayMax, 0, 3600);
}

export function validScene(value: unknown): value is Scene {
  const scene = record(value);
  if (!scene
    || !validId(scene.id)
    || !validId(scene.folderId)
    || !validName(scene.name)
    || !validIcon(scene.icon)
    || !validColor(scene.color)
    || !numberInRange(scene.volume, 0, 100)
    || !numberInRange(scene.fadeIn, 0, 30)
    || !numberInRange(scene.fadeOut, 0, 30)
    || !Array.isArray(scene.tracks)
    || scene.tracks.length < 1
    || scene.tracks.length > LIBRARY_LIMITS.tracksPerScene
    || !scene.tracks.every(validTrack)) return false;
  return new Set(scene.tracks.map(track => track.id)).size === scene.tracks.length;
}

export function validLibrary(value: unknown): value is Library {
  const data = record(value);
  if (!data
    || data.version !== 1
    || !Array.isArray(data.folders)
    || !Array.isArray(data.scenes)
    || data.folders.length < 1
    || data.folders.length > LIBRARY_LIMITS.folders
    || data.scenes.length > LIBRARY_LIMITS.scenes) return false;

  const foldersValid = data.folders.every(value => {
    const folder = record(value);
    return !!folder
      && validId(folder.id)
      && validName(folder.name)
      && validColor(folder.color)
      && (folder.icon === undefined || validIcon(folder.icon));
  });
  if (!foldersValid) return false;

  const folderIds = new Set(data.folders.map(folder => folder.id));
  if (folderIds.size !== data.folders.length) return false;
  if (!data.scenes.every(scene => validScene(scene) && folderIds.has(scene.folderId))) return false;
  if (new Set(data.scenes.map(scene => scene.id)).size !== data.scenes.length) return false;
  return data.scenes.reduce((total, scene) => total + scene.tracks.length, 0) <= LIBRARY_LIMITS.totalTracks;
}

export function validPlaybackState(value: unknown): value is PlaybackState {
  const state = record(value);
  if (!state
    || state.version !== 1
    || !Number.isSafeInteger(state.revision)
    || (state.revision as number) < 0
    || (state.status !== "playing" && state.status !== "paused")
    || (state.scope !== "GLOBAL" && state.scope !== "LOCAL")
    || !numberInRange(state.updatedAt, 0, Number.MAX_SAFE_INTEGER)
    || (state.pausedAt !== undefined && !numberInRange(state.pausedAt, 0, Number.MAX_SAFE_INTEGER))
    || !Array.isArray(state.active)
    || state.active.length > LIBRARY_LIMITS.activeScenes) return false;

  const activeValid = state.active.every(value => {
    const active = record(value);
    return !!active
      && validScene(active.scene)
      && numberInRange(active.startedAt, 0, Number.MAX_SAFE_INTEGER)
      && (active.pausedAt === undefined || numberInRange(active.pausedAt, 0, Number.MAX_SAFE_INTEGER));
  });
  return activeValid
    && new Set(state.active.map(active => active.scene.id)).size === state.active.length
    && state.active.reduce((total, active) => total + active.scene.tracks.length, 0) <= LIBRARY_LIMITS.totalTracks;
}

export function syncMessageSize(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { return Number.POSITIVE_INFINITY; }
}

export function validSyncMessage(value: unknown): value is SyncMessage {
  const message = record(value);
  return !!message
    && syncMessageSize(value) <= MAX_SYNC_MESSAGE_BYTES
    && (message.type === "REQUEST_STATE" || (message.type === "STATE" && validPlaybackState(message.state)));
}

export function validLocalMessage(value: unknown): value is LocalMessage {
  const message = record(value);
  if (!message || typeof message.type !== "string" || syncMessageSize(value) > MAX_SYNC_MESSAGE_BYTES) return false;
  if (message.type === "UNLOCK" || message.type === "STOP_PREVIEW") return true;
  if (message.type === "PREVIEW") return validScene(message.scene);
  return message.type === "MASTER"
    && numberInRange(message.volume, 0, 100)
    && typeof message.muted === "boolean";
}
