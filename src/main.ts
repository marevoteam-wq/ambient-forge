import OBR from "@owlbear-rodeo/sdk";
import { Picker } from "emoji-picker-element";
import emojiDataUrl from "emoji-picker-element-data/en/emojibase/data.json?url";
import "./style.css";
import {
  CHANNEL, LOCAL_CHANNEL, LIBRARY_LIMITS, Folder, Library, LocalMessage, PlaybackState,
  Scene, SourceKind, SyncMessage, Track, emptyState, starterLibrary, validLocalMessage, validScene, validSourceUrl, validSyncMessage, youtubeId,
} from "./model";
import { parseImportedLibrary } from "./importer";
import { loadLibrary, saveLibrary } from "./storage";

const app = document.querySelector<HTMLDivElement>("#app")!;
let role: "GM" | "PLAYER" = "PLAYER";
let library: Library = starterLibrary();
let playback = emptyState();
let selectedFolder = "";
let master = { volume: 80, muted: false };
let audioEnabled = false;
let previewSceneId: string | null = null;
let foldersCollapsed = false;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

try {
  const stored = JSON.parse(localStorage.getItem("ambient-forge-master") || "null") as typeof master | null;
  if (stored && typeof stored.volume === "number" && stored.volume >= 0 && stored.volume <= 100 && typeof stored.muted === "boolean") master = stored;
} catch { /* ignored */ }

const esc = (value: string) => value.replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pauseIcon = `<svg class="pause-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="3" width="4.5" height="14" rx="1.4"></rect><rect x="11.5" y="3" width="4.5" height="14" rx="1.4"></rect></svg>`;
const plusIcon = `<svg class="button-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"></path></svg>`;
const importIcon = `<svg class="button-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 11V2m0 0L4.5 5.5M8 2l3.5 3.5M3 9.5V14h10V9.5"></path></svg>`;
const exportIcon = `<svg class="button-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v9m0 0 3.5-3.5M8 11 4.5 7.5M3 6.5V2h10v4.5"></path></svg>`;
const chevronIcon = (collapsed: boolean) => `<svg class="button-icon chevron-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="${collapsed ? "M6 3.5 10.5 8 6 12.5" : "M10 3.5 5.5 8l4.5 4.5"}"></path></svg>`;
function emojiField(id: string, value: string, label: string) {
  return `<label class="emoji-field">${label}<div class="emoji-control"><input id="${id}" maxlength="12" value="${esc(value)}" placeholder="♫"><details class="emoji-picker"><summary title="Choose an emoji" aria-label="Choose an emoji">☺</summary><div class="emoji-panel" data-emoji-panel="${id}"></div></details></div></label>`;
}

function wireEmojiPickers(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-emoji-panel]").forEach(panel => {
    const input = byId<HTMLInputElement>(panel.dataset.emojiPanel!);
    const picker = new Picker({ dataSource: emojiDataUrl, locale: "en" });
    picker.className = "ambient-emoji-picker dark";
    picker.addEventListener("emoji-click", event => {
      if (!event.detail.unicode) return;
      input.value = event.detail.unicode;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      panel.closest("details")?.removeAttribute("open");
      input.focus();
    });
    panel.append(picker);
    requestAnimationFrame(() => {
      const root = picker.shadowRoot;
      if (!root) return;
      const style = document.createElement("style");
      style.textContent = `
        .nav { gap: 3px; padding: 0 7px 7px; overflow: visible; }
        .nav-button { min-width: 0; height: 31px; border-radius: 8px; transition: background .15s ease, color .15s ease; }
        .nav-button[aria-selected="true"] { background: #493b62; box-shadow: inset 0 0 0 1px #745aa0; }
        .nav-emoji { width: 100%; height: 31px; font-size: 17px; }
        .indicator-wrapper { display: none; }
        .favorites { padding: 4px 3px; background: #1d1925; }
        .emoji.active, button.emoji.active { border-radius: 9px; background: #3b314d; }
      `;
      root.append(style);
    });
  });
}

function toast(message: string, error = false) {
  const node = document.createElement("div");
  node.className = `toast${error ? " error" : ""}`;
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 2600);
}

