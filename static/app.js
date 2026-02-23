(function () {
  "use strict";

  let ws = null;
  let regions = null;
  let currentFilename = null;
  let splitPoints = []; // seconds – sorted ascending, does NOT include 0 or duration
  let excludedSet = new Set(); // indices of segments marked as dead space

  const $ = (sel) => document.querySelector(sel);

  // ── Helpers ──────────────────────────────────────────────

  function fmt(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

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
      const prev = container.querySelector(
        `input[data-index="${i}"]`
      );
      if (prev) nameInput.value = prev.value;

      const times = document.createElement("span");
      times.className = "track-times";
      times.textContent = `${fmt(points[i])} – ${fmt(points[i + 1])}`;

      const excludeBtn = document.createElement("button");
      excludeBtn.className = "exclude-btn" + (excluded ? " active" : "");
      excludeBtn.textContent = excluded ? "Excluded" : "Skip";
      excludeBtn.title = excluded ? "Re-include this segment" : "Mark as dead space";
      excludeBtn.addEventListener("click", () => {
        const names = getTrackNames();
        if (excludedSet.has(i)) {
          excludedSet.delete(i);
        } else {
          excludedSet.add(i);
        }
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
          const removedIdx = i - 1;
          splitPoints.splice(removedIdx, 1);
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

  // Preserve track names across rebuilds
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

  // ── Source tabs ──────────────────────────────────────────

  document.querySelectorAll(".source-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".source-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.add("hidden"));
      $(`#tab-${tab.dataset.tab}`).classList.remove("hidden");
    });
  });

  // ── File upload ────────────────────────────────────────

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

  function handleFile(file) {
    if (!file.name.toLowerCase().endsWith(".mp3")) {
      alert("Please select an MP3 file.");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    $("#upload-progress").classList.remove("hidden");
    $("#progress-text").textContent = "Uploading…";
    $("#progress-fill").style.width = "0%";

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload");

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        $("#progress-fill").style.width = pct + "%";
        $("#progress-text").textContent = `Uploading… ${pct}%`;
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status === 200) {
        const data = JSON.parse(xhr.responseText);
        currentFilename = data.filename;
        $("#progress-text").textContent = "Loading waveform…";
        initWaveform(`/audio/${encodeURIComponent(data.filename)}`);
      } else {
        $("#progress-text").textContent = "Upload failed.";
      }
    });

    xhr.send(formData);
  }

  // ── YouTube download ──────────────────────────────────

  $("#yt-download-btn").addEventListener("click", async () => {
    const url = $("#yt-url").value.trim();
    if (!url) return;

    $("#upload-progress").classList.remove("hidden");
    $("#progress-fill").style.width = "0%";
    $("#progress-text").textContent = "Downloading from YouTube…";
    $("#yt-download-btn").disabled = true;

    const pulse = setInterval(() => {
      const el = $("#progress-fill");
      const cur = parseFloat(el.style.width) || 0;
      el.style.width = Math.min(cur + 0.5, 90) + "%";
    }, 300);

    try {
      const resp = await fetch("/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      clearInterval(pulse);

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || "Download failed");
      }

      const data = await resp.json();
      currentFilename = data.filename;
      $("#progress-fill").style.width = "100%";
      $("#progress-text").textContent = "Loading waveform…";

      if (data.title) {
        $("#album-input").value = data.title;
      }

      initWaveform(`/audio/${encodeURIComponent(data.filename)}`);
    } catch (err) {
      clearInterval(pulse);
      $("#progress-text").textContent = "Error: " + err.message;
    } finally {
      $("#yt-download-btn").disabled = false;
    }
  });

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

    ws.on("interaction", () => {
      updatePlayButton();
    });

    ws.on("play", updatePlayButton);
    ws.on("pause", updatePlayButton);

    regions.on("region-updated", (region) => {
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
    $("#play-btn").innerHTML = ws.isPlaying() ? "&#9646;&#9646; Pause" : "&#9654; Play";
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

  // ── Export ───────────────────────────────────────────────

  $("#export-btn").addEventListener("click", async () => {
    if (!ws || !currentFilename) return;

    const dur = ws.getDuration();
    const points = [0, ...splitPoints, dur];
    const tracks = [];

    for (let i = 0; i < points.length - 1; i++) {
      if (excludedSet.has(i)) continue;
      const nameInput = document.querySelector(
        `.track-name[data-index="${i}"]`
      );
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

    const payload = {
      filename: currentFilename,
      artist: $("#artist-input").value,
      album: $("#album-input").value,
      tracks,
    };

    const status = $("#export-status");
    status.classList.remove("hidden");
    status.textContent = "Splitting & tagging… this may take a moment.";
    $("#export-btn").disabled = true;

    try {
      const resp = await fetch("/split", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || "Export failed");
      }

      const blob = await resp.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download =
        ($("#album-input").value || "tracks") + ".zip";
      a.click();
      URL.revokeObjectURL(a.href);
      status.textContent = "Export complete!";
    } catch (err) {
      status.textContent = "Error: " + err.message;
    } finally {
      $("#export-btn").disabled = false;
    }
  });
})();
