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

test("compile names empty lyric tags like the unsung bars of the score where they are", () => {
  const tl = Timeline.build(ABC);
  const words = "[Verse]\nsevdim seni deli gibi gel artık\n\n[Chorus]\ngel gör beni aşkın";
  const lyrics = `[Giriş]\n\n${words.replace("\n\n[Chorus]", "\n\n[Solo]\n\n[Chorus]")}\n\n[Instrumental]\n`;
  const map = Align.autoAlign(tl, lyrics);
  const out = Arrange.compile({ abc: ABC, lyrics, map, tracks: [], style: "pop" });
  const labels = ScoreModel.sections(ScoreModel.parse(out.abc)).map((r) => r.label);
  assert.deepStrictEqual(labels, ["intro", "verse", "chorus", "outro"]);
  assert.ok(out.lyrics.startsWith("[Intro]\n\n[Verse]\n"), out.lyrics);
  assert.ok(out.lyrics.endsWith("\n\n[Outro]"), "[Instrumental] after the singing is the outro");
  // No interlude bars in this score: an empty tag between sung ones keeps its own name.
  assert.ok(out.lyrics.includes("\n[Solo]\n"), out.lyrics);
});

test("chords: kept apart from the notes, written back where they start, carried by edits and pastes", () => {
  const abc = 'X:1\nL:1/8\nM:4/4\nK:C\n% verse\nV: Vocal\n"C"c4"Am"d4|"F"Z|e8|\nV: Ins\nZ3|\n';
  const model = ScoreModel.parse(abc);
  assert.deepStrictEqual(model.bars.map((b) => [b.vocal, b.chords.map((c) => `${c.at}:${c.name}`)]),
    [["c4d4", ["0:C", "4:Am"]], ["Z", ["0:F"]], ["e8", []]]);
  assert.strictEqual(ScoreModel.serialize(model).text, abc.replace('"F"Z|', '"F"z8|'), "a chord on a full-bar rest is not compressed");
  // A chord inside a note splits it with a tie; inside a rest it splits the rest; reading it back gives the same.
  const split = { ...model, bars: model.bars.map((b, i) => (i === 2 ? { ...b, chords: [{ at: 2, name: "G7" }] } : i === 1 ? { ...b, chords: [{ at: 6, name: "C" }] } : b)) };
  const text = ScoreModel.serialize(split).text;
  assert.ok(text.includes('|z6"C"z2|e2-"G7"e6|'), text);
  const back = ScoreModel.parse(text);
  assert.deepStrictEqual(back.bars.map((b) => b.chords), split.bars.map((b) => b.chords));
  assert.deepStrictEqual(ScoreModel.voiceLine(back, "vocal").notes.map((n) => n.dur), [4, 4, 8], "the tied parts are one note");
  // Note edits keep the bar's chords.
  const edited = ScoreModel.editNote(model, "vocal", { bar: 0, note: 1 }, "pitch", { semitones: 2 }).model;
  assert.deepStrictEqual(edited.bars[0].chords, model.bars[0].chords);
  // A paste moves the chords after it on with the music and brings the clip's chords along.
  const clip = ScoreModel.clipNotes(model, { vocal: [4] });
  assert.deepStrictEqual(clip.chords, [{ off: 0, name: "Am" }]);
  const pasted = ScoreModel.pasteNotes(model, 8, clip).model;
  assert.deepStrictEqual(ScoreModel.chordLine(pasted), [{ u: 0, name: "C" }, { u: 4, name: "Am" }, { u: 8, name: "Am" }, { u: 12, name: "F" }]);
  // Sent with the chords: mode full; without: they are left out and the mode is melody.
  const withChords = Arrange.compile({ abc, lyrics: "", map: [], style: "pop" });
  assert.strictEqual(withChords.cot, "full");
  assert.ok(withChords.abc.includes('"C"c4"Am"d4|'));
  const free = Arrange.compile({ abc, lyrics: "", map: [], style: "pop", chords: false });
  assert.strictEqual(free.cot, "melody");
  assert.ok(!free.abc.includes('"'), free.abc);
  assert.strictEqual(Arrange.compile({ abc: ABC, lyrics: "", map: [], style: "pop" }).cot, "melody", "a score without chords is melody");
});

