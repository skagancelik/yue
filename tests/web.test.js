// Tests for the browser's score logic (no browser needed): node tests/web.test.js
"use strict";
const assert = require("assert");
global.ScoreModel = require("../web/score-model.js");
global.LyricsLayout = require("../web/lyrics-layout.js");
global.Timeline = require("../web/timeline.js");
global.Align = require("../web/align.js");
global.Arrange = require("../web/arrange.js");

// A SheetSage2-like score: a hummed two-bar intro in Vocal (Ins empty), a four-bar verse, a
// four-bar chorus and a two-bar outro played by Ins. 4/4, L:1/32 (32 units a bar), 96 BPM.
const ABC = `X:1
T:
M:4/4
L:1/32
Q:1/4=96
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:C
% intro
V: Vocal
c8d8e8z8|g16e16|
V: Ins
Z2|
% verse
V: Vocal
c8c8d8e8|f8e8d8z8|e8e8f8g8|a16g8z8|
V: Ins
Z4|
% chorus
V: Vocal
c'8b8a8g8|a8g8f8z8|e8f8g8a8|g24z8|
V: Ins
Z4|
% outro
V: Vocal
Z2|
V: Ins
c16G16|C32|
`;

const LYRICS = `[Verse]
Gel gör be-ni aş-kın
Ne yap-tı bil-mez-sin

[Chorus]
Sev-dim se-ni de-li gi-bi
Gel ar-tık`.replace(/-/g, "");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("phrases cut at rests and section starts", () => {
  const tl = Timeline.build(ABC);
  const ps = Align.phrases(tl);
  assert.deepStrictEqual(ps.map((p) => p.notes.length), [3, 2, 7, 6, 7, 5]);
  assert.deepStrictEqual(ps.map((p) => p.name), ["intro", null, "verse", null, "chorus", null]);
});

test("autoAlign puts each lyric section on its score section and skips the hummed intro", () => {
  const tl = Timeline.build(ABC);
  const map = Align.autoAlign(tl, LYRICS);
  const sylls = LyricsLayout.allSyllables(LYRICS);
  assert.strictEqual(map.length, sylls.length);
  assert.ok(map.every((n) => n != null), "every syllable on a note");
  // The first verse syllable on the first verse note (note 5: the intro has 5 notes).
  assert.strictEqual(map[0], 5);
  const chorusStart = sylls.findIndex((s) => s.section === 1);
  assert.strictEqual(tl.vocal[map[chorusStart]].bar, 6, "chorus starts on bar 7");
  assert.strictEqual(LyricsLayout.checkMap(map, tl.vocal.length), null);
});

test("flow lays a word from the drop note and pushes what is in the way", () => {
  const map = [0, 1, 2, 3, 4, 5];
  const out = Align.flow(map, [1, 2], 3, 10);
  assert.deepStrictEqual(out.map, [0, 3, 4, 5, 6, 7]);
  assert.strictEqual(out.pushed, 3);
  const left = Align.flow(map, [4], 1, 10);
  assert.deepStrictEqual(left.map, [null, null, null, 0, 1, 5], "earlier ones pushed left, off the start");
  assert.strictEqual(left.lost, 3);
  const keep = Align.flow([0, 2, 2, 5], [0, 1, 2], 1, 10, true);
  assert.deepStrictEqual(keep.map, [1, 3, 3, 5], "keepShape keeps distances and the shared note");
  assert.strictEqual(typeof Align.flow(map, [5], 12, 10), "string");
});

test("wordOf finds the syllables of one word", () => {
  const sylls = LyricsLayout.allSyllables("[Verse]\nsevdim seni");
  assert.deepStrictEqual(sylls.map((s) => s.text), ["sev", "dim", "se", "ni"]);
  assert.deepStrictEqual(Align.wordOf(sylls, 1), [0, 1]);
  assert.deepStrictEqual(Align.wordOf(sylls, 2), [2, 3]);
});

