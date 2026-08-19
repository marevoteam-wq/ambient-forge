import { Library, Scene, Track, validLibrary } from "./model";

type JsonRecord = Record<string, unknown>;

export interface ImportedLibrary {
  library: Library;
  format: "Ambient Forge" | "Djinni";
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function number(value: unknown, fallback: number, min = 0, max = 100): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(Math.min(max, Math.max(min, parsed))) : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stableId(prefix: string, ...parts: unknown[]): string {
  return `${prefix}-${parts.map(part => String(part).replace(/[^a-z0-9_-]+/gi, "-")).join("-")}`;
}

function convertDjinniTrack(value: unknown, folderId: string, sceneId: string, index: number, sceneMuted: boolean): Track | null {
  const track = record(value);
  if (!track) return null;
  const url = text(track.link, "");
  if (!url) return null;
  return {
    id: stableId("djinni-track", folderId, sceneId, track.id ?? index),
    name: text(track.name, `Track ${index + 1}`),
    url,
    kind: "auto",
    volume: number(track.volume, 100),
    muted: sceneMuted || boolean(track.mute, false),
    loop: boolean(track.loop, true),
    delayMin: number(track.loop1, 0, 0, 3600),
    delayMax: number(track.loop2, 0, 0, 3600),
  };
}

function convertDjinniScene(value: unknown, folderId: string, color: string, index: number): Scene | null {
  const stream = record(value);
  if (!stream) return null;
  const sceneId = stableId("djinni-scene", folderId, stream.id ?? index);
  const sceneMuted = boolean(stream.streamMute, false);
  const tracks = Array.isArray(stream.streamData)
    ? stream.streamData.map((track, trackIndex) => convertDjinniTrack(track, folderId, sceneId, trackIndex, sceneMuted)).filter((track): track is Track => !!track)
    : [];
  if (!tracks.length) return null;
  const fade = boolean(stream.streamFade, false) ? number(stream.streamFadeTime, 0, 0, 30) : 0;
  return {
    id: sceneId,
    folderId,
    name: text(stream.streamName, `Scene ${index + 1}`),
    icon: text(stream.streamIcon, "♫"),
    color,
    volume: number(stream.streamVolume, 100),
    fadeIn: fade,
    fadeOut: fade,
    tracks,
  };
}

function convertDjinni(value: unknown): Library | null {
  const source = record(value);
  if (!source) return null;
  const folders: Library["folders"] = [];
  const scenes: Scene[] = [];
  const seenSourceIds = new Set<string>();

  Object.entries(source).forEach(([key, value]) => {
    const folder = record(value);
    if (!folder || !Array.isArray(folder.streams) || typeof folder.folderName !== "string") return;
    const sourceId = String(folder.id ?? key);
    if (seenSourceIds.has(sourceId)) return;
    seenSourceIds.add(sourceId);
    const id = stableId("djinni-folder", sourceId);
    const color = /^#[0-9a-f]{6}$/i.test(String(folder.folderColor || "")) ? String(folder.folderColor) : "#8b6ff7";
    folders.push({ id, name: text(folder.folderName, `Folder ${folders.length + 1}`), color });
    folder.streams.forEach((stream, index) => {
      const scene = convertDjinniScene(stream, id, color, index);
      if (scene) scenes.push(scene);
    });
  });

  return folders.length ? { version: 1, folders, scenes } : null;
}

export function parseImportedLibrary(value: unknown): ImportedLibrary {
  if (validLibrary(value)) return { library: value, format: "Ambient Forge" };
  const djinni = convertDjinni(value);
  if (djinni) return { library: djinni, format: "Djinni" };
  throw new Error("Unsupported library format");
}