test("borrowChords puts another extraction's chords into an edited score by time, notes untouched", () => {
  const mine = "X:1\nL:1/8\nM:4/4\nQ:1/4=120\nK:C\n% verse\nV: Vocal\nc2d2e2f2|g8|a8|\nV: Ins\nZ3|\n";
  // The newer extraction: a pickup bar more at the start (4 units = 1 s at 120 bpm), its own notes.
  // Its note unit is a sixteenth (mine an eighth), so the same moment is twice as many units there.
  const newer = 'X:1\nL:1/16\nM:2/4\nQ:1/4=120\nK:C\nV: Vocal\nZ|"C"e4e4|"Am"d8|"F"c6"G"c2|z8|"Dm"c8|z8|z8|"E"c8|\nV: Ins\nZ9|\n';
  const out = Arrange.borrowChords(mine, newer);
  const model = ScoreModel.parse(out.abc);
  // Times: C at 1 s → my unit 4, Am 2 s → 8, F 3 s → 12, G 3.75 s → 15, Dm 5 s → 20; E at 8 s is past my end.
  assert.deepStrictEqual(ScoreModel.chordLine(model), [{ u: 4, name: "C" }, { u: 8, name: "Am" }, { u: 12, name: "F" }, { u: 15, name: "G" }, { u: 20, name: "Dm" }]);
  assert.strictEqual(out.count, 5);
  assert.strictEqual(out.dropped, 1);
  assert.deepStrictEqual(ScoreModel.voiceLine(model, "vocal").notes, ScoreModel.voiceLine(ScoreModel.parse(mine), "vocal").notes, "the notes stay");
});