test("compile: unsung intro goes to Ins, sections follow the lyrics, style gets tracks and tempo", () => {
  const tl = Timeline.build(ABC);
  const map = Align.autoAlign(tl, LYRICS);
  const tracks = [
    { instrument: "strings", feel: ["energetic"], bars: [[6, 9]], text: "", lead: false },
    { instrument: "piano", feel: ["soft"], bars: null, text: "", lead: false },
  ];
  const out = Arrange.compile({ abc: ABC, lyrics: LYRICS, map, tracks, style: "Turkish pop, male vocal" });
  const model = ScoreModel.parse(out.abc);
  const runs = ScoreModel.sections(model);
  assert.deepStrictEqual(runs.map((r) => [r.label, r.sung]), [["intro", false], ["verse", true], ["chorus", true], ["outro", false]]);
  assert.strictEqual(model.bars[0].vocal, "Z");
  assert.strictEqual(model.bars[0].ins, "c8d8e8z8", "the hummed intro is played");
  assert.strictEqual(out.style, "Turkish pop, male vocal, energetic strings in the chorus, soft piano, 96 BPM");
  assert.ok(out.lyrics.startsWith("[Verse]\n"));
  // The syllables stay on the same notes (by time) in the compiled score.
  const tl2 = Timeline.build(out.abc);
  const again = Timeline.mapFromOnsets(tl2, out.at);
  assert.strictEqual(again.filter((n) => n != null).length, map.length);
  assert.ok(out.report.some((r) => /enstrümana verildi/.test(r.text)));
});

test("compile renames score sections after where the lyrics were put", () => {
  const tl = Timeline.build(ABC);
  const lyrics = "[Nakarat]\nsevdim seni deli gibi gel artık\n\n[Kıta]\ngel gör beni aşkın";
  const sylls = LyricsLayout.allSyllables(lyrics);
  // The chorus lyrics on the verse bars and the verse lyrics on the chorus bars.
  const map = sylls.map((s, g) => (s.section === 0 ? 5 + g : 12 + (g - sylls.findIndex((x) => x.section === 1))));
  const out = Arrange.compile({ abc: ABC, lyrics, map, tracks: [], style: "pop" });
  const runs = ScoreModel.sections(ScoreModel.parse(out.abc));
  assert.deepStrictEqual(runs.filter((r) => r.sung).map((r) => r.label), ["chorus", "verse"]);
  assert.ok(out.lyrics.startsWith("[Chorus]\n") && out.lyrics.includes("\n[Verse]\n"));
});

test("scopeText names sections and bars", () => {
  const model = ScoreModel.parse(ABC);
  const runs = ScoreModel.sections(model);
  assert.strictEqual(Arrange.scopeText([[0, 1], [10, 11]], runs, 12), "in the intro and the outro");
  assert.strictEqual(Arrange.scopeText([[3, 3]], runs, 12), "in bar 4");
  assert.strictEqual(Arrange.scopeText([[0, 11]], runs, 12), "");
  assert.strictEqual(Arrange.trackPhrase({ instrument: "saxophone", feel: [], lead: true, bars: [[10, 11]], text: "breathy" }, runs, 12),
    "saxophone playing the main melody breathy in the outro");
});

test("compile hands the hum after the last syllable to the instrument note by note, ties included", () => {
  // One verse line of three syllables; the phrase goes on humming for two more bars, tied over.
  const abc = ABC.replace("% chorus\nV: Vocal\nc'8b8a8g8|a8g8f8z8|e8f8g8a8|g24z8|", "% chorus\nV: Vocal\nc'8b8a8g8|a8g8f8g8-|g8f8e8d8|c24z8|");
  const lyrics = "[Verse]\nGel gör beni aşkın\nNe yaptı bilmezsin\n\n[Chorus]\nSev dim se";
  const tl = Timeline.build(abc);
  const map = Align.autoAlign(tl, lyrics);
  const out = Arrange.compile({ abc, lyrics, map, tracks: [], style: "pop" });
  const model = ScoreModel.parse(out.abc);
  // "se" keeps a short melisma (bar 7 and the start of bar 8); the hum after it, tied over the
  // barline, goes to Ins with all its parts, and the outro starts where the singing ends.
  assert.strictEqual(model.bars[6].vocal, "c'8b8a8g8");
  assert.strictEqual(model.bars[7].vocal, "a8g8z16");
  assert.strictEqual(model.bars[7].ins, "z16f8g8-");
  assert.strictEqual(model.bars[8].vocal, "Z");
  assert.strictEqual(model.bars[8].ins, "g8f8e8d8");
  assert.deepStrictEqual(model.bars[8].labels, ["outro"]);
  const sung = ScoreModel.sections(model).filter((r) => r.sung).map((r) => r.label);
  assert.deepStrictEqual(sung, ["verse", "chorus"]);
  assert.ok(out.report.some((r) => /söylenen notaların yanındaki/.test(r.text)));
});

