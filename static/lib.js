// Pure helpers and the track/split data model. No DOM access, so it can be
// unit-tested under Node (see test/lib.test.mjs).

export const MIN_SEGMENT = 0.5; // seconds; smallest allowed track length

export function fmt(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// HH:MM:SS.cc, as accepted by ffmpeg's -ss / -to. Rounds to centiseconds
// first so values like 59.996 become 00:01:00.00 rather than 00:00:60.00.
export function fmtTimestamp(seconds) {
  const cs = Math.max(0, Math.round((seconds || 0) * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}.${p(c)}`;
}

export function sanitizeFilename(name, fallback = "untitled") {
  const cleaned = String(name ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .slice(0, 100)
    .trim();
  return cleaned || fallback;
}

const round2 = (n) => Math.round(n * 100) / 100;

// ── Model ────────────────────────────────────────────────
// model = { splits: number[] (sorted, seconds), tracks: {name, excluded}[] }
// tracks.length === splits.length + 1; tracks[i] spans points[i]..points[i+1].

export function createModel() {
  return { splits: [], tracks: [{ name: "", excluded: false }] };
}

export function segmentPoints(model, duration) {
  return [0, ...model.splits, duration];
}

// Insert a split at time t. Returns a new model, or null if t is too close to
// an existing boundary (or the ends) to produce valid segments.
export function addSplit(model, t, duration) {
  if (!Number.isFinite(t) || !Number.isFinite(duration)) return null;
  t = round2(t);
  const points = segmentPoints(model, duration);
  let k = -1;
  for (let i = 0; i < points.length - 1; i++) {
    if (t >= points[i] && t < points[i + 1]) {
      k = i;
      break;
    }
  }
  if (k < 0) return null;
  if (t - points[k] < MIN_SEGMENT || points[k + 1] - t < MIN_SEGMENT) return null;

  const splits = model.splits.slice();
  splits.splice(k, 0, t);
  const tracks = model.tracks.slice();
  tracks.splice(k + 1, 0, { name: "", excluded: model.tracks[k].excluded });
  return { splits, tracks };
}

// Remove the boundary at the start of segment i (i >= 1), merging segment i
// into segment i-1.
export function removeSplit(model, i) {
  if (i < 1 || i >= model.tracks.length) return model;
  const splits = model.splits.slice();
  splits.splice(i - 1, 1);
  const prev = model.tracks[i - 1];
  const next = model.tracks[i];
  const tracks = model.tracks.slice();
  tracks.splice(i - 1, 2, {
    name: prev.name || next.name,
    excluded: prev.excluded && next.excluded,
  });
  return { splits, tracks };
}

// Move splits[idx] to t, clamped so neighbouring segments stay >= MIN_SEGMENT.
export function moveSplit(model, idx, t, duration) {
  if (idx < 0 || idx >= model.splits.length || !Number.isFinite(t)) return model;
  const lo = (idx > 0 ? model.splits[idx - 1] : 0) + MIN_SEGMENT;
  const hi = (idx < model.splits.length - 1 ? model.splits[idx + 1] : duration) - MIN_SEGMENT;
  if (hi < lo) return model;
  const splits = model.splits.slice();
  splits[idx] = round2(Math.min(hi, Math.max(lo, t)));
  return { splits, tracks: model.tracks };
}

// Tracks that will be exported, with start/end and a 1-based export number.
export function exportList(model, duration) {
  const points = segmentPoints(model, duration);
  const out = [];
  model.tracks.forEach((track, i) => {
    if (track.excluded) return;
    const number = out.length + 1;
    out.push({
      number,
      name: track.name.trim() || `Track ${number}`,
      start: points[i],
      end: points[i + 1],
    });
  });
  return out;
}