test("suggestChords harmonizes a melody in its key, from the notes alone", () => {
  const score = (key, vocal) => `X:1\nL:1/8\nM:4/4\nQ:1/4=100\nK:${key}\n% verse\nV: Vocal\n${vocal}\nV: Ins\n${"z8|".repeat(vocal.split("|").length - 1)}\n`;
  const names = (abc) => ScoreModel.chordLine(ScoreModel.parse(abc)).map((c) => `${c.u}:${c.name}`).join(" ");
  const c = Arrange.suggestChords(score("C", "c2e2g2e2|f2a2c'2a2|g2b2d'2b2|c'8|"));
  assert.strictEqual(c.key, "C");
  assert.strictEqual(names(c.abc), "0:C 8:F 16:G 24:C");
  // Written with Eb's signature, but the melody circles F, A♭ and C: the key is F minor, spelled with flats.
  const fm = Arrange.suggestChords(score("Eb", "F2A2c2A2|F2A2c2f2|G2B2d2B2|e2c2A2F2|F2A2c2A2|F8|"));
  assert.strictEqual(fm.key, "Fm");
  const used = new Set(ScoreModel.chordLine(ScoreModel.parse(fm.abc)).map((x) => x.name));
  assert.ok(used.has("Fm") && [...used].every((n) => ["Fm", "Ab", "Bbm", "C", "Cm", "Db", "Eb"].includes(n)), [...used].join(","));
  assert.ok(names(fm.abc).startsWith("0:Fm") && names(fm.abc).endsWith(":Fm"), names(fm.abc));
  // The notes are untouched.
  assert.deepStrictEqual(ScoreModel.voiceLine(ScoreModel.parse(c.abc), "vocal").notes.length, 13);
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

test("removeNotes, clipNotes and pasteNotes: delete, copy and paste making room", () => {
  const model = ScoreModel.parse(ABC);
  // Intro: c8d8e8z8|g16e16| at units 0, 8, 16, 32, 48.
  const gone = ScoreModel.removeNotes(model, "vocal", [8, 16]);
  assert.strictEqual(gone.bars[0].vocal, "c8z24");
  assert.strictEqual(gone.bars[1].vocal, "g16e16", "the rest stays where it was");
  const clip = ScoreModel.clipNotes(model, { vocal: [8, 16] });
  assert.deepStrictEqual(clip, { length: 16, vocal: [{ off: 0, dur: 8, midi: 74 }, { off: 8, dur: 8, midi: 76 }], ins: [], chords: [] });
  // Pasted inside c (unit 4): the clip goes in front of it, everything (Ins too) moves 16 on.
  const pasted = ScoreModel.pasteNotes(model, 4, clip);
  assert.strictEqual(pasted.at, 0);
  assert.strictEqual(pasted.model.bars[0].vocal, "d8e8c8d8");
  assert.strictEqual(pasted.model.bars[1].vocal, "e8z8g16");
  const insBefore = ScoreModel.voiceLine(model, "ins").notes, insAfter = ScoreModel.voiceLine(pasted.model, "ins").notes;
  assert.deepStrictEqual(insAfter.map((n) => n.u0), insBefore.map((n) => n.u0 + 16));
  assert.strictEqual(pasted.model.bars.length, model.bars.length + 1, "a bar added at the end for what was pushed past it");
  // Across voices: a clip keeps the distance between its Vocal and Ins notes.
  const both = ScoreModel.clipNotes(model, { vocal: [0], ins: [ScoreModel.voiceLine(model, "ins").notes[0].u0] });
  assert.ok(both.length > 32 && both.vocal.length === 1 && both.ins.length === 1 && both.ins[0].off > 0);
  assert.strictEqual(ScoreModel.clipNotes(model, { vocal: [3] }), null);
});

test("insertSyllables puts pasted lyrics where their notes went; retag makes syllables a section", () => {
  const lyrics = "[Verse]\nbir iki üç\ndört beş\n[Chorus]\naltı yedi";   // 10 syllables on notes 0-9
  const map = [...Array(10).keys()];
  const shifted = (from, by) => map.map((m) => (m >= from ? m + by : m));
  // Inside a line, in front of the note it went before.
  let out = LyricsLayout.insertSyllables(lyrics, shifted(3, 2), "gelir", [3, 4]);
  assert.strictEqual(out.lyrics, "[Verse]\nbir iki gelir üç\ndört beş\n[Chorus]\naltı yedi");
  assert.deepStrictEqual(out.map, [...Array(12).keys()]);
  // Between two sections: at the end of the one before.
  out = LyricsLayout.insertSyllables(lyrics, shifted(6, 2), "gelir", [6, 7]);
  assert.strictEqual(out.lyrics, "[Verse]\nbir iki üç\ndört beş\ngelir\n[Chorus]\naltı yedi");
  // At the start of a line: a line of its own.
  out = LyricsLayout.insertSyllables(lyrics, shifted(4, 1), "son", [4]);
  assert.strictEqual(out.lyrics, "[Verse]\nbir iki üç\nson\ndört beş\n[Chorus]\naltı yedi");

  assert.strictEqual(LyricsLayout.retag(lyrics, 4, 7, "Bridge"), "[Verse]\nbir iki üç\n[Bridge]\ndört beş\naltı\n[Chorus]\nyedi");
  assert.strictEqual(LyricsLayout.retag(lyrics, 3, 5, "Chorus"), "[Verse]\nbir iki\n[Chorus]\nüç\ndört beş\naltı yedi", "joins the chorus after it");
  assert.strictEqual(LyricsLayout.retag(lyrics, 6, 7, "Verse"), "[Verse]\nbir iki üç\ndört beş\naltı\n[Chorus]\nyedi", "joins the verse before it");
  assert.strictEqual(LyricsLayout.retag(lyrics, 0, 9, "Bridge"), "[Bridge]\nbir iki üç\ndört beş\naltı yedi");
  assert.strictEqual(LyricsLayout.retag(lyrics, 1, 1, "Bridge"), "[Verse]\nbir\n[Bridge]\niki\n[Verse]\nüç\ndört beş\n[Chorus]\naltı yedi", "widened to the whole word");
  for (const [a, b] of [[4, 7], [3, 5], [0, 9], [1, 1]]) assert.strictEqual(LyricsLayout.allSyllables(LyricsLayout.retag(lyrics, a, b, "X")).length, 10);
});

test("moveNotes moves picked notes in time and pitch and overwrites what they land on", () => {
  const model = ScoreModel.parse(ABC);
  // Intro: c8d8e8z8|g16e16| at units 0, 8, 16, 32, 48.
  const later = ScoreModel.moveNotes(model, { vocal: [0, 8] }, 4);
  assert.strictEqual(later.model.bars[0].vocal, "z4c8d8e4z8", "e is cut where d now ends");
  assert.strictEqual(later.overwritten, 1);
  const up = ScoreModel.moveNotes(model, { vocal: [8] }, 0, 2);
  assert.strictEqual(up.model.bars[0].vocal, "c8e8e8z8");
  assert.strictEqual(up.overwritten, 0);
  const over = ScoreModel.moveNotes(model, { vocal: [16] }, -8);
  assert.strictEqual(over.model.bars[0].vocal, "c8e8z16", "d is gone under e");
  const tail = ScoreModel.moveNotes(model, { vocal: [16] }, -4);
  assert.strictEqual(tail.model.bars[0].vocal, "c8d4e8z12", "d keeps the part before e");
  assert.throws(() => ScoreModel.moveNotes(model, { vocal: [0] }, -1), /başından/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log("ok  ", name); } catch (error) { failed++; console.log("FAIL", name, "\n   ", error.message); }
}
process.exit(failed ? 1 : 0);
