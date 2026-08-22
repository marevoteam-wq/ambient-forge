import OBR from "@owlbear-rodeo/sdk";
import {
  CHANNEL, LOCAL_CHANNEL, ActiveScene, PlaybackState, Scene, SyncMessage, Track,
  emptyState, sourceKind, validLocalMessage, validSyncMessage, youtubeId,
} from "./model";

interface YTPlayer {
  playVideo(): void; pauseVideo(): void; stopVideo(): void; destroy(): void;
  setVolume(value: number): void; mute(): void; unMute(): void; seekTo(seconds: number, allowSeekAhead: boolean): void;
}
interface YTNamespace {
  Player: new (element: HTMLElement, options: Record<string, unknown>) => YTPlayer;
}
declare global { interface Window { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void } }

type Runtime = {
  key: string;
  scene: Scene;
  track: Track;
  startedAt: number;
  preview: boolean;
  source: string;
  audio?: HTMLAudioElement;
  player?: YTPlayer;
  host?: HTMLDivElement;
  fade?: number;
  retry?: number;
  ready: boolean;
  gain: number;
  paused: boolean;
  retiring: boolean;
  destroyed: boolean;
};

type PendingRuntime = {
  token: symbol;
  key: string;
  active: ActiveScene;
  track: Track;
  preview: boolean;
  previewRevision: number;
  source: string;
};

const runtimes = new Map<string, Runtime>();
const liveRuntimes = new Set<Runtime>();
const pendingRuntimes = new Map<string, PendingRuntime>();
let role: "GM" | "PLAYER" = "PLAYER";
let current = emptyState();
let preview: Scene | null = null;
let previewRevision = 0;
let master = { volume: 80, muted: false };
let masterLevel = 0.8;
let masterFade: number | undefined;
let ytReady: Promise<void> | null = null;
let audioUnlocked = false;

function loadMaster() {
  try {
    const value = JSON.parse(localStorage.getItem("ambient-forge-master") || "null") as typeof master | null;
    if (value && typeof value.volume === "number" && value.volume >= 0 && value.volume <= 100 && typeof value.muted === "boolean") {
      master = value;
    }
  } catch { /* ignored */ }
  masterLevel = master.muted ? 0 : master.volume / 100;
}

function ensureYouTube(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = resolve;
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => {
      ytReady = null;
      reject(new Error("YouTube iframe API failed to load"));
    };
    document.head.append(script);
  });
  return ytReady;
}

function runtimeVolume(runtime: Runtime): number {
  const value = masterLevel * runtime.scene.volume / 100 * runtime.track.volume / 100 * runtime.gain;
  return Math.max(0, Math.min(1, value));
}

function applyVolume(runtime: Runtime) {
  if (runtime.destroyed) return;
  const volume = runtimeVolume(runtime);
  const muted = runtime.track.muted || (master.muted && masterLevel <= 0.001);
  if (runtime.audio) {
    runtime.audio.volume = volume;
    runtime.audio.muted = muted;
  }
  if (runtime.player) {
    runtime.player.setVolume(volume * 100);
    if (muted) runtime.player.mute(); else runtime.player.unMute();
  }
}

function rampMaster(next: typeof master) {
  master = next;
  localStorage.setItem("ambient-forge-master", JSON.stringify(master));
  if (masterFade) cancelAnimationFrame(masterFade);
  const from = masterLevel;
  const to = master.muted ? 0 : master.volume / 100;
  const began = performance.now();
  const step = (now: number) => {
    const progress = Math.min(1, (now - began) / 140);
    const eased = 1 - (1 - progress) ** 3;
    masterLevel = from + (to - from) * eased;
    for (const runtime of liveRuntimes) applyVolume(runtime);
    if (progress < 1) masterFade = requestAnimationFrame(step);
    else {
      masterFade = undefined;
      masterLevel = to;
      for (const runtime of liveRuntimes) applyVolume(runtime);
    }
  };
  masterFade = requestAnimationFrame(step);
}

