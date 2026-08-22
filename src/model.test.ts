import { describe, expect, it } from "vitest";
import {
  LIBRARY_LIMITS, MAX_SYNC_MESSAGE_BYTES, Library, PlaybackState, Scene, syncMessageSize,
  validLibrary, validLocalMessage, validPlaybackState, validSourceUrl, validSyncMessage,
} from "./model";

const folder = { id: "folder-1", name: "Forest", color: "#20aa70", icon: "🌲" };
const track = {
  id: "track-1", name: "Rain", url: "https://example.com/rain.ogg", kind: "audio" as const,
  volume: 70, muted: false, loop: true, delayMin: 0, delayMax: 0,
};
const scene: Scene = {
  id: "scene-1", folderId: folder.id, name: "Rainy forest", icon: "🌧️", color: "#20aa70",
  volume: 80, fadeIn: 1, fadeOut: 3, tracks: [track],
};
const library: Library = { version: 1, folders: [folder], scenes: [scene] };
const playback: PlaybackState = {
  version: 1, revision: 1, status: "playing", scope: "GLOBAL", updatedAt: Date.now(),
  active: [{ scene, startedAt: Date.now() }],
};

describe("library validation", () => {
  it("accepts a valid library", () => expect(validLibrary(library)).toBe(true));

  it("rejects injectable colors and unsafe source schemes", () => {
    expect(validLibrary({ ...library, folders: [{ ...folder, color: `red\" onmouseover=\"alert(1)` }] })).toBe(false);
    expect(validSourceUrl("javascript:alert(1)")).toBe(false);
    expect(validSourceUrl("https://user:secret@example.com/file.mp3")).toBe(false);
  });

  it("rejects duplicate IDs, orphaned scenes, and oversized collections", () => {
    expect(validLibrary({ ...library, folders: [folder, folder] })).toBe(false);
    expect(validLibrary({ ...library, scenes: [{ ...scene, folderId: "missing" }] })).toBe(false);
    expect(validLibrary({ ...library, folders: Array.from({ length: LIBRARY_LIMITS.folders + 1 }, (_, index) => ({ ...folder, id: `folder-${index}` })) })).toBe(false);
  });
});

describe("message validation", () => {
  it("accepts valid playback and sync messages", () => {
    expect(validPlaybackState(playback)).toBe(true);
    expect(validSyncMessage({ type: "STATE", state: playback })).toBe(true);
    expect(validSyncMessage({ type: "REQUEST_STATE" })).toBe(true);
  });

  it("rejects malformed remote and local messages", () => {
    expect(validSyncMessage({ type: "STATE", state: { ...playback, revision: -1 } })).toBe(false);
    expect(validLocalMessage({ type: "MASTER", volume: 500, muted: false })).toBe(false);
    expect(validLocalMessage({ type: "PREVIEW", scene: { ...scene, tracks: [] } })).toBe(false);
  });

  it("rejects messages above Owlbear Rodeo's 16KB broadcast limit", () => {
    const oversized = { type: "STATE", state: { ...playback, active: [{ scene: { ...scene, name: "x".repeat(MAX_SYNC_MESSAGE_BYTES) }, startedAt: Date.now() }] } };
    expect(syncMessageSize(oversized)).toBeGreaterThan(MAX_SYNC_MESSAGE_BYTES);
    expect(validSyncMessage(oversized)).toBe(false);
  });
});