test("editNote place: a new note inside a rest, at a pitch", () => {
  const model = ScoreModel.parse(ABC);
  // Intro bar 1 ends with a rest (z8): put a 4-unit c (MIDI 72) 4 units into it.
  const out = ScoreModel.editNote(model, "vocal", { bar: 0, note: 3 }, "place", { offset: 4, dur: 4, midi: 72 });
  assert.strictEqual(out.model.bars[0].vocal, "c8d8e8z4c4");   // c = MIDI 72 in this dialect
  assert.deepStrictEqual(out.sel, { bar: 0, note: 4 });
  // A rest written in two parts (z4z for 5) is still one item, so sel finds the new note.
  const odd = ScoreModel.editNote(model, "vocal", { bar: 0, note: 3 }, "place", { offset: 5, dur: 2, midi: 72 });
  assert.strictEqual(odd.model.bars[0].vocal, "c8d8e8z4zc2z");
  const picked = ScoreModel.voiceNotes(ScoreModel.parse(ScoreModel.serialize(odd.model).text), "vocal")[0].notes[odd.sel.note];
  assert.ok(!picked.rest && picked.midi === 72, "sel is the new note after reading the score again");
  assert.throws(() => ScoreModel.editNote(model, "vocal", { bar: 0, note: 0 }, "place", { midi: 72 }), /zaten nota/);
  // In an empty bar of the other voice.
  const ins = ScoreModel.editNote(model, "ins", { bar: 0, note: 0 }, "place", { offset: 8, dur: 8, midi: 60 });
  assert.strictEqual(ins.model.bars[0].ins, "z8C8z16");
});

test("editNote longer goes over the barline into a rest, tied", () => {
  const abc = ABC.replace("c8c8d8e8|f8e8d8z8|", "c8c8d8e8|z8e8d8f8|");
  const model = ScoreModel.parse(abc);
  // Verse bar 1 ends on e8; bar 2 starts with a rest.
  const out = ScoreModel.editNote(model, "vocal", { bar: 2, note: 3 }, "longer", { step: 4 });
  assert.strictEqual(out.model.bars[2].vocal, "c8c8d8e8-");
  assert.strictEqual(out.model.bars[3].vocal, "e4z4e8d8f8");
  const tl = Timeline.fromModel(out.model);
  const held = tl.vocal.find((n) => n.bar === 2 && n.k === 3);
  assert.strictEqual(held.u1 - held.u0, 12, "one held note of 8 + 4 units");
  assert.throws(() => ScoreModel.editNote(out.model, "vocal", { bar: 3, note: 4 }, "longer", { step: 4 }), /notayla başlıyor/);
});