function seekOffset(startedAt: number, duration?: number): number {
  const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
  return duration && Number.isFinite(duration) && duration > 0 ? elapsed % duration : elapsed;
}

function shouldPlay(runtime: Runtime): boolean {
  return audioUnlocked && liveRuntimes.has(runtime) && !runtime.retiring && !runtime.paused && (runtime.preview || current.status === "playing");
}

function syncPlayback(runtime: Runtime) {
  if (runtime.destroyed || !runtime.ready) return;
  if (shouldPlay(runtime)) {
    if (runtime.audio) void runtime.audio.play().catch(() => undefined);
    runtime.player?.playVideo();
  } else {
    runtime.audio?.pause();
    runtime.player?.pauseVideo();
  }
}

function scheduleRandomRepeat(runtime: Runtime) {
  if (!runtime.track.loop || runtime.track.delayMax <= 0 || runtime.retiring || runtime.destroyed) return;
  const min = Math.max(0, runtime.track.delayMin);
  const max = Math.max(min, runtime.track.delayMax);
  const delay = (min + Math.random() * (max - min)) * 1000;
  runtime.retry = window.setTimeout(() => {
    runtime.retry = undefined;
    if (!shouldPlay(runtime)) return;
    if (runtime.audio) { runtime.audio.currentTime = 0; void runtime.audio.play().catch(() => undefined); }
    if (runtime.player) { runtime.player.seekTo(0, true); runtime.player.playVideo(); }
  }, delay);
}

function createAudio(scene: Scene, track: Track, startedAt: number, key: string, previewMode: boolean, paused: boolean): Runtime {
  const audio = new Audio(track.url);
  audio.preload = "auto";
  audio.loop = track.loop && track.delayMax === 0;
  const runtime: Runtime = {
    key, scene, track, startedAt, preview: previewMode,
    source: `${sourceKind(track)}:${track.url}`, audio, ready: false,
    gain: 1, paused, retiring: false, destroyed: false,
  };
  audio.addEventListener("loadedmetadata", () => {
    runtime.ready = true;
    if (track.loop) audio.currentTime = seekOffset(startedAt, audio.duration);
    applyVolume(runtime);
    syncPlayback(runtime);
  });
  audio.addEventListener("ended", () => scheduleRandomRepeat(runtime));
  audio.addEventListener("error", () => console.warn("Ambient Forge: audio source failed", track.url));
  applyVolume(runtime);
  return runtime;
}

async function createYouTube(scene: Scene, track: Track, startedAt: number, key: string, previewMode: boolean, paused: boolean): Promise<Runtime | null> {
  const videoId = youtubeId(track.url);
  if (!videoId) return null;
  await ensureYouTube();
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;width:1px;height:1px;left:-9999px;top:-9999px";
  document.getElementById("audio-root")?.append(host);
  const runtime: Runtime = {
    key, scene, track, startedAt, preview: previewMode,
    source: `${sourceKind(track)}:${track.url}`, host, ready: false,
    gain: 1, paused, retiring: false, destroyed: false,
  };
  runtime.player = new window.YT!.Player(host, {
    videoId,
    playerVars: { autoplay: 0, controls: 0, disablekb: 1, playsinline: 1 },
    events: {
      onReady: () => {
        runtime.ready = true;
        runtime.player?.seekTo(seekOffset(startedAt), true);
        applyVolume(runtime);
        syncPlayback(runtime);
      },
      onStateChange: (event: { data: number }) => {
        if (event.data !== 0 || runtime.retiring || runtime.destroyed || !liveRuntimes.has(runtime)) return;
        if (track.loop && track.delayMax === 0 && shouldPlay(runtime)) {
          runtime.player?.seekTo(0, true);
          runtime.player?.playVideo();
        } else scheduleRandomRepeat(runtime);
      },
      onError: (event: unknown) => console.warn("Ambient Forge: YouTube source failed", event, track.url),
    },
  });
  return runtime;
}

