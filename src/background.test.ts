import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL, LOCAL_CHANNEL, Scene, emptyState } from "./model";

const sdk = vi.hoisted(() => ({
  ready: null as null | (() => Promise<void>),
  handlers: {} as Record<string, (event: { data: unknown }) => void>,
}));

vi.mock("@owlbear-rodeo/sdk", () => ({
  default: {
    onReady: (callback: () => Promise<void>) => { sdk.ready = callback; },
    player: { getRole: async () => "GM" },
    broadcast: {
      onMessage: (channel: string, callback: (event: { data: unknown }) => void) => { sdk.handlers[channel] = callback; },
      sendMessage: async () => undefined,
    },
  },
}));

class FakeAudio {
  static instances: FakeAudio[] = [];
  readonly listeners = new Map<string, () => void>();
  volume = 1;
  muted = false;
  loop = false;
  preload = "";
  duration = 60;
  currentTime = 0;
  paused = true;
  playCalls = 0;

  constructor(readonly src: string) { FakeAudio.instances.push(this); }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
  emit(name: string) { this.listeners.get(name)?.(); }
  play() { this.paused = false; this.playCalls += 1; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute(_name: string) { /* no-op */ }
}

class FakeYouTubePlayer {
  static instances: FakeYouTubePlayer[] = [];
  volume = 100;
  muted = false;
  playCalls = 0;
  readonly onReady: () => void;

  constructor(_host: HTMLElement, options: { events: { onReady: () => void } }) {
    this.onReady = options.events.onReady;
    FakeYouTubePlayer.instances.push(this);
  }
  playVideo() { this.playCalls += 1; }
  pauseVideo() { /* no-op */ }
  stopVideo() { /* no-op */ }
  destroy() { /* no-op */ }
  setVolume(value: number) { this.volume = value; }
  mute() { this.muted = true; }
  unMute() { this.muted = false; }
  seekTo(_seconds: number, _allowSeekAhead: boolean) { /* no-op */ }
}

const scene = (id: string, youtube = false): Scene => ({
  id, folderId: "folder", name: id, icon: "♫", color: "#8b6ff7",
  volume: 100, fadeIn: 0, fadeOut: 2,
  tracks: [{
    id, name: id,
    url: youtube ? `https://www.youtube.com/watch?v=${id.repeat(11)}` : `https://example.com/${id}.mp3`,
    kind: youtube ? "youtube" : "audio", volume: 100, muted: false,
    loop: true, delayMin: 0, delayMax: 0,
  }],
});

let revision: number;
function state(scenes: Scene[]) {
  revision += 1;
  sdk.handlers[CHANNEL]({ data: {
    type: "STATE",
    state: {
      ...emptyState(), revision, updatedAt: Date.now(),
      active: scenes.map(item => ({ scene: item, startedAt: 1_000 })),
    },
  } });
}
function local(data: unknown) { sdk.handlers[LOCAL_CHANNEL]({ data }); }
async function flush() { await Promise.resolve(); await Promise.resolve(); }

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(10_000));
  sdk.ready = null;
  sdk.handlers = {};
  FakeAudio.instances = [];
  FakeYouTubePlayer.instances = [];
  revision = 0;
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  });
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("YT", { Player: FakeYouTubePlayer });
  vi.stubGlobal("document", {
    createElement: () => ({ style: { cssText: "" }, remove: () => undefined }),
    getElementById: () => ({ append: () => undefined }),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  await import("./background");
  const ready = sdk.ready as null | (() => Promise<void>);
  if (!ready) throw new Error("Background did not register onReady");
  await ready();
  local({ type: "UNLOCK" });
  await flush();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("background playback", () => {
  it("keeps other audio playing and fades only the stopped scene", async () => {
    state([scene("a"), scene("b")]);
    await flush();
    const [first, second] = FakeAudio.instances.filter(item => item.src.startsWith("https:"));
    first.emit("loadedmetadata");
    second.emit("loadedmetadata");
    state([scene("b")]);
    expect(second.playCalls).toBe(1);
    expect(second.paused).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(first.volume).toBeLessThan(second.volume);
    vi.advanceTimersByTime(1_200);
    expect(first.paused).toBe(true);
    expect(second.paused).toBe(false);
  });

  it("removes an old fade before rapidly restarting the same audio", async () => {
    state([scene("a")]);
    await flush();
    const first = FakeAudio.instances.find(item => item.src.endsWith("/a.mp3"))!;
    first.emit("loadedmetadata");
    state([]);
    vi.advanceTimersByTime(200);
    expect(first.paused).toBe(false);
    state([scene("a")]);
    await flush();
    const second = FakeAudio.instances.filter(item => item.src.endsWith("/a.mp3"))[1];
    second.emit("loadedmetadata");
    expect(first.paused).toBe(true);
    expect(second.paused).toBe(false);
  });

  it("does not replay an unaffected YouTube track and hard-mutes it at zero", async () => {
    state([scene("a", true), scene("b", true)]);
    await flush();
    const [first, second] = FakeYouTubePlayer.instances;
    first.onReady();
    second.onReady();
    state([scene("b", true)]);
    expect(second.playCalls).toBe(1);
    local({ type: "MASTER", volume: 0, muted: false, revision: 1 });
    vi.advanceTimersByTime(200);
    expect(second.volume).toBe(0);
    expect(second.muted).toBe(true);
  });
});