test("moveNote: a note slides into silence, over a barline tied, never onto another note", () => {
  const model = ScoreModel.parse(ABC);
  const out = ScoreModel.moveNote(model, "vocal", 16, 24, 76);   // intro e8 to the end of bar 1
  assert.strictEqual(out.model.bars[0].vocal, "c8d8z8e8");
  assert.deepStrictEqual(out.sel, { bar: 0, note: 3 });
  const up = ScoreModel.moveNote(model, "vocal", 16, 20, 77);    // and a semitone up
  assert.strictEqual(up.model.bars[0].vocal, "c8d8z4f8z4");
  assert.throws(() => ScoreModel.moveNote(model, "vocal", 8, 12, 74), /başka nota/);
  const abc = ABC.replace("c8c8d8e8|f8e8d8z8|", "c8c8d8e8|z8e8d8f8|");
  const tied = ScoreModel.moveNote(ScoreModel.parse(abc), "vocal", 88, 92, 76);
  assert.strictEqual(tied.model.bars[2].vocal, "c8c8d8z4e4-");
  assert.strictEqual(tied.model.bars[3].vocal, "e4z4e8d8f8");
  // The held note moves back as one note.
  const back = ScoreModel.moveNote(tied.model, "vocal", 92, 88, 76);
  assert.strictEqual(back.model.bars[2].vocal, "c8c8d8e8");
  assert.strictEqual(back.model.bars[3].vocal, "z8e8d8f8");
});

test("shiftFrom, resizeNote and insertBefore keep every note and move what follows", () => {
  const model = ScoreModel.parse(ABC);
  // Intro: c8d8e8z8|g16e16| at units 0, 8, 16, 32, 48.
  const later = ScoreModel.shiftFrom(model, "vocal", 8, 4);
  assert.strictEqual(later.model.bars[0].vocal, "c8z4d8e8z4");
  assert.strictEqual(later.model.bars[1].vocal, "z4g16e12-", "everything after moves too");
  assert.strictEqual(later.model.bars[2].vocal, "e4c8c8d8e4-");
  assert.deepStrictEqual(later.sel, { bar: 0, note: 2 });
  assert.throws(() => ScoreModel.shiftFrom(model, "vocal", 8, -4), /Önceki notaya/);
  // Right edge longer, rippling: d8 becomes d12, e and the rest move 4 on; nothing is cut.
  const longer = ScoreModel.resizeNote(model, "vocal", 8, 8, 20, "ripple");
  assert.strictEqual(longer.model.bars[0].vocal, "c8d12e8z4");
  assert.deepStrictEqual(longer.sel, { voice: "vocal", bar: 0, note: 1 });
  // Shorter, rippling back.
  const shorter = ScoreModel.resizeNote(model, "vocal", 8, 8, 12, "ripple");
  assert.strictEqual(shorter.model.bars[0].vocal, "c8d4e8z8g4-");
  // Left edge onto the note before, rippling: the note grows and it and the rest move on.
  const left = ScoreModel.resizeNote(model, "vocal", 8, 4, 16, "ripple");
  assert.strictEqual(left.model.bars[0].vocal, "c8d12e8z4");
  // Overlap: the note goes to Ins, sounding together with e.
  const both = ScoreModel.resizeNote(model, "vocal", 8, 8, 24, "overlap");
  assert.strictEqual(both.model.bars[0].vocal, "c8z8e8z8");
  assert.strictEqual(both.model.bars[0].ins, "z8d16z8");
  assert.deepStrictEqual(both.sel, { voice: "ins", bar: 0, note: 1 });
  assert.throws(() => ScoreModel.resizeNote(model, "vocal", 8, 8, 24, "plain"), /üst üste/);
  // Pushed past the end: a bar is added.
  const pushed = ScoreModel.shiftFrom(model, "vocal", 0, 32 * 15);
  assert.strictEqual(pushed.model.bars.length, 25);
  assert.strictEqual(pushed.model.bars[24].vocal, "g24z8");
  // Bars before the change keep their text.
  assert.strictEqual(ScoreModel.shiftFrom(model, "vocal", 48, 4).model.bars[0].vocal, "c8d8e8z8");
  // A new note in front of d, which moves on.
  const added = ScoreModel.insertBefore(model, "vocal", 8, 4, 79);
  assert.strictEqual(added.model.bars[0].vocal, "c8g4d8e8z4");
  assert.deepStrictEqual(added.sel, { bar: 0, note: 1 });
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log("ok  ", name); } catch (error) { failed++; console.log("FAIL", name, "\n   ", error.message); }
}
process.exit(failed ? 1 : 0);