function requestIsCurrent(request: PendingRuntime): boolean {
  if (pendingRuntimes.get(request.key) !== request) return false;
  if (request.preview) {
    return request.previewRevision === previewRevision
      && preview?.id === request.active.scene.id
      && preview.tracks.some(track => track.id === request.track.id && `${sourceKind(track)}:${track.url}` === request.source);
  }
  const allowed = current.scope === "GLOBAL" || role === "GM";
  if (!allowed) return false;
  const active = current.active.find(item => item.scene.id === request.active.scene.id && item.startedAt === request.active.startedAt);
  const track = active?.scene.tracks.find(item => item.id === request.track.id);
  return !!track && `${sourceKind(track)}:${track.url}` === request.source;
}

function fade(runtime: Runtime, from: number, to: number, duration: number, done?: () => void) {
  if (runtime.fade) clearInterval(runtime.fade);
  runtime.gain = from;
  applyVolume(runtime);
  const began = performance.now();
  runtime.fade = window.setInterval(() => {
    const progress = Math.min(1, (performance.now() - began) / Math.max(1, duration));
    runtime.gain = from + (to - from) * progress;
    applyVolume(runtime);
    if (progress >= 1) {
      if (runtime.fade) clearInterval(runtime.fade);
      runtime.fade = undefined;
      runtime.gain = to;
      done?.();
    }
  }, 40);
}

function destroy(runtime: Runtime) {
  if (runtime.destroyed) return;
  runtime.destroyed = true;
  if (runtime.fade) clearInterval(runtime.fade);
  if (runtime.retry) clearTimeout(runtime.retry);
  runtime.audio?.pause();
  runtime.audio?.removeAttribute("src");
  try { runtime.player?.destroy(); } catch { /* player may not have finished initializing */ }
  runtime.host?.remove();
  liveRuntimes.delete(runtime);
  if (runtimes.get(runtime.key) === runtime) runtimes.delete(runtime.key);
}

function removeRuntime(runtime: Runtime, immediate = false) {
  if (runtimes.get(runtime.key) === runtime) runtimes.delete(runtime.key);
  runtime.retiring = true;
  if (immediate || runtime.scene.fadeOut <= 0) destroy(runtime);
  else fade(runtime, runtime.gain, 0, runtime.scene.fadeOut * 1000, () => destroy(runtime));
}

function activateRuntime(runtime: Runtime) {
  const replaced = runtimes.get(runtime.key);
  if (replaced && replaced !== runtime) removeRuntime(replaced, true);
  runtimes.set(runtime.key, runtime);
  liveRuntimes.add(runtime);
  applyVolume(runtime);
  if (runtime.scene.fadeIn > 0) fade(runtime, 0, 1, runtime.scene.fadeIn * 1000);
  syncPlayback(runtime);
}

function ensureRuntime(active: ActiveScene, track: Track, previewMode = false, session = 0) {
  const key = `${previewMode ? "preview" : active.scene.id}:${track.id}`;
  if (!track.url.trim()) return;
  const source = `${sourceKind(track)}:${track.url}`;
  const pending = pendingRuntimes.get(key);
  if (pending && pending.active.startedAt === active.startedAt && pending.source === source && pending.previewRevision === session) return;
  const request: PendingRuntime = {
    token: Symbol(key), key, active, track, preview: previewMode,
    previewRevision: session, source,
  };
  pendingRuntimes.set(key, request);
  void (async () => {
    try {
      const runtime = sourceKind(track) === "youtube"
        ? await createYouTube(active.scene, track, active.startedAt, key, previewMode, !previewMode && active.pausedAt !== undefined)
        : createAudio(active.scene, track, active.startedAt, key, previewMode, !previewMode && active.pausedAt !== undefined);
      if (!runtime) return;
      if (!requestIsCurrent(request)) destroy(runtime);
      else {
        if (!previewMode) {
          const latest = current.active.find(item => item.scene.id === active.scene.id);
          if (latest) {
            runtime.startedAt = latest.startedAt;
            runtime.paused = latest.pausedAt !== undefined;
          }
        }
        activateRuntime(runtime);
      }
    } catch (error) {
      console.warn("Ambient Forge: source initialization failed", error, track.url);
    } finally {
      if (pendingRuntimes.get(key) === request) pendingRuntimes.delete(key);
    }
  })();
}