async function persist() {
  await saveLibrary(library);
  render();
}

async function publish(next: PlaybackState) {
  if (role !== "GM") return;
  const state = { ...next, version: 1 as const, revision: playback.revision + 1, updatedAt: Date.now() };
  const message = { type: "STATE", state } satisfies SyncMessage;
  if (!validSyncMessage(message)) {
    toast("This active mix is too large to synchronize. Stop a scene or shorten its source URLs.", true);
    return;
  }
  playback = state;
  render();
  await OBR.broadcast.sendMessage(CHANNEL, message, { destination: "ALL" });
}

async function sendLocal(message: LocalMessage) {
  if (!validLocalMessage(message)) {
    toast("This scene is too large to preview. Shorten its source URLs or remove a track.", true);
    return;
  }
  await OBR.broadcast.sendMessage(LOCAL_CHANNEL, message, { destination: "LOCAL" });
}

function isActive(sceneId: string) { return playback.active.some(item => item.scene.id === sceneId); }

async function toggleScene(scene: Scene) {
  if (isActive(scene.id)) {
    await publish({ ...playback, active: playback.active.filter(item => item.scene.id !== scene.id) });
  } else {
    await publish({ ...playback, status: "playing", pausedAt: undefined, active: [...playback.active, { scene, startedAt: Date.now() + 250 }] });
  }
}

async function togglePause() {
  if (playback.status === "playing") {
    await publish({ ...playback, status: "paused", pausedAt: Date.now() });
  } else {
    const pausedFor = playback.pausedAt ? Date.now() - playback.pausedAt : 0;
    await publish({
      ...playback,
      status: "playing",
      pausedAt: undefined,
      active: playback.active.map(item => item.pausedAt ? item : { ...item, startedAt: item.startedAt + pausedFor }),
    });
  }
}

async function toggleScenePause(sceneId: string) {
  if (playback.status === "paused") return;
  const active = playback.active.find(item => item.scene.id === sceneId);
  if (!active) return;
  const now = Date.now();
  await publish({
    ...playback,
    active: playback.active.map(item => {
      if (item.scene.id !== sceneId) return item;
      if (!item.pausedAt) return { ...item, pausedAt: now };
      return { ...item, startedAt: item.startedAt + (now - item.pausedAt), pausedAt: undefined };
    }),
  });
}

async function setMaster(volume: number, muted = master.muted) {
  master = { volume, muted };
  localStorage.setItem("ambient-forge-master", JSON.stringify(master));
  await sendLocal({ type: "MASTER", ...master });
}

async function enableAudio() {
  audioEnabled = true;
  await sendLocal({ type: "UNLOCK" });
  render();
  toast("Audio enabled in this browser");
}

