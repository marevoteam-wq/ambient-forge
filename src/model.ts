export const EXTENSION_ID = "com.cucumber.ambient-forge";
export const STATE_KEY = `${EXTENSION_ID}/playback`;
export const CHANNEL = `${EXTENSION_ID}/sync`;
export const LOCAL_CHANNEL = `${EXTENSION_ID}/local`;

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
  return /(?:youtube\.com|youtu\.be)/i.test(track.url) ? "youtube" : "audio";
}

export function youtubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtu.be")) return parsed.pathname.slice(1).split("/")[0] || null;
    if (parsed.pathname.startsWith("/shorts/")) return parsed.pathname.split("/")[2] || null;
    if (parsed.pathname.startsWith("/embed/")) return parsed.pathname.split("/")[2] || null;
    return parsed.searchParams.get("v");
  } catch { return null; }
}

export function validLibrary(value: unknown): value is Library {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<Library>;
  return data.version === 1 && Array.isArray(data.folders) && Array.isArray(data.scenes);
}