function reconcile(state: PlaybackState, immediate = false) {
  const resumingGlobalPause = current.status === "paused" && state.status === "playing";
  current = state;
  const allowed = state.scope === "GLOBAL" || role === "GM";
  const desired = new Map<string, { active: ActiveScene; track: Track; source: string }>();
  if (allowed) for (const active of state.active) for (const track of active.scene.tracks) {
    desired.set(`${active.scene.id}:${track.id}`, { active, track, source: `${sourceKind(track)}:${track.url}` });
  }
  for (const [key] of pendingRuntimes) {
    if (!key.startsWith("preview:") && !desired.has(key)) pendingRuntimes.delete(key);
  }
  for (const runtime of [...runtimes.values()]) {
    if (!runtime.preview && !desired.has(runtime.key)) removeRuntime(runtime, immediate);
  }
  for (const [key, item] of desired) {
    const runtime = runtimes.get(key);
    const paused = item.active.pausedAt !== undefined;
    const resumingScene = !!runtime?.paused && !paused;
    const startedAtChanged = runtime?.startedAt !== item.active.startedAt;
    if (runtime && (runtime.source !== item.source || (startedAtChanged && !resumingScene && !resumingGlobalPause))) {
      removeRuntime(runtime);
      ensureRuntime(item.active, item.track);
    } else if (!runtime) ensureRuntime(item.active, item.track);
    else {
      runtime.scene = item.active.scene;
      runtime.track = item.track;
      runtime.startedAt = item.active.startedAt;
      runtime.paused = paused;
      applyVolume(runtime);
      syncPlayback(runtime);
    }
  }
  for (const runtime of runtimes.values()) if (!runtime.preview) syncPlayback(runtime);
}

function stopPreview() {
  preview = null;
  previewRevision += 1;
  for (const [key] of pendingRuntimes) if (key.startsWith("preview:")) pendingRuntimes.delete(key);
  for (const runtime of [...runtimes.values()]) if (runtime.preview) removeRuntime(runtime, true);
}

function previewScene(scene: Scene) {
  stopPreview();
  preview = scene;
  const session = previewRevision;
  const active = { scene, startedAt: Date.now() };
  for (const track of scene.tracks) ensureRuntime(active, track, true, session);
}

async function unlock() {
  const silence = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=");
  await silence.play().catch(() => undefined);
  silence.pause();
  audioUnlocked = true;
  for (const runtime of liveRuntimes) syncPlayback(runtime);
}

OBR.onReady(async () => {
  audioUnlocked = false;
  loadMaster();
  role = await OBR.player.getRole();
  OBR.broadcast.onMessage(CHANNEL, ({ data }) => {
    if (!validSyncMessage(data)) return;
    const message = data;
    if (message.type === "STATE" && message.state.revision >= current.revision) reconcile(message.state);
    if (message.type === "REQUEST_STATE" && role === "GM") {
      void OBR.broadcast.sendMessage(CHANNEL, { type: "STATE", state: current } satisfies SyncMessage, { destination: "ALL" });
    }
  });
  OBR.broadcast.onMessage(LOCAL_CHANNEL, ({ data }) => {
    if (!validLocalMessage(data)) return;
    const message = data;
    if (message.type === "UNLOCK") void unlock();
    if (message.type === "PREVIEW") previewScene(message.scene);
    if (message.type === "STOP_PREVIEW") stopPreview();
    if (message.type === "MASTER") rampMaster({ volume: message.volume, muted: message.muted });
  });
  void OBR.broadcast.sendMessage(CHANNEL, { type: "REQUEST_STATE" } satisfies SyncMessage, { destination: "ALL" });
});
