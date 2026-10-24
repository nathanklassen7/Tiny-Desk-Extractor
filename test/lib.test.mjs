import test from "node:test";
import assert from "node:assert/strict";
import {
  fmt,
  fmtTimestamp,
  sanitizeFilename,
  createModel,
  addSplit,
  removeSplit,
  moveSplit,
  exportList,
  segmentPoints,
  MIN_SEGMENT,
} from "../static/lib.js";

const DUR = 100;

test("fmt", () => {
  assert.equal(fmt(0), "0:00");
  assert.equal(fmt(65.9), "1:05");
  assert.equal(fmt(4503), "75:03");
  assert.equal(fmt(-3), "0:00");
  assert.equal(fmt(NaN), "0:00");
});

test("fmtTimestamp never emits 60 seconds", () => {
  assert.equal(fmtTimestamp(0), "00:00:00.00");
  assert.equal(fmtTimestamp(59.996), "00:01:00.00");
  assert.equal(fmtTimestamp(3661.5), "01:01:01.50");
  assert.equal(fmtTimestamp(12.345), "00:00:12.35");
});

test("sanitizeFilename", () => {
  assert.equal(sanitizeFilename('A/B:C*"D'), "A_B_C__D");
  assert.equal(sanitizeFilename("  .hidden.  "), "hidden");
  assert.equal(sanitizeFilename("", "Track 1"), "Track 1");
  assert.equal(sanitizeFilename("..."), "untitled");
  assert.equal(sanitizeFilename("a\u0000b\nc"), "a_b_c");
  assert.ok(sanitizeFilename("x".repeat(500)).length <= 100);
});

test("addSplit inserts and inherits exclusion", () => {
  let m = createModel();
  m.tracks[0].name = "Intro";
  m.tracks[0].excluded = true;
  m = addSplit(m, 40, DUR);
  assert.deepEqual(m.splits, [40]);
  assert.equal(m.tracks.length, 2);
  assert.deepEqual(m.tracks[0], { name: "Intro", excluded: true });
  assert.deepEqual(m.tracks[1], { name: "", excluded: true });
});

test("addSplit shifts later track metadata correctly", () => {
  let m = createModel();
  m = addSplit(m, 50, DUR);
  m.tracks[1].name = "Second";
  m.tracks[1].excluded = true;
  m = addSplit(m, 20, DUR);
  assert.deepEqual(m.splits, [20, 50]);
  assert.equal(m.tracks[2].name, "Second");
  assert.equal(m.tracks[2].excluded, true);
  assert.equal(m.tracks[1].excluded, false);
});

test("addSplit rejects too-close or out-of-range times", () => {
  let m = addSplit(createModel(), 50, DUR);
  assert.equal(addSplit(m, 50.2, DUR), null);
  assert.equal(addSplit(m, 0.1, DUR), null);
  assert.equal(addSplit(m, DUR - 0.1, DUR), null);
  assert.equal(addSplit(m, DUR + 5, DUR), null);
  assert.equal(addSplit(m, NaN, DUR), null);
  assert.notEqual(addSplit(m, 50 + MIN_SEGMENT, DUR), null);
});

test("removeSplit merges segments and keeps names", () => {
  let m = createModel();
  m = addSplit(m, 30, DUR);
  m = addSplit(m, 60, DUR);
  m.tracks[0].name = "A";
  m.tracks[1].name = "B";
  m.tracks[2].name = "C";
  m.tracks[1].excluded = true;
  const r = removeSplit(m, 1);
  assert.deepEqual(r.splits, [60]);
  assert.deepEqual(r.tracks.map((t) => t.name), ["A", "C"]);
  assert.equal(r.tracks[0].excluded, false);
  assert.equal(removeSplit(m, 0), m);
});

test("moveSplit clamps against neighbours", () => {
  let m = createModel();
  m = addSplit(m, 30, DUR);
  m = addSplit(m, 60, DUR);
  assert.deepEqual(moveSplit(m, 0, 70, DUR).splits, [60 - MIN_SEGMENT, 60]);
  assert.deepEqual(moveSplit(m, 0, -5, DUR).splits, [MIN_SEGMENT, 60]);
  assert.deepEqual(moveSplit(m, 1, 99.9, DUR).splits, [30, DUR - MIN_SEGMENT]);
  assert.deepEqual(moveSplit(m, 1, 45.123, DUR).splits, [30, 45.12]);
  assert.equal(moveSplit(m, 5, 10, DUR), m);
});

test("exportList numbers only included tracks", () => {
  let m = createModel();
  m = addSplit(m, 10, DUR);
  m = addSplit(m, 20, DUR);
  m.tracks[0].excluded = true;
  m.tracks[2].name = "  Closer ";
  const list = exportList(m, DUR);
  assert.deepEqual(list, [
    { number: 1, name: "Track 1", start: 10, end: 20 },
    { number: 2, name: "Closer", start: 20, end: DUR },
  ]);
  assert.deepEqual(segmentPoints(m, DUR), [0, 10, 20, DUR]);
});
