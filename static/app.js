import { ID3Writer } from "https://cdn.jsdelivr.net/npm/browser-id3-writer@6/dist/browser-id3-writer.mjs";

(function () {
  "use strict";

  let ws = null;
  let regions = null;
  let sourceFile = null; // the raw File object
  let sourceArrayBuffer = null; // cached ArrayBuffer of the file
  let splitPoints = [];
  let excludedSet = new Set();
  let ffmpegInstance = null;
  let ffmpegLoading = false;

  const $ = (sel) => document.querySelector(sel);

  // ── Helpers ──────────────────────────────────────────────

  function fmt(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function fmtTimestamp(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = (seconds % 60).toFixed(2);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.padStart(5, "0")}`;
  }

  async function toBlobURL(url, mimeType, onProgress) {
    const resp = await fetch(url);
    if (!onProgress || !resp.headers.get("content-length")) {
      const blob = new Blob([await resp.arrayBuffer()], { type: mimeType });
      return URL.createObjectURL(blob);
    }
    const total = parseInt(resp.headers.get("content-length"), 10);
    const reader = resp.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total);
    }
    const blob = new Blob(chunks, { type: mimeType });
    return URL.createObjectURL(blob);
  }

  const FFMPEG_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm";
  const CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";

  let prefetchedAssets = null;
  const prefetchPromise = (async () => {
    const [{ FFmpeg }, classWorkerURL, coreURL, wasmURL] = await Promise.all([
      import(`${FFMPEG_BASE}/classes.js`),
      fetch(`${FFMPEG_BASE}/worker.js`)
        .then((r) => r.text())
        .then((src) => {
          src = src.replace(/from\s+["']\.\/([^"']+)["']/g, `from "${FFMPEG_BASE}/$1"`);
          return URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        }),
      toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    ]);
    prefetchedAssets = { FFmpeg, classWorkerURL, coreURL, wasmURL };
  })();

  async function loadFFmpeg() {
    if (ffmpegInstance) return ffmpegInstance;
    if (ffmpegLoading) {
      while (!ffmpegInstance) await new Promise((r) => setTimeout(r, 100));
      return ffmpegInstance;
    }
    ffmpegLoading = true;

    const statusEl = $("#export-status");
    if (!prefetchedAssets) {
      if (statusEl) statusEl.textContent = "Downloading ffmpeg…";
    }
    await prefetchPromise;

    if (statusEl) statusEl.textContent = "Initializing ffmpeg…";
    const { FFmpeg, classWorkerURL, coreURL, wasmURL } = prefetchedAssets;
    const ffmpeg = new FFmpeg();
    await ffmpeg.load({ classWorkerURL, coreURL, wasmURL });

    ffmpegInstance = ffmpeg;
    ffmpegLoading = false;
    return ffmpeg;
  }

  // ── Regions ─────────────────────────────────────────────

  function rebuildRegions() {
    if (!ws) return;
    regions.clearRegions();

    const dur = ws.getDuration();
    const points = [0, ...splitPoints, dur];

    for (let i = 0; i < points.length - 1; i++) {
      const excluded = excludedSet.has(i);
      const hue = (i * 47) % 360;
      regions.addRegion({
        start: points[i],
        end: points[i + 1],
        color: excluded
          ? "hsla(0, 0%, 40%, 0.12)"
          : `hsla(${hue}, 60%, 50%, 0.18)`,
        drag: false,
        resize: true,
        id: `track-${i}`,
      });
    }

    renderTrackList(points);
  }

  function renderTrackList(points) {
    const container = $("#track-list");
    container.innerHTML = "";

    for (let i = 0; i < points.length - 1; i++) {
      const excluded = excludedSet.has(i);

      const row = document.createElement("div");
      row.className = "track-row" + (excluded ? " excluded" : "");

      const num = document.createElement("span");
      num.className = "track-num";
      num.textContent = `${i + 1}.`;

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "track-name";
      nameInput.placeholder = excluded ? "dead space" : `Track ${i + 1}`;
      nameInput.dataset.index = i;
      if (excluded) nameInput.disabled = true;
      const prev = container.querySelector(`input[data-index="${i}"]`);
      if (prev) nameInput.value = prev.value;

      const times = document.createElement("span");
      times.className = "track-times";
      const duration = points[i + 1] - points[i];
      times.textContent = `${fmt(points[i])} – ${fmt(points[i + 1])}  (${fmt(duration)})`;

      const excludeBtn = document.createElement("button");
      excludeBtn.className = "exclude-btn" + (excluded ? " active" : "");
      excludeBtn.textContent = excluded ? "Excluded" : "Skip";
      excludeBtn.title = excluded ? "Re-include this segment" : "Mark as dead space";
      excludeBtn.addEventListener("click", () => {
        const names = getTrackNames();
        if (excludedSet.has(i)) excludedSet.delete(i);
        else excludedSet.add(i);
        rebuildRegions();
        restoreTrackNames(names);
      });

      const previewBtn = document.createElement("button");
      previewBtn.className = "preview-btn";
      previewBtn.textContent = "▶";
      previewBtn.title = "Preview this track";
      previewBtn.addEventListener("click", () => {
        ws.setTime(points[i]);
        ws.play();
        const onTime = (t) => {
          if (t >= points[i + 1]) {
            ws.pause();
            ws.un("timeupdate", onTime);
          }
        };
        ws.on("timeupdate", onTime);
      });

      const removeBtn = document.createElement("button");
      removeBtn.className = "remove-btn";
      removeBtn.title = "Remove this split";
      removeBtn.textContent = "✕";
      if (i > 0) {
        removeBtn.addEventListener("click", () => {
          const names = getTrackNames();
          splitPoints.splice(i - 1, 1);
          const newExcluded = new Set();
          excludedSet.forEach((idx) => {
            if (idx < i) newExcluded.add(idx);
            else if (idx > i) newExcluded.add(idx - 1);
          });
          excludedSet = newExcluded;
          rebuildRegions();
          restoreTrackNames(names);
        });
      } else {
        removeBtn.disabled = true;
        removeBtn.style.visibility = "hidden";
      }

      row.append(num, nameInput, times, excludeBtn, previewBtn, removeBtn);
      container.appendChild(row);
    }
  }

  function getTrackNames() {
    const names = {};
    document.querySelectorAll(".track-name").forEach((input) => {
      names[input.dataset.index] = input.value;
    });
    return names;
  }

  function restoreTrackNames(names) {
    document.querySelectorAll(".track-name").forEach((input) => {
      if (names[input.dataset.index]) {
        input.value = names[input.dataset.index];
      }
    });
  }

  // ── File load (client-side) ────────────────────────────

  const fileInput = $("#file-input");
  const uploadArea = $("#upload-area");

  uploadArea.addEventListener("click", () => fileInput.click());

  uploadArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadArea.classList.add("dragover");
  });
  uploadArea.addEventListener("dragleave", () =>
    uploadArea.classList.remove("dragover")
  );
  uploadArea.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadArea.classList.remove("dragover");
    if (e.dataTransfer.files.length) {
      fileInput.files = e.dataTransfer.files;
      handleFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) handleFile(fileInput.files[0]);
  });

  async function handleFile(file) {
    if (!file.name.toLowerCase().endsWith(".mp3")) {
      alert("Please select an MP3 file.");
      return;
    }

    sourceFile = file;
    sourceArrayBuffer = await file.arrayBuffer();

    $("#upload-progress").classList.remove("hidden");
    $("#progress-text").textContent = "Loading waveform…";
    $("#progress-fill").style.width = "50%";

    const blobUrl = URL.createObjectURL(file);
    initWaveform(blobUrl);
  }

  // ── Waveform ─────────────────────────────────────────────

  function initWaveform(url) {
    if (ws) ws.destroy();
    splitPoints = [];
    excludedSet = new Set();

    regions = WaveSurfer.Regions.create();

    ws = WaveSurfer.create({
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

    ws.load(url);

    ws.on("ready", () => {
      $("#upload-section").classList.add("hidden");
      $("#editor-section").classList.remove("hidden");
      $("#total-time").textContent = fmt(ws.getDuration());
      rebuildRegions();
    });

    ws.on("timeupdate", (t) => {
      $("#current-time").textContent = fmt(t);
    });

    ws.on("interaction", () => updatePlayButton());
    ws.on("play", updatePlayButton);
    ws.on("pause", updatePlayButton);

    regions.on("region-updated", () => {
      const names = getTrackNames();
      syncSplitsFromRegions();
      rebuildRegions();
      restoreTrackNames(names);
    });
  }

  function syncSplitsFromRegions() {
    const dur = ws.getDuration();
    const boundaries = new Set();
    regions.getRegions().forEach((r) => {
      if (r.start > 0.05) boundaries.add(Math.round(r.start * 100) / 100);
      if (Math.abs(r.end - dur) > 0.05)
        boundaries.add(Math.round(r.end * 100) / 100);
    });
    splitPoints = [...boundaries].sort((a, b) => a - b);
  }

  function updatePlayButton() {
    if (!ws) return;
    $("#play-btn").innerHTML = ws.isPlaying()
      ? "&#9646;&#9646; Pause"
      : "&#9654; Play";
  }

  // ── Controls ─────────────────────────────────────────────

  $("#play-btn").addEventListener("click", () => {
    if (!ws) return;
    ws.playPause();
  });

  $("#add-marker-btn").addEventListener("click", () => {
    if (!ws) return;
    const t = ws.getCurrentTime();
    if (t < 0.1 || t > ws.getDuration() - 0.1) return;
    if (splitPoints.some((p) => Math.abs(p - t) < 0.5)) return;

    const names = getTrackNames();
    splitPoints.push(Math.round(t * 100) / 100);
    splitPoints.sort((a, b) => a - b);
    rebuildRegions();
    restoreTrackNames(names);
  });

  $("#zoom-slider").addEventListener("input", (e) => {
    if (!ws) return;
    ws.zoom(Number(e.target.value));
  });

  // ── Export (client-side: ffmpeg.wasm + browser-id3-writer + JSZip) ──

  $("#export-btn").addEventListener("click", async () => {
    if (!ws || !sourceArrayBuffer) return;

    const dur = ws.getDuration();
    const points = [0, ...splitPoints, dur];
    const tracks = [];

    for (let i = 0; i < points.length - 1; i++) {
      if (excludedSet.has(i)) continue;
      const nameInput = document.querySelector(`.track-name[data-index="${i}"]`);
      tracks.push({
        name: nameInput?.value || `Track ${tracks.length + 1}`,
        start: points[i],
        end: points[i + 1],
      });
    }

    if (tracks.length === 0) {
      alert("All segments are excluded. Include at least one track to export.");
      return;
    }

    const status = $("#export-status");
    const artist = $("#artist-input").value;
    const album = $("#album-input").value;

    status.classList.remove("hidden");
    status.textContent = "Loading ffmpeg…";
    $("#export-btn").disabled = true;

    try {
      const ffmpeg = await loadFFmpeg();

      status.textContent = "Writing source file…";
      await ffmpeg.writeFile("input.mp3", new Uint8Array(sourceArrayBuffer));

      const zip = new JSZip();

      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        const safeName = track.name.replace(/[<>:"/\\|?*]/g, "_").trim();
        const outName = `${String(i + 1).padStart(2, "0")} - ${safeName}.mp3`;

        status.textContent = `Splitting track ${i + 1} of ${tracks.length}…`;

        const ss = fmtTimestamp(track.start);
        const to = fmtTimestamp(track.end);
        await ffmpeg.exec([
          "-i", "input.mp3",
          "-ss", ss,
          "-to", to,
          "-c", "copy",
          "-write_xing", "0",
          "-map_metadata", "-1",
          `out_${i}.mp3`,
        ]);

        const data = await ffmpeg.readFile(`out_${i}.mp3`);
        await ffmpeg.deleteFile(`out_${i}.mp3`);

        status.textContent = `Tagging track ${i + 1} of ${tracks.length}…`;

        const writer = new ID3Writer(data.buffer);
        writer.setFrame("TIT2", track.name);
        if (artist) writer.setFrame("TPE1", [artist]);
        if (album) writer.setFrame("TALB", album);
        writer.setFrame("TRCK", String(i + 1));
        writer.addTag();

        zip.file(outName, writer.arrayBuffer);
      }

      await ffmpeg.deleteFile("input.mp3");

      status.textContent = "Creating zip…";
      const blob = await zip.generateAsync({ type: "blob" });

      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (album || "tracks") + ".zip";
      a.click();
      URL.revokeObjectURL(a.href);
      status.textContent = "Export complete!";
    } catch (err) {
      status.textContent = "Error: " + err.message;
      console.error(err);
    } finally {
      $("#export-btn").disabled = false;
    }
  });
})();