function render() {
  if (!selectedFolder || !library.folders.some(folder => folder.id === selectedFolder)) selectedFolder = library.folders[0]?.id || "";
  const currentFolder = library.folders.find(folder => folder.id === selectedFolder);
  const scenes = library.scenes.filter(scene => scene.folderId === selectedFolder);
  const activeNames = playback.active.map(item => {
    const folder = library.folders.find(candidate => candidate.id === item.scene.folderId);
    return `${folder?.name || "Unfiled"} / ${item.scene.name}${item.pausedAt ? " (paused)" : ""}`;
  });
  const isGm = role === "GM";

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand"><img src="/icon.svg"><div><strong>Ambient Forge</strong><span>${isGm ? "Game Master panel" : "Player audio"}</span></div></div>
        <div class="transport">
          ${isGm ? `<button class="icon-btn" id="pause" title="Pause / resume all" ${playback.active.length ? "" : "disabled"}>${playback.status === "paused" ? "▶" : pauseIcon}</button><button class="icon-btn danger" id="stop-all" title="Stop all" ${playback.active.length ? "" : "disabled"}><span class="stop-icon"></span></button>` : ""}
          <button class="unlock ${audioEnabled ? "ok" : ""}" id="unlock">${audioEnabled ? "✓ Audio enabled" : "▶ Enable audio"}</button>
        </div>
      </header>
      <section class="mixerbar">
        <div class="now-playing ${playback.active.length ? "" : "empty"}"><span class="pulse"></span><strong>${playback.status === "paused" ? "Paused:" : "Now playing:"}</strong><span class="now-playing-value">${activeNames.length ? activeNames.map(esc).join(" · ") : "Nothing"}</span></div>
        <div class="master-volume"><button class="mute" id="mute" title="Mute master volume">${master.muted ? "🔇" : "🔊"}</button><input id="master-volume" aria-label="Master volume" type="range" min="0" max="100" value="${master.volume}" style="--range-value:${master.volume}%"><span class="volume-value">${master.volume}%</span></div>
        ${isGm ? `<div class="scope"><button data-scope="GLOBAL" class="${playback.scope === "GLOBAL" ? "active" : ""}">🌐 Everyone</button><button data-scope="LOCAL" class="${playback.scope === "LOCAL" ? "active" : ""}">🎧 Only me</button></div>` : `<span class="scope-label">${playback.scope === "GLOBAL" ? "The GM is broadcasting audio" : "The GM is playing audio locally"}</span>`}
      </section>
      ${isGm ? `
      <main class="workspace ${foldersCollapsed ? "folders-collapsed" : ""}">
        <aside class="folders">
          <div class="section-title"><button id="toggle-folders" class="folders-toggle" title="${foldersCollapsed ? "Expand folders" : "Collapse folders"}">${chevronIcon(foldersCollapsed)}</button><span>Folders</span><button id="add-folder" title="New folder">${plusIcon}</button></div>
          <div class="folder-list">${library.folders.map(folder => `<button class="folder ${folder.id === selectedFolder ? "active" : ""}" data-folder="${folder.id}" title="${esc(folder.name)}"><span class="folder-symbol ${folder.icon ? "has-emoji" : ""}">${folder.icon ? `<b>${esc(folder.icon)}</b>` : ""}<i style="background:${esc(folder.color)}"></i></span><span>${esc(folder.name)}</span><em>${library.scenes.filter(s => s.folderId === folder.id).length}</em></button>`).join("")}</div>
          <div class="library-actions"><button id="import" title="Import Ambient Forge, JSON, or Djinni library">${importIcon}<span>Import</span></button><button id="export">${exportIcon}<span>Export</span></button><button id="delete-all-scenes" class="delete-all-scenes">Delete all folders &amp; scenes</button><input id="import-file" type="file" accept=".aforge,.json,.djinni,.txt,application/json,text/plain" hidden></div>
        </aside>
        <section class="scenes">
          <div class="scene-heading"><div><span>Scenes</span><h2>${esc(currentFolder?.name || "No folder")}</h2></div><div class="heading-actions"><button id="edit-folder" class="secondary" ${currentFolder ? "" : "disabled"}>Folder settings</button><button id="add-scene" class="primary" ${currentFolder ? "" : "disabled"}>${plusIcon}<span>New scene</span></button></div></div>
          <div class="scene-grid">
            ${scenes.length ? scenes.map(sceneCard).join("") : `<div class="blank"><div>♫</div><strong>No sound scenes here yet</strong><span>Create a scene and add music, rain, voices, or any other sounds.</span><button id="blank-add" class="primary">${plusIcon}<span>Create the first scene</span></button></div>`}
          </div>
        </section>
      </main>` : playerView()}
    </div>`;

  wireCommon();
  if (isGm) wireGm();
}

function playerView() {
  return `<main class="player-view"><div class="player-orb ${playback.status}"><span>♫</span></div><h2>${playback.active.length ? `${playback.active.length} active scene${playback.active.length === 1 ? "" : "s"}` : "Waiting for audio"}</h2><p>${playback.scope === "LOCAL" ? "The GM selected local mode, so audio will be shared another way." : "Keep the extension open. This volume control affects only your browser."}</p></main>`;
}

function sceneCard(scene: Scene) {
  const activeScene = playback.active.find(item => item.scene.id === scene.id);
  const active = !!activeScene;
  const paused = activeScene?.pausedAt !== undefined;
  return `<article class="scene-card ${active ? "active" : ""}" style="--accent:${esc(scene.color)}">
    <button class="play-scene" data-play="${scene.id}"><span class="scene-icon">${esc(scene.icon || "♫")}</span><span class="play-mark">${active ? "■" : "▶"}</span></button>
    <div class="scene-info"><strong>${esc(scene.name)}</strong><span>${scene.tracks.length} track${scene.tracks.length === 1 ? "" : "s"}</span></div>
    <div class="scene-actions">${active ? `<button data-scene-pause="${scene.id}" title="${paused ? "Resume from saved position" : "Pause scene"}" ${playback.status === "paused" ? "disabled" : ""}>${paused ? "▶" : pauseIcon}</button>` : ""}<button class="edit-scene" data-edit="${scene.id}" title="Edit">✎</button><button data-delete="${scene.id}" title="Delete">×</button></div>
    <label class="scene-volume" title="Scene volume"><span>🔉</span><input data-scene-volume="${scene.id}" aria-label="Volume for ${esc(scene.name)}" type="range" min="0" max="100" value="${scene.volume}" style="--range-value:${scene.volume}%"><em data-scene-volume-value="${scene.id}">${scene.volume}%</em></label>
  </article>`;
}

function wireCommon() {
  byId<HTMLButtonElement>("unlock").onclick = () => void enableAudio();
  byId<HTMLButtonElement>("mute").onclick = () => {
    void setMaster(master.volume, !master.muted);
    render();
  };
  byId<HTMLInputElement>("master-volume").oninput = event => {
    const input = event.target as HTMLInputElement;
    const volume = Number(input.value);
    input.style.setProperty("--range-value", `${volume}%`);
    const label = document.querySelector<HTMLElement>(".volume-value");
    if (label) label.textContent = `${volume}%`;
    void setMaster(volume);
  };
}

function wireGm() {
  byId<HTMLButtonElement>("pause").onclick = () => void togglePause();
  byId<HTMLButtonElement>("stop-all").onclick = () => void publish({ ...playback, active: [], status: "playing", pausedAt: undefined });
  document.querySelectorAll<HTMLButtonElement>("[data-scope]").forEach(button => button.onclick = () => void publish({ ...playback, scope: button.dataset.scope as "GLOBAL" | "LOCAL" }));
  byId<HTMLButtonElement>("toggle-folders").onclick = () => { foldersCollapsed = !foldersCollapsed; render(); };
  document.querySelectorAll<HTMLButtonElement>("[data-folder]").forEach(button => button.onclick = () => {
    selectedFolder = button.dataset.folder!;
    foldersCollapsed = true;
    render();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-play]").forEach(button => button.onclick = () => { const scene = library.scenes.find(s => s.id === button.dataset.play); if (scene) void toggleScene(scene); });
  document.querySelectorAll<HTMLButtonElement>("[data-scene-pause]").forEach(button => button.onclick = () => void toggleScenePause(button.dataset.scenePause!));
  document.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach(button => button.onclick = () => { const scene = library.scenes.find(s => s.id === button.dataset.edit); if (scene) openSceneDialog(scene); });
  document.querySelectorAll<HTMLButtonElement>("[data-delete]").forEach(button => button.onclick = () => void deleteScene(button.dataset.delete!));
  document.querySelectorAll<HTMLButtonElement>("[data-preview]").forEach(button => button.onclick = () => {
    const scene = library.scenes.find(s => s.id === button.dataset.preview);
    if (!scene) return;
    if (previewSceneId === scene.id) {
      previewSceneId = null;
      void sendLocal({ type: "STOP_PREVIEW" });
    } else {
      previewSceneId = scene.id;
      void sendLocal({ type: "PREVIEW", scene });
    }
    render();
  });
  document.querySelectorAll<HTMLInputElement>("[data-scene-volume]").forEach(input => {
    input.oninput = () => {
      input.style.setProperty("--range-value", `${input.value}%`);
      const label = document.querySelector<HTMLElement>(`[data-scene-volume-value="${input.dataset.sceneVolume}"]`);
      if (label) label.textContent = `${input.value}%`;
    };
    input.onchange = async () => {
      const sceneId = input.dataset.sceneVolume!;
      const volume = Number(input.value);
      const scene = library.scenes.find(item => item.id === sceneId);
      if (!scene) return;
      const updatedScene = { ...scene, volume };
      library = { ...library, scenes: library.scenes.map(item => item.id === sceneId ? updatedScene : item) };
      await saveLibrary(library);
      if (isActive(sceneId)) {
        await publish({ ...playback, active: playback.active.map(item => item.scene.id === sceneId ? { ...item, scene: updatedScene } : item) });
      } else if (previewSceneId === sceneId) {
        await sendLocal({ type: "PREVIEW", scene: updatedScene });
      }
    };
  });
  byId<HTMLButtonElement>("add-folder").onclick = () => openFolderDialog();
  byId<HTMLButtonElement>("edit-folder").onclick = () => { const folder = library.folders.find(f => f.id === selectedFolder); if (folder) openFolderDialog(folder); };
  byId<HTMLButtonElement>("add-scene").onclick = () => openSceneDialog();
  document.getElementById("blank-add")?.addEventListener("click", () => openSceneDialog());
  byId<HTMLButtonElement>("export").onclick = exportLibrary;
  byId<HTMLButtonElement>("delete-all-scenes").onclick = openDeleteAllDialog;
  byId<HTMLButtonElement>("import").onclick = () => {
    const input = byId<HTMLInputElement>("import-file");
    // Selecting the same backup twice does not fire `change` unless the old
    // value is cleared first.
    input.value = "";
    input.click();
  };
  byId<HTMLInputElement>("import-file").onchange = event => void importLibrary((event.target as HTMLInputElement).files?.[0]);
}

function dialogShell(title: string, body: string, wide = false) {
  document.querySelector("dialog")?.remove();
  const dialog = document.createElement("dialog");
  dialog.className = wide ? "wide" : "";
  dialog.innerHTML = `<form method="dialog"><div class="dialog-head"><h2>${esc(title)}</h2><button value="cancel" class="dialog-x">×</button></div>${body}</form>`;
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
  return dialog;
}

function openFolderDialog(folder?: Folder) {
  if (!folder && library.folders.length >= LIBRARY_LIMITS.folders) {
    toast(`A library can contain up to ${LIBRARY_LIMITS.folders} folders.`, true);
    return;
  }
  const dialog = dialogShell(folder ? "Folder settings" : "New folder", `
    <div class="folder-fields">${emojiField("folder-icon", folder?.icon || "", "Icon")}<label>Name<input id="folder-name" maxlength="40" value="${esc(folder?.name || "New folder")}" required></label><label>Color<input id="folder-color" type="color" value="${folder?.color || "#8b6ff7"}"></label></div>
    <div class="dialog-actions">${folder && library.folders.length > 1 ? `<button type="button" id="delete-folder" class="danger-text">Delete folder</button>` : "<span></span>"}<button value="cancel" class="secondary">Cancel</button><button type="button" id="save-folder" class="primary">Save</button></div>`);
  dialog.classList.add("folder-dialog");
  wireEmojiPickers(dialog);
  byId<HTMLButtonElement>("save-folder").onclick = async () => {
    const name = byId<HTMLInputElement>("folder-name").value.trim();
    if (!name) return;
    const next: Folder = { id: folder?.id || crypto.randomUUID(), name, color: byId<HTMLInputElement>("folder-color").value, icon: byId<HTMLInputElement>("folder-icon").value.trim() };
    library = folder ? { ...library, folders: library.folders.map(item => item.id === folder.id ? next : item) } : { ...library, folders: [...library.folders, next] };
    selectedFolder = next.id; dialog.close(); await persist();
  };
  document.getElementById("delete-folder")?.addEventListener("click", async () => {
    if (!folder || !confirm("Delete this folder and every scene inside it?")) return;
    const removedIds = new Set(library.scenes.filter(s => s.folderId === folder.id).map(s => s.id));
    library = { ...library, folders: library.folders.filter(f => f.id !== folder.id), scenes: library.scenes.filter(s => s.folderId !== folder.id) };
    dialog.close(); await persist();
    if ([...removedIds].some(isActive)) await publish({ ...playback, active: playback.active.filter(item => !removedIds.has(item.scene.id)) });
  });
}

function newTrack(): Track {
  return { id: crypto.randomUUID(), name: "New track", url: "", kind: "auto", volume: 100, muted: false, loop: true, delayMin: 0, delayMax: 0 };
}

function openSceneDialog(existing?: Scene) {
  if (!existing && library.scenes.length >= LIBRARY_LIMITS.scenes) {
    toast(`A library can contain up to ${LIBRARY_LIMITS.scenes} scenes.`, true);
    return;
  }
  let draft: Scene = existing ? structuredClone(existing) : {
    id: crypto.randomUUID(), folderId: selectedFolder, name: "New scene", icon: "♫", color: library.folders.find(f => f.id === selectedFolder)?.color || "#8b6ff7", volume: 80, fadeIn: 0, fadeOut: 3, tracks: [newTrack()],
  };
  const dialog = dialogShell(existing ? "Edit scene" : "New sound scene", `<div id="scene-editor"></div>`, true);
  const draw = () => {
    byId<HTMLDivElement>("scene-editor").innerHTML = `
      <div class="scene-fields">${emojiField("scene-icon", draft.icon, "Icon")}<label>Name<input id="scene-name" maxlength="50" value="${esc(draft.name)}"></label><label>Color<input id="scene-color" type="color" value="${draft.color}"></label></div>
      <div class="settings-row"><label>Volume <b id="scene-volume-value">${draft.volume}%</b><input id="scene-volume-input" type="range" min="0" max="100" value="${draft.volume}" style="--range-value:${draft.volume}%"></label><label>Fade in, sec.${numberInput(`id="fade-in" min="0" max="30" step="0.5" value="${draft.fadeIn}"`, "Fade in")}</label><label>Fade out, sec.${numberInput(`id="fade-out" min="0" max="30" step="0.5" value="${draft.fadeOut}"`, "Fade out")}</label></div>
      <div class="tracks-title"><div><strong>Tracks</strong><span>MP3, OGG, WAV, or YouTube</span></div><button type="button" id="add-track" class="secondary">${plusIcon}<span>Add track</span></button></div>
      <div class="track-list">${draft.tracks.map((track, index) => trackRow(track, index)).join("")}</div>
      <div class="dialog-actions"><span></span><button value="cancel" class="secondary">Cancel</button><button type="button" id="save-scene" class="primary">Save scene</button></div>`;
    wireDraft();
  };
  const syncDraft = () => {
    draft.name = byId<HTMLInputElement>("scene-name").value;
    draft.icon = byId<HTMLInputElement>("scene-icon").value;
    draft.color = byId<HTMLInputElement>("scene-color").value;
    draft.volume = Number(byId<HTMLInputElement>("scene-volume-input").value);
    draft.fadeIn = Number(byId<HTMLInputElement>("fade-in").value);
    draft.fadeOut = Number(byId<HTMLInputElement>("fade-out").value);
    document.querySelectorAll<HTMLElement>("[data-track-row]").forEach(row => {
      const track = draft.tracks[Number(row.dataset.trackRow)];
      track.name = row.querySelector<HTMLInputElement>("[data-field=name]")!.value;
      track.url = row.querySelector<HTMLInputElement>("[data-field=url]")!.value.trim();
      track.kind = row.querySelector<HTMLSelectElement>("[data-field=kind]")!.value as SourceKind;
      track.volume = Number(row.querySelector<HTMLInputElement>("[data-field=volume]")!.value);
      track.muted = row.querySelector<HTMLInputElement>("[data-field=muted]")!.checked;
      track.loop = row.querySelector<HTMLInputElement>("[data-field=loop]")!.checked;
      track.delayMin = Number(row.querySelector<HTMLInputElement>("[data-field=delayMin]")!.value);
      track.delayMax = Number(row.querySelector<HTMLInputElement>("[data-field=delayMax]")!.value);
    });
  };
  const wireDraft = () => {
    wireEmojiPickers(dialog);
    wireNumberSteppers(dialog);
    byId<HTMLInputElement>("scene-volume-input").oninput = event => {
      const input = event.target as HTMLInputElement;
      input.style.setProperty("--range-value", `${input.value}%`);
      byId("scene-volume-value").textContent = `${input.value}%`;
    };
    byId<HTMLButtonElement>("add-track").onclick = () => {
      syncDraft();
      if (draft.tracks.length >= LIBRARY_LIMITS.tracksPerScene) {
        toast(`A scene can contain up to ${LIBRARY_LIMITS.tracksPerScene} tracks.`, true);
        return;
      }
      draft.tracks.push(newTrack());
      draw();
    };
    document.querySelectorAll<HTMLButtonElement>("[data-remove-track]").forEach(button => button.onclick = () => { syncDraft(); draft.tracks.splice(Number(button.dataset.removeTrack), 1); draw(); });
    byId<HTMLButtonElement>("save-scene").onclick = async () => {
      syncDraft(); draft.name = draft.name.trim();
      if (!draft.name) return toast("Enter a scene name", true);
      if (!draft.tracks.length || draft.tracks.some(track => !track.url)) return toast("Every track needs a URL", true);
      if (draft.tracks.some(track => !validSourceUrl(track.url))) return toast("Use a valid HTTP or HTTPS audio URL", true);
      if (draft.tracks.some(track => track.kind === "youtube" && !youtubeId(track.url))) return toast("Use a valid YouTube URL", true);
      if (!validScene(draft)) return toast("Check the scene fields and track settings", true);
      library = existing ? { ...library, scenes: library.scenes.map(scene => scene.id === existing.id ? draft : scene) } : { ...library, scenes: [...library.scenes, draft] };
      dialog.close(); await persist();
      if (isActive(draft.id)) await publish({ ...playback, active: playback.active.map(item => item.scene.id === draft.id ? { ...item, scene: draft } : item) });
    };
  };
  draw();
}

function trackRow(track: Track, index: number) {
  return `<div class="track-row" data-track-row="${index}">
    <div class="track-number">${index + 1}</div><div class="track-main"><div class="track-top"><input data-field="name" maxlength="80" value="${esc(track.name)}" placeholder="Name"><select data-field="kind"><option value="auto" ${track.kind === "auto" ? "selected" : ""}>Auto</option><option value="audio" ${track.kind === "audio" ? "selected" : ""}>Audio file</option><option value="youtube" ${track.kind === "youtube" ? "selected" : ""}>YouTube</option></select><button type="button" data-remove-track="${index}">×</button></div><input data-field="url" class="url" maxlength="2048" value="${esc(track.url)}" placeholder="https://…"></div>
    <div class="track-options"><label>Volume ${numberInput(`data-field="volume" min="0" max="100" value="${track.volume}"`, "Track volume")}</label><label class="check"><input data-field="muted" type="checkbox" ${track.muted ? "checked" : ""}> Mute</label><label class="check"><input data-field="loop" type="checkbox" ${track.loop ? "checked" : ""}> Loop</label><label>Delay ${numberInput(`data-field="delayMin" min="0" max="3600" value="${track.delayMin}"`, "Minimum delay")}—${numberInput(`data-field="delayMax" min="0" max="3600" value="${track.delayMax}"`, "Maximum delay")} sec.</label></div>
  </div>`;
}

function numberInput(attributes: string, label: string) {
  return `<span class="number-stepper"><input type="number" ${attributes}><span class="number-stepper-buttons"><button type="button" data-number-step="up" aria-label="Increase ${label}"><i></i></button><button type="button" data-number-step="down" aria-label="Decrease ${label}"><i></i></button></span></span>`;
}

function wireNumberSteppers(root: ParentNode) {
  root.querySelectorAll<HTMLButtonElement>("[data-number-step]").forEach(button => button.onclick = () => {
    const input = button.closest<HTMLElement>(".number-stepper")?.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) return;
    button.dataset.numberStep === "up" ? input.stepUp() : input.stepDown();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function deleteScene(id: string) {
  if (!confirm("Delete this scene?")) return;
  library = { ...library, scenes: library.scenes.filter(scene => scene.id !== id) };
  await persist();
  if (isActive(id)) await publish({ ...playback, active: playback.active.filter(item => item.scene.id !== id) });
}

function openDeleteAllDialog() {
  const sceneCount = library.scenes.length;
  const folderCount = library.folders.length;
  const dialog = dialogShell("Delete the entire library?", `
    <div class="delete-all-warning"><span>!</span><div><strong>This will permanently delete ${folderCount} folder${folderCount === 1 ? "" : "s"} and ${sceneCount} scene${sceneCount === 1 ? "" : "s"}.</strong><p>This action cannot be undone. Export a backup first if you may need to restore this library later. A new empty “My scenes” folder will be created afterward.</p></div></div>
    <div class="dialog-actions delete-all-actions"><button type="button" id="backup-before-delete" class="secondary">⇩ Export backup</button><button value="cancel" class="secondary">Cancel</button><button type="button" id="confirm-delete-all" class="danger-confirm">Delete everything</button></div>`);
  byId<HTMLButtonElement>("backup-before-delete").onclick = exportLibrary;
  byId<HTMLButtonElement>("confirm-delete-all").onclick = async () => {
    library = starterLibrary();
    selectedFolder = library.folders[0].id;
    previewSceneId = null;
    dialog.close();
    await sendLocal({ type: "STOP_PREVIEW" });
    await persist();
    if (playback.active.length) await publish({ ...playback, active: [], status: "playing", pausedAt: undefined });
    toast("Library cleared");
  };
}

function exportLibrary() {
  const blob = new Blob([JSON.stringify(library, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob); link.download = `ambient-forge-${new Date().toISOString().slice(0, 10)}.aforge`;
  link.click(); URL.revokeObjectURL(link.href); toast("Backup saved");
}

async function importLibrary(file?: File) {
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) return toast("This library is too large. The maximum import size is 5 MB.", true);
  try {
    const parsed = parseImportedLibrary(JSON.parse(await file.text()));
    const data = parsed.library;
    const previousSceneIds = new Set(library.scenes.map(scene => scene.id));
    const firstImportedScene = data.scenes.find(scene => !previousSceneIds.has(scene.id));
    library = data;
    selectedFolder = firstImportedScene?.folderId || library.scenes[0]?.folderId || library.folders[0]?.id || "";
    await persist();
    const trackCount = library.scenes.reduce((total, scene) => total + scene.tracks.length, 0);
    toast(`Imported ${parsed.format}: ${library.folders.length} folders, ${library.scenes.length} scenes, ${trackCount} tracks`);
  } catch { toast("Could not import this file. Use an Ambient Forge or Djinni library.", true); }
}

async function startOwlbear() {
  [role, library] = await Promise.all([OBR.player.getRole(), loadLibrary()]);
  if (library.folders.some(folder => folder.name === "Мои сцены")) {
    library = { ...library, folders: library.folders.map(folder => folder.name === "Мои сцены" ? { ...folder, name: "My scenes" } : folder) };
    await saveLibrary(library);
  }
  selectedFolder = library.folders[0]?.id || "";
  OBR.broadcast.onMessage(CHANNEL, ({ data }) => {
    if (!validSyncMessage(data)) return;
    const message = data;
    if (message.type === "STATE" && message.state.revision >= playback.revision) { playback = message.state; render(); }
  });
  render();
  void setMaster(master.volume, master.muted);
  void OBR.broadcast.sendMessage(CHANNEL, { type: "REQUEST_STATE" } satisfies SyncMessage, { destination: "ALL" });
}

if (new URLSearchParams(location.search).has("preview")) {
  role = "GM";
  const folderId = library.folders[0].id;
  library.scenes = [
    { id: "preview-tavern", folderId, name: "Roadside Tavern", icon: "🍺", color: "#9b6bff", volume: 78, fadeIn: 2, fadeOut: 4, tracks: [{ ...newTrack(), name: "Music", url: "https://example.com/music.mp3" }, { ...newTrack(), name: "Fireplace", url: "https://example.com/fire.ogg", volume: 45 }] },
    { id: "preview-rain", folderId, name: "Night Storm", icon: "⛈️", color: "#4e91e8", volume: 64, fadeIn: 1, fadeOut: 5, tracks: [{ ...newTrack(), name: "Rain", url: "https://example.com/rain.ogg" }] },
  ];
  render();
} else {
  OBR.onReady(() => void startOwlbear());
}
