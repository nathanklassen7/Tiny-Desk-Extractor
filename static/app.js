import { ID3Writer } from "https://cdn.jsdelivr.net/npm/browser-id3-writer@6.3.1/dist/browser-id3-writer.mjs";
import {
  fmt,
  fmtTimestamp,
  sanitizeFilename,
  createModel,
  segmentPoints,
  addSplit,
  removeSplit,
  moveSplit,
  exportList,
} from "./lib.js";

const $ = (sel) => document.querySelector(sel);

let ws = null;
let regions = null;
let sourceFile = null;
let blobUrl = null;
let model = createModel();
let previewEnd = null;
let exporting = false;

// ── ffmpeg.wasm loading ──────────────────────────────────

const FFMPEG_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm";
const CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
const SRC_MOUNT = "/src";

async function toBlobURL(url, mimeType) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download ${url} (${resp.status})`);
  return URL.createObjectURL(new Blob([await resp.arrayBuffer()], { type: mimeType }));
}

async function fetchFFmpegAssets() {
  const [{ FFmpeg }, classWorkerURL, coreURL, wasmURL] = await Promise.all([
    import(`${FFMPEG_BASE}/classes.js`),
    fetch(`${FFMPEG_BASE}/worker.js`).then(async (r) => {
      if (!r.ok) throw new Error(`Failed to download ffmpeg worker (${r.status})`);
      // The worker is loaded from a blob: URL, so its relative imports must be absolute.
      const src = (await r.text()).replace(
        /from\s+["']\.\/([^"']+)["']/g,
        `from "${FFMPEG_BASE}/$1"`
      );
      return URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    }),
    toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
    toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
  ]);
  return { FFmpeg, classWorkerURL, coreURL, wasmURL };
}

// Memoized, but a failed attempt is forgotten so the next export can retry.
let assetsPromise = null;
function getFFmpegAssets() {
  if (!assetsPromise) {
    assetsPromise = fetchFFmpegAssets().catch((err) => {
      assetsPromise = null;
      throw err;
    });
  }
  return assetsPromise;
}

let ffmpegPromise = null;
function loadFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg, classWorkerURL, coreURL, wasmURL } = await getFFmpegAssets();
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({ classWorkerURL, coreURL, wasmURL });
      return ffmpeg;
    })().catch((err) => {
      ffmpegPromise = null;
      throw err;
    });
  }
  return ffmpegPromise;
}

getFFmpegAssets().catch((err) => console.warn("ffmpeg prefetch failed; will retry on export", err));

// ── Rendering ────────────────────────────────────────────

function currentDuration() {
  return ws ? ws.getDuration() : 0;
}

function rebuildRegions() {
  if (!ws) return;
  regions.clearRegions();
  const points = segmentPoints(model, currentDuration());
  model.tracks.forEach((track, i) => {
    regions.addRegion({
      start: points[i],
      end: points[i + 1],
      color: track.excluded
        ? "hsla(0, 0%, 40%, 0.12)"
        : `hsla(${(i * 47) % 360}, 60%, 50%, 0.18)`,
      drag: false,
      resize: true,
      id: `track-${i}`,
    });
  });
  renderTrackList(points);
}

function renderTrackList(points) {
  const container = $("#track-list");
  const frag = document.createDocumentFragment();
  let exportNumber = 0;

  model.tracks.forEach((track, i) => {
    const excluded = track.excluded;
    if (!excluded) exportNumber++;

    const row = document.createElement("div");
    row.className = "track-row" + (excluded ? " excluded" : "");

    const num = document.createElement("span");
    num.className = "track-num";
    num.textContent = excluded ? "–" : `${exportNumber}.`;

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "track-name";
    nameInput.value = track.name;
    nameInput.placeholder = excluded ? "dead space" : `Track ${exportNumber}`;
    nameInput.disabled = excluded;
    nameInput.setAttribute("aria-label", `Name for segment ${i + 1}`);
    nameInput.addEventListener("input", () => {
      model.tracks[i].name = nameInput.value;
    });

    const times = document.createElement("span");
    times.className = "track-times";
    times.textContent = `${fmt(points[i])} – ${fmt(points[i + 1])}  (${fmt(points[i + 1] - points[i])})`;

    const excludeBtn = document.createElement("button");
    excludeBtn.className = "exclude-btn" + (excluded ? " active" : "");
    excludeBtn.textContent = excluded ? "Excluded" : "Skip";
    excludeBtn.title = excluded ? "Re-include this segment" : "Mark as dead space";
    excludeBtn.addEventListener("click", () => {
      model.tracks[i].excluded = !model.tracks[i].excluded;
      rebuildRegions();
    });

    const previewBtn = document.createElement("button");
    previewBtn.className = "preview-btn";
    previewBtn.textContent = "▶";
    previewBtn.title = "Preview this track";
    previewBtn.addEventListener("click", () => {
      previewEnd = points[i + 1];
      ws.setTime(points[i]);
      ws.play();
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.title = "Remove the split before this track";
    removeBtn.textContent = "✕";
    if (i > 0) {
      removeBtn.addEventListener("click", () => {
        model = removeSplit(model, i);
        rebuildRegions();
      });
    } else {
      removeBtn.disabled = true;
      removeBtn.style.visibility = "hidden";
    }

    row.append(num, nameInput, times, excludeBtn, previewBtn, removeBtn);
    frag.appendChild(row);
  });

  container.replaceChildren(frag);
}

function updatePlayButton() {
  if (!ws) return;
  $("#play-btn").innerHTML = ws.isPlaying() ? "&#9646;&#9646; Pause" : "&#9654; Play";
}

function showUpload(message) {
  $("#editor-section").classList.add("hidden");
  $("#upload-section").classList.remove("hidden");
  const progress = $("#upload-progress");
  if (message) {
    progress.classList.remove("hidden");
    $("#progress-fill").style.width = "0";
    $("#progress-text").textContent = message;
  } else {
    progress.classList.add("hidden");
  }
}

// ── Waveform ─────────────────────────────────────────────

function destroyWaveform() {
  if (ws) {
    ws.destroy();
    ws = null;
  }
  regions = null;
  previewEnd = null;
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }
}

function initWaveform(file) {
  destroyWaveform();
  model = createModel();
  sourceFile = file;
  $("#zoom-slider").value = 1;
  $("#current-time").textContent = fmt(0);
  $("#play-btn").innerHTML = "&#9654; Play";

  if (typeof WaveSurfer === "undefined" || !WaveSurfer.Regions) {
    showUpload("Could not load the waveform library. Check your connection and reload.");
    return;
  }

  blobUrl = URL.createObjectURL(file);
  regions = WaveSurfer.Regions.create();
  const instance = WaveSurfer.create({
    container: "#waveform",
    waveColor: "#a0aec0",
    progressColor: "#5a67d8",
    cursorColor: "#e53e3e",
    cursorWidth: 2,
    height: 160,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    normalize: true,
    plugins: [regions],
  });
  ws = instance;

  $("#upload-progress").classList.remove("hidden");
  $("#progress-fill").style.width = "0";
  $("#progress-text").textContent = "Loading waveform…";

  instance.on("loading", (percent) => {
    if (ws === instance) $("#progress-fill").style.width = `${Math.min(100, percent)}%`;
  });

  instance.on("ready", () => {
    if (ws !== instance) return;
    $("#upload-progress").classList.add("hidden");
    $("#upload-section").classList.add("hidden");
    $("#editor-section").classList.remove("hidden");
    $("#total-time").textContent = fmt(instance.getDuration());
    rebuildRegions();
  });

  instance.on("error", (err) => {
    if (ws !== instance) return;
    console.error(err);
    destroyWaveform();
    showUpload(`Could not read that file as audio${err?.message ? ` (${err.message})` : ""}.`);
  });

  const onTime = (t) => {
    if (ws !== instance) return;
    $("#current-time").textContent = fmt(t);
    if (previewEnd !== null && t >= previewEnd) {
      previewEnd = null;
      instance.pause();
    }
  };
  instance.on("timeupdate", onTime);
  instance.on("audioprocess", onTime);

  instance.on("interaction", () => {
    previewEnd = null;
    updatePlayButton();
  });
  instance.on("play", updatePlayButton);
  instance.on("pause", updatePlayButton);
  instance.on("finish", updatePlayButton);

  regions.on("region-updated", (region) => {
    const i = Number(String(region.id).replace("track-", ""));
    if (!Number.isInteger(i)) return;
    const points = segmentPoints(model, instance.getDuration());
    const eps = 1e-3;
    if (i > 0 && Math.abs(region.start - points[i]) > eps) {
      model = moveSplit(model, i - 1, region.start, instance.getDuration());
    } else if (i < model.splits.length && Math.abs(region.end - points[i + 1]) > eps) {
      model = moveSplit(model, i, region.end, instance.getDuration());
    }
    rebuildRegions();
  });

  instance.load(blobUrl).catch(() => {
    /* surfaced through the "error" event */
  });
}

// ── File selection ───────────────────────────────────────

const fileInput = $("#file-input");
const uploadArea = $("#upload-area");

function handleFile(file) {
  if (!file) return;
  const looksLikeMp3 = /\.mp3$/i.test(file.name) || file.type === "audio/mpeg";
  if (!looksLikeMp3) {
    showUpload("Please select an MP3 file.");
    return;
  }
  if (file.size === 0) {
    showUpload("That file is empty.");
    return;
  }
  initWaveform(file);
}

uploadArea.addEventListener("click", () => fileInput.click());
uploadArea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
uploadArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  uploadArea.classList.add("dragover");
});
uploadArea.addEventListener("dragleave", () => uploadArea.classList.remove("dragover"));
uploadArea.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadArea.classList.remove("dragover");
  handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
  handleFile(fileInput.files[0]);
  fileInput.value = ""; // allow re-selecting the same file
});

// A file dropped outside the drop zone would otherwise navigate away from the page.
for (const type of ["dragover", "drop"]) {
  window.addEventListener(type, (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault();
  });
}

$("#new-file-btn").addEventListener("click", () => {
  if (exporting) return;
  const hasWork = model.splits.length > 0 || model.tracks.some((t) => t.name || t.excluded);
  if (hasWork && !confirm("Discard your splits and track names and load a different file?")) return;
  destroyWaveform();
  model = createModel();
  sourceFile = null;
  showUpload();
});

window.addEventListener("beforeunload", (e) => {
  if (exporting || (ws && model.splits.length > 0)) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ── Controls ─────────────────────────────────────────────

$("#play-btn").addEventListener("click", () => {
  if (!ws) return;
  previewEnd = null;
  ws.playPause();
});

$("#add-marker-btn").addEventListener("click", () => {
  if (!ws) return;
  const next = addSplit(model, ws.getCurrentTime(), currentDuration());
  if (!next) return;
  model = next;
  rebuildRegions();
});

$("#zoom-slider").addEventListener("input", (e) => {
  if (ws) ws.zoom(Number(e.target.value));
});

// ── Export (ffmpeg.wasm + browser-id3-writer + JSZip) ────

function toExactArrayBuffer(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

async function exportAll() {
  if (exporting || !ws || !sourceFile) return;

  const tracks = exportList(model, currentDuration());
  if (tracks.length === 0) {
    alert("All segments are excluded. Include at least one track to export.");
    return;
  }
  if (typeof JSZip === "undefined") {
    alert("The zip library failed to load. Check your connection and reload the page.");
    return;
  }

  const status = $("#export-status");
  const exportBtn = $("#export-btn");
  const artist = $("#artist-input").value.trim();
  const album = $("#album-input").value.trim();

  exporting = true;
  exportBtn.disabled = true;
  status.classList.remove("hidden");

  let ffmpeg = null;
  let mounted = false;
  const written = new Set();

  try {
    status.textContent = "Loading ffmpeg…";
    ffmpeg = await loadFFmpeg();

    // Mount the file read-only instead of copying it into wasm memory.
    await ffmpeg.createDir(SRC_MOUNT).catch(() => {});
    await ffmpeg.mount("WORKERFS", { blobs: [{ name: "input.mp3", data: sourceFile }] }, SRC_MOUNT);
    mounted = true;

    const zip = new JSZip();

    for (const track of tracks) {
      const outFile = `out_${track.number}.mp3`;
      status.textContent = `Splitting track ${track.number} of ${tracks.length}…`;

      written.add(outFile);
      const code = await ffmpeg.exec([
        "-i", `${SRC_MOUNT}/input.mp3`,
        "-ss", fmtTimestamp(track.start),
        "-to", fmtTimestamp(track.end),
        "-map", "0:a:0",
        "-c", "copy",
        "-write_xing", "0",
        "-map_metadata", "-1",
        outFile,
      ]);
      if (code !== 0) throw new Error(`ffmpeg failed on track ${track.number} (exit code ${code})`);

      const data = await ffmpeg.readFile(outFile);
      await ffmpeg.deleteFile(outFile);
      written.delete(outFile);
      if (!data.byteLength) throw new Error(`Track ${track.number} came out empty`);

      status.textContent = `Tagging track ${track.number} of ${tracks.length}…`;
      const writer = new ID3Writer(toExactArrayBuffer(data));
      writer.setFrame("TIT2", track.name);
      if (artist) {
        writer.setFrame("TPE1", [artist]);
        writer.setFrame("TPE2", artist);
      }
      if (album) writer.setFrame("TALB", album);
      writer.setFrame("TRCK", `${track.number}/${tracks.length}`);
      writer.addTag();

      const base = sanitizeFilename(track.name, `Track ${track.number}`);
      zip.file(`${String(track.number).padStart(2, "0")} - ${base}.mp3`, writer.arrayBuffer);
    }

    status.textContent = "Creating zip…";
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });

    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `${sanitizeFilename(album, "tracks")}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    status.textContent = "Export complete!";
  } catch (err) {
    console.error(err);
    status.textContent = "Error: " + (err?.message || err);
  } finally {
    if (ffmpeg) {
      for (const f of written) await ffmpeg.deleteFile(f).catch(() => {});
      if (mounted) await ffmpeg.unmount(SRC_MOUNT).catch(() => {});
    }
    exporting = false;
    exportBtn.disabled = false;
  }
}

$("#export-btn").addEventListener("click", exportAll);
