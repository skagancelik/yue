"use strict";
// The timeline editor: the score drawn left to right like a DAW (bars and sections, the melody as
// a piano roll, the syllables as a track under it, the arrangement's instrument tracks below) with
// a playhead that follows the melody synth.
//
// It opens on a source song (the main use: its melody was extracted, the lyrics are laid on it and
// the tracks drawn before an arrangement is made) or on an arrangement (to look at what was made).
// What is saved where:
// - the score (pitches, lengths, section names, which bars are sung or played): on the source song;
//   new arrangements made from it send this score to YuE2 (ScoreModel in score-model.js edits it);
// - the syllables (which note each one sits on, their letters): on the source (or the arrangement),
//   by the unit their note starts on, so they find their notes again after the score changes;
// - the tracks (which instrument plays how, in which bars): on the source.
// YuE2 never sees the syllable layout or the tracks as such: Arrange (arrange.js) turns them into
// the score, lyrics and style it does read.

const daw = {
  ctx: "job", job: null, item: null, origin: "", model: null, abc: "", tl: null, lyrics: "", map: [], words: null, sylls: [],
  tracks: [], history: [], sel: new Set(), marked: new Set(), anchor: null, tray: null, note: null, bars: null, sung: new Set(),
  pps: 70, pos: 0, playing: false, follow: true, synth: null, startedAt: 0, raf: 0, focus: null, els: null, selMode: "word",
  scoreDirty: false, layoutDirty: false, tracksDirty: false, trackOpen: null,
  layoutFresh: false,   // an automatic layout that was never saved (saving it is offered, closing does not ask)
};
const DAW_LEFT = 84;      // the track names column

const dawCount = () => daw.tl.vocal.length;
const dawX = (t) => DAW_LEFT + t * daw.pps;
const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const dawSectionColor = (k) => `hsl(${(k * 67 + 200) % 360} 55% 42%)`;
const dawTrackColor = (k) => `hsl(${(k * 83 + 140) % 360} 50% 40%)`;
const dawDirty = () => daw.scoreDirty || daw.layoutDirty || daw.tracksDirty;
const dawMsg = (text) => { $("daw-msg").textContent = text || ""; };

// The note of every syllable on a score, from a saved layout (null = on no note). Without one (or
// for other lyrics) the lyrics are laid out along the melody's phrases.
function layoutMap(abc, lyrics, layout) {
  const total = LyricsLayout.allSyllables(lyrics).length;
  if (layout && layout.at && layout.at.length === total) {
    try { return Timeline.mapFromOnsets(Timeline.build(abc), layout.at); } catch (error) { /* laid out below */ }
  }
  if (layout && (layout.map || layout.starts && layout.starts.length || layout.holds && layout.holds.length)) {
    const words = LyricsLayout.layOut(abc, lyrics, layout);
    return LyricsLayout.toMap(words, total);
  }
  try { return Align.autoAlign(Timeline.build(abc), lyrics); } catch (error) { return new Array(total).fill(null); }
}

// From an arrangement's score window: the score this arrangement was made with. Saving an edited
// score keeps it as a new eser tasarımı of its source.
async function openDaw() {
  const job = score.job;
  const item = scoreSource();
  const lyrics = score.layout.lyrics ?? job.lyrics ?? "";
  stopScore();
  daw.design = null;
  startDaw({ ctx: "job", job, item, origin: "bu düzenlemenin notası", abc: score.abc, lyrics, map: layoutMap(score.abc, lyrics, score.layout), tracks: [], title: job.title });
}

// An eser tasarımı of a source: its score, lyrics, layout and tracks. `lyrics`: the lyrics typed in
// the form when they differ from the design's (laid out afresh and saved on it with the layout).
async function openDesignDaw(item, design, lyrics = design.lyrics || "") {
  try {
    await loadAbcjs();
    const abc = await designAbc(design);
    const own = lyrics === (design.lyrics || "");
    daw.design = design;
    const opened = startDaw({
      ctx: "source", job: null, item, abc, lyrics, title: `${item.name} · ${design.name}`,
      origin: `eser tasarımı «${design.name}»`,
      map: layoutMap(abc, lyrics, own && design.lyrics_layout ? LyricsLayout.normalize(design.lyrics_layout) : null),
      melisma: own && design.lyrics_layout && design.lyrics_layout.at ? design.lyrics_layout.melisma : null,
      tracks: JSON.parse(JSON.stringify(design.tracks || [])).map((t) => ({ ...t, id: t.id || dawId() })),
    });
    if (!opened) return;
    // An automatic layout is offered for saving like an edited one (the design's summary then
    // counts it as placed).
    const at = own && design.lyrics_layout && design.lyrics_layout.at;
    if (!(at && at.length === daw.map.length) && daw.map.length) { daw.layoutFresh = true; renderDawBar(); }
    if (!own) { daw.layoutDirty = true; renderDawBar(); }
    if (!own) dawMsg("Formdaki söz (eser tasarımında kayıtlı olandan farklı) melodiye otomatik yerleştirildi; Kaydet ile söz de eser tasarımına kaydedilir.");
  } catch (error) { report(error); }
}

async function fetchText(url, what) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${what} alınamadı (${response.status})`);
  return response.text();
}

const dawId = () => Math.random().toString(36).slice(2, 10);

function startDaw({ ctx, job, item, origin, abc, lyrics, map, melisma = null, tracks, title }) {
  let model, tl;
  try {
    model = ScoreModel.parse(abc);
    tl = Timeline.fromModel(model);
  } catch (error) {
    const message = `Zaman çizgisi açılamadı: ${error.message}`;
    if (ctx === "job") $("score-status").textContent = message; else report(new Error(message));
    return false;
  }
  Object.assign(daw, { ctx, job, item, origin, abc, model, tl, lyrics, map, melisma, tracks, history: [], sel: new Set(), marked: new Set(), anchor: null, tray: null,
    note: null, bars: null, pos: 0, focus: null, wordsKey: null, scoreDirty: false, layoutDirty: false, tracksDirty: false, trackOpen: null, layoutFresh: false });
  if (daw.map.length !== LyricsLayout.allSyllables(lyrics).length) daw.map = Align.autoAlign(tl, lyrics);
  // Zoom so a typical note is wide enough for its syllable.
  const lengths = tl.vocal.map((n) => n.t1 - n.t0).sort((a, b) => a - b);
  daw.pps = lengths.length ? Math.max(40, Math.min(400, 34 / lengths[Math.floor(lengths.length / 2)])) : 70;
  const unit = ScoreModel.unitDenominator(model);
  // Lengthen/shorten steps a musician thinks in, as L: units (only the ones the grid can hold).
  $("daw-step").replaceChildren(...[[16, "1/16"], [8, "1/8"], [4, "1/4"]]
    .filter(([den]) => unit % den === 0).map(([den, name]) => new Option(`adım ${name}`, String(unit / den))));
  if (unit % 8 === 0) $("daw-step").value = String(unit / 8);   // new notes and drags in eighths
  $("daw-title").textContent = title;
  $("daw").classList.toggle("source-mode", ctx === "source");
  const laid = daw.design && daw.design.lyrics_layout && daw.design.lyrics_layout.at;
  dawMsg(ctx === "source" && !(laid && laid.length === daw.map.length) && daw.map.length
    ? "Heceler melodinin cümlelerine göre otomatik yerleştirildi. Kelimeyi ya da satırı seçip doğru notaya sürükle; sonrakiler kendiliğinden kayar."
    : "");
  closeTrackEditor();
  $("daw").showModal();
  renderDaw();
  renderDawWords();
  $("daw-scroll").scrollLeft = 0;
  return true;
}

function carryMap(fromTl, toTl, map) {
  try { return Timeline.mapFromOnsets(toTl, Timeline.onsets(fromTl, map)); } catch (error) { return map.map(() => null); }
}

// ---- drawing

function el(tag, className, style, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (style) Object.assign(node.style, style);
  if (text != null) node.textContent = text;
  return node;
}

function lane(name, height, extraClass = "") {
  const row = el("div", "daw-lane " + extraClass, { height: height + "px" });
  row.append(el("div", "daw-label", null, name));
  return row;
}

// Bars as one set, and back to [from, to] ranges.
const barSet = (ranges, count) => {
  const on = new Set();
  for (const [a, b] of ranges || [[0, count - 1]]) for (let i = a; i <= b && i < count; i++) on.add(i);
  return on;
};
function toRanges(on) {
  const out = [];
  for (const b of [...on].sort((x, y) => x - y)) {
    const last = out[out.length - 1];
    if (last && last[1] === b - 1) last[1] = b; else out.push([b, b]);
  }
  return out;
}

// The section a syllable is in: in a source song the score's (where it is sung), else its lyric tag.
const sylSection = (g) => (daw.secOf ? daw.secOf[g] : daw.sylls[g].section);
const sylSectionName = (g) => (daw.secOf ? Arrange.tagText(daw.sections[daw.secOf[g]].label)
  : daw.words.sections[daw.sylls[g].section].tag || "söz");
const sectionSyllables = (k) => daw.sylls.filter((s) => sylSection(s.index) === k).map((s) => s.index);

function trackName(track) {
  return Arrange.instrumentLabel[track.instrument] || track.instrument || "enstrüman";
}

function renderDaw() {
  const { tl } = daw;
  daw.ask = null;   // a question next to a note goes with the drawing it was asked on
  const words = LyricsLayout.layOut(daw.abc, daw.lyrics, LyricsLayout.normalize({ map: daw.map }));
  daw.words = words;
  const sylls = LyricsLayout.allSyllables(daw.lyrics);
  daw.sylls = sylls;
  // How many notes each syllable is sung over, where it was set by hand (null = automatic); an
  // edit of the lyrics carries them over to the syllables it left as they were.
  if (!Array.isArray(daw.melisma) || daw.melisma.length !== sylls.length) daw.melisma = sylls.map(() => null);
  daw.sung = sylls.length ? Arrange.sungNotes(daw.map, sylls, tl, daw.melisma) : new Set();
  const width = dawX(tl.duration) + 40;
  const lanes = el("div", "daw-lanes", { width: width + "px" });
  daw.els = { notes: new Map(), sylls: new Map(), lanes };

  // Ruler: bar numbers and seconds; a click moves the playhead.
  const ruler = lane("", 26, "daw-ruler");
  const step = [1, 2, 5, 10, 15, 30].find((s) => s * daw.pps >= 60) || 60;
  for (let t = 0; t <= tl.duration; t += step) ruler.append(el("div", "daw-tick", { left: dawX(t) + "px" }, fmtTime(t).replace(/\.\d$/, "")));
  const barEvery = Math.max(1, Math.ceil(28 / ((tl.bars[0] ? tl.bars[0].t1 - tl.bars[0].t0 : 1) * daw.pps)));
  tl.bars.forEach((bar, b) => {
    if (b % barEvery === 0) ruler.append(el("div", "daw-barno", { left: dawX(bar.t0) + "px" }, String(b + 1)));
  });

  // Score sections (what YuE2 is told is intro, verse, …); a click or a drag selects bars. In a
  // source song they are shown as the arrangement sends them: the score's names with their edges
  // where the singing starts and stops, the lyrics grouped by them (their own tags are not used).
  const planned = daw.ctx === "source" ? Arrange.plannedSections(tl, daw.model, daw.lyrics, daw.map, daw.melisma) : null;
  daw.sections = planned ? planned.sections : tl.sections;
  daw.secOf = planned ? planned.of : null;
  const sections = lane("Bölüm", 24, "daw-sections");
  for (const section of daw.sections) {
    const block = el("div", "daw-section" + (section.sung ? " sung" : ""), {
      left: dawX(section.t0) + "px", width: (section.t1 - section.t0) * daw.pps - 2 + "px",
    }, `${section.label || "adsız"} `);
    block.append(Icons.node(section.sung ? "mic" : "piano"));
    block.title = `${planned ? "YuE2'ye gidecek bölüm" : "Notadaki bölüm"}: ${section.label || "adsız"}, ölçü ${section.from + 1}–${section.to + 1} (${section.sung ? "söylenen" : "yalnız enstrüman"}). Tıkla ya da sürükle: ölçüleri seç`;
    block.dataset.from = section.from;
    block.dataset.to = section.to;
    sections.append(block);
  }

  // The song's chords (from the melody extraction): where each starts. They stay where they are in
  // the song when notes are edited; a paste moves the ones after it on with the music.
  const chordLane = tl.chords.length ? lane("Akor", 20, "daw-chords") : null;
  if (chordLane) {
    tl.chords.forEach((chord, i) => {
      const next = tl.chords[i + 1];
      const end = next ? next.t0 : tl.duration;
      const box = el("div", "daw-chord", { left: dawX(chord.t0) + "px", width: Math.max(14, (end - chord.t0) * daw.pps - 2) + "px" }, chord.name);
      box.title = `${chord.name} · ölçü ${chord.bar + 1}${daw.design && daw.design.harmony === "free" ? " (bu eser tasarımı akorları göndermiyor)" : ""}`;
      chordLane.append(box);
    });
  }

  // Piano roll: vocal notes over faded instrument notes; vocal rests along the bottom.
  const pitches = [...tl.vocal, ...tl.ins].map((n) => n.midi);
  const top = Math.max(...pitches, 72) + 2, low = Math.min(...pitches, 55) - 2;
  // The roll takes the height the other lanes leave free.
  const trackHeight = daw.ctx === "source" ? 22 + daw.tracks.length * 30 : 0;
  const free = $("daw-scroll").clientHeight - 26 - 24 - (chordLane ? 20 : 0) - 20 - 34 - 20 - trackHeight;
  const row = Math.max(4, Math.min(16, Math.floor((free - 10) / (top - low + 1))));
  const rollHeight = (top - low + 1) * row + 10;
  const roll = lane("Melodi", rollHeight, "daw-roll");
  daw.rollGeom = { el: roll, top, row };
  for (let m = low; m <= top; m++) if (m % 12 === 0) roll.append(el("div", "daw-c-line", { top: (top - m) * row + row - 1 + "px" }, `C${m / 12 - 1}`));
  for (const bar of tl.bars) roll.append(el("div", "daw-bar-line", { left: dawX(bar.t0) + "px" }));
  const span = (item) => ({ left: dawX(item.t0) + "px", width: Math.max(3, (item.t1 - item.t0) * daw.pps - 1) + "px" });
  const picked = (item) => daw.note && daw.note.voice === item.voice && daw.note.bar === item.bar && daw.note.k === item.k;
  const tag = (node, item) => {
    Object.assign(node.dataset, { voice: item.voice, bar: item.bar, k: item.k, u0: item.u0 });
    if (item.midi != null && daw.marked.has(noteKey(item))) node.classList.add("marked");
    return node;
  };
  // The edges of a note: drag one to lengthen or shorten the note on that side.
  const grip = (box) => { box.append(el("div", "rz rz-left", null), el("div", "rz", null)); return box; };
  for (const note of tl.ins) {
    const box = tag(el("div", "daw-ins" + (picked(note) ? " picked" : ""), { ...span(note), top: (top - note.midi) * row + "px", height: row - 1 + "px" }), note);
    box.title = `${note.name} · Enstrüman · ölçü ${note.bar + 1} · sürükle: taşı (Shift: devamıyla) · uçlarını çek: uzat/kısalt`;
    roll.append(grip(box));
  }
  const hasLyrics = sylls.length > 0;
  for (const note of tl.vocal) {
    const slot = words.slots[note.number];
    const state = slot && !slot.hold ? " sung" : daw.sung.has(note.number) ? " held" : hasLyrics ? " unsung" : "";
    const box = tag(el("div", "daw-note" + state + (picked(note) ? " picked" : ""),
      { ...span(note), top: (top - note.midi) * row + "px", height: row - 1 + "px" }), note);
    box.dataset.n = note.number;
    box.title = `${note.name} · ölçü ${note.bar + 1} · ${fmtTime(note.t0)} · sürükle: taşı (Shift: devamıyla) · uçlarını çek: uzat/kısalt${state === " unsung" ? " · hecesi yok: düzenlemede ölçü tümüyle hecesizse enstrümana verilir, değilse YuE2 mırıldanabilir" : ""}`;
    if (slot && !slot.hold && slot.index.some((g) => daw.sel.has(g))) box.classList.add("selected");
    roll.append(grip(box));
    daw.els.notes.set(note.number, box);
  }
  for (const rest of tl.rests.vocal) {
    const box = tag(el("div", "daw-rest" + (picked(rest) ? " picked" : ""), { ...span(rest), top: rollHeight - 8 + "px" }), rest);
    box.title = `Sus · ölçü ${rest.bar + 1}`;
    roll.append(box);
  }

  // Lyric sections: where each [Verse], [Chorus] … of the lyrics is sung; a click selects it. Not
  // in a source song, whose lyrics take their sections from the score.
  const lyricLane = daw.secOf ? null : lane("Söz bölümü", 20, "daw-lyric-lane");
  if (lyricLane) words.sections.forEach((section, k) => {
    if (!section.placed) return;
    const t0 = tl.vocal[section.start].t0, t1 = tl.vocal[section.end - 1].t1;
    const missing = section.count - section.placed;
    const block = el("div", "daw-lyric-section", { left: dawX(t0) + "px", width: Math.max(20, (t1 - t0) * daw.pps - 2) + "px", background: dawSectionColor(k) },
      `${section.tag || "söz"}${missing ? " " : ""}`);
    if (missing) block.append(Icons.node("triangle-alert"), String(missing));
    block.dataset.section = k;
    block.title = `${section.tag || "söz"}: ${section.count} hece${missing ? `, ${missing} hece notaya düşmüyor` : ""}. Tıkla: bu bölümün bütün hecelerini seç`;
    lyricLane.append(block);
  });

  // Syllables: one block per syllable on its note (two on one note share it); held notes get a line.
  const syl = lane("Hece", 34, "daw-syl-lane");
  words.slots.forEach((slot, n) => {
    const note = tl.vocal[n];
    if (!slot || !note) return;
    const w = (note.t1 - note.t0) * daw.pps;
    if (slot.hold) return;   // drawn below when the arrangement sings it
    slot.index.forEach((g, i) => {
      const part = w / slot.index.length;
      const block = el("div", "daw-syl" + (daw.sel.has(g) ? " selected" : "") + (sylls[g].joined ? " joined" : ""), {
        left: dawX(note.t0) + i * part + "px", width: Math.max(14, part - 2) + "px", borderColor: dawSectionColor(sylSection(g)),
      }, sylls[g].text);
      block.dataset.g = g;
      block.title = `${sylls[g].text} · ${sylSectionName(g)} · ölçü ${note.bar + 1}`;
      syl.append(block);
      daw.els.sylls.set(g, block);
    });
  });
  // Held syllables: the melisma line on the notes a syllable is sung over (as the arrangement sends
  // them), solid where it was set by hand. Its end has a grip: drag it to set how far the syllable
  // is held, double-click it to leave that to the arrangement again.
  const lastOn = new Map();   // note → the last syllable on it
  daw.map.forEach((n, g) => { if (n != null) lastOn.set(n, g); });
  for (const [n, g] of lastOn) {
    let end = n;
    while (daw.sung.has(end + 1) && !lastOn.has(end + 1)) end++;
    const set = daw.melisma[g] != null;
    for (let x = n + 1; x <= end; x++) {
      const note = tl.vocal[x];
      syl.append(el("div", "daw-hold" + (set ? " set" : ""), { left: dawX(note.t0) + "px", width: Math.max(2, (note.t1 - note.t0) * daw.pps - 1) + "px" }));
    }
    const grip = el("div", "daw-melisma" + (set ? " set" : ""), { left: dawX(tl.vocal[end].t1) - 5 + "px" });
    grip.dataset.g = g;
    grip.title = `«${sylls[g].text}» ${end - n + 1} notada söyleniyor${set ? "" : " (otomatik)"}. Sürükle: kaç notaya uzansın · çift tık: otomatiğe bırak`;
    syl.append(grip);
  }

  lanes.append(...[ruler, sections, chordLane, roll, lyricLane, syl].filter(Boolean));

  // Instrument tracks (source songs only): what plays how, and where (painted bars).
  if (daw.ctx === "source") {
    const head = lane("", 22, "daw-tracks-head");
    const add = el("button", "daw-track-add", null, "+ İz ekle");
    add.type = "button";
    add.title = "Bir enstrüman izi ekle: hangi enstrüman, nasıl ve nerede çalsın";
    head.querySelector(".daw-label").replaceChildren(add);
    head.append(el("div", "daw-tracks-hint small", { left: DAW_LEFT + 8 + "px" }, daw.tracks.length
      ? "Şeritte tıkla: 1 ölçü · sürükle: istediğin kadar · çubuğun ucunu çek: uzat/kısalt · ortasından çek: taşı · çift tık: sil · Shift+tık: bütün bölüm · ada tıkla: enstrüman ve çalış"
      : "İz ekle: örn. coşkulu yaylılar nakaratlarda, yumuşak piyano baştan sona. YuE2'ye stil metni olarak gider."));
    lanes.append(head);
    daw.tracks.forEach((track, k) => {
      const row = lane("", 30, "daw-track");
      row.dataset.track = k;
      const label = row.querySelector(".daw-label");
      label.classList.add("daw-track-label");
      label.style.borderLeft = `4px solid ${dawTrackColor(k)}`;
      label.textContent = trackName(track);
      label.title = `${Arrange.trackPhrase(track, daw.sections, tl.bars.length)}\nTıkla: düzenle`;
      for (const s of daw.sections) row.append(el("div", "daw-track-sep", { left: dawX(s.t0) + "px" }));
      const ranges = track.bars || [[0, tl.bars.length - 1]];
      ranges.forEach(([a, b], r) => {
        if (a >= tl.bars.length) return;
        const z = Math.min(b, tl.bars.length - 1);
        const block = el("div", "daw-track-block", {
          left: dawX(tl.bars[a].t0) + "px", width: Math.max(4, (tl.bars[z].t1 - tl.bars[a].t0) * daw.pps - 2) + "px", background: dawTrackColor(k),
        }, [...(track.feel || []).map((f) => Arrange.feelLabel[f] || f), track.lead ? "melodi" : ""].filter(Boolean).join(", ") || trackName(track));
        block.dataset.r = r;
        block.title = `ölçü ${a + 1}–${z + 1} · uçlarından çek: uzat/kısalt · ortasından çek: taşı · çift tık: sil`;
        block.append(el("div", "tb-edge tb-left"), el("div", "tb-edge tb-right"));
        row.append(block);
      });
      if (!ranges.length) row.append(el("div", "daw-track-empty small", { left: DAW_LEFT + 8 + "px" }, "Bu iz henüz hiçbir yerde çalmıyor: başlayacağı ölçüye tıkla ya da sürükle"));
      lanes.append(row);
    });
  }

  if (daw.bars) {
    const [a, b] = daw.bars;
    lanes.append(el("div", "daw-range", { left: dawX(tl.bars[a].t0) + "px", width: (tl.bars[b].t1 - tl.bars[a].t0) * daw.pps + "px" }));
  }
  const head = el("div", "daw-playhead");
  const knob = el("div", "daw-playhead-grip");
  knob.title = "Sürükle: çalma çizgisini taşı (notaların başına yapışır) · ⌘V buraya yapıştırır";
  head.append(knob);
  daw.els.playhead = head;
  lanes.append(head);
  const scroll = $("daw-scroll");
  const left = scroll.scrollLeft;
  scroll.replaceChildren(lanes);
  scroll.scrollLeft = left;
  placePlayhead();
  renderDawTray();
  renderDawBar();
  if (daw.wordsKey !== wordsKey()) renderDawWords(); else refreshDawWords();
}

// A selection change only recolours: redrawing would replace the block under a double click.
function refreshDawSelection() {
  for (const [g, block] of daw.els.sylls) block.classList.toggle("selected", daw.sel.has(g));
  for (const [n, box] of daw.els.notes) {
    const slot = daw.words.slots[n];
    box.classList.toggle("selected", !!(slot && slot.index && slot.index.some((g) => daw.sel.has(g))));
  }
  renderDawTray();
  renderDawBar();
  refreshDawWords();
}

// Syllables on no note: the lyrics have more syllables than the melody there.
function renderDawTray() {
  const sylls = daw.sylls;
  const loose = daw.map.map((n, g) => (n == null ? g : -1)).filter((g) => g >= 0);
  $("daw-tray").classList.toggle("hidden", !loose.length);
  if (!loose.length) return;
  const chips = loose.slice(0, 80).map((g) => {
    const chip = el("button", "daw-loose" + (daw.tray === g || daw.sel.has(g) ? " on" : ""), null, sylls[g].text);
    chip.type = "button";
    chip.title = `${sylSectionName(g)}: notaya düşmüyor. Tutup bir vokal notasının üstüne sürükle (ya da tıkla, sonra notaya tıkla); çift tıkla: harfleri düzelt.`;
    // Dragged onto the timeline it goes on the note it is dropped on; a click picks it, and a
    // click on a vocal note then puts it there.
    chip.onpointerdown = (event) => {
      if (event.button) return;
      event.preventDefault();
      const x0 = event.clientX, y0 = event.clientY, was = daw.tray;
      Object.assign(daw, { tray: null, note: null, bars: null, anchor: g });
      daw.sel = new Set([g]);
      window.addEventListener("pointerup", (e) => {
        if (Math.hypot(e.clientX - x0, e.clientY - y0) >= 4) return;
        daw.tray = was === g ? null : g;
        daw.sel.clear();
        refreshDawSelection();
        for (const other of $("daw-tray").querySelectorAll(".daw-loose")) other.classList.toggle("on", other === chip && daw.tray === g);
      }, { once: true });
      dragSelection(event, g, { fromPanel: true });
    };
    chip.ondblclick = () => editDawSyllable(g, chip);
    return chip;
  });
  $("daw-tray").replaceChildren(el("span", "muted small", null, `Notaya düşmeyen ${loose.length} hece:`), ...chips);
}

// ---- the lyrics panel: every line and word; click to select, drag onto the timeline to place

function renderDawWords() {
  const { lines, sylls } = Align.lyricLines(daw.lyrics);
  const box = $("daw-words");
  const out = [];
  let section = -1;
  daw.wordsKey = wordsKey();
  for (const line of lines) {
    // In a source song the headings are the score's sections the lines are sung in.
    const at = sylSection(line.gs[0]);
    if (at !== section) {
      section = at;
      const head = el("div", "dw-section", { borderColor: dawSectionColor(section) }, sylSectionName(line.gs[0]));
      head.dataset.section = section;
      head.title = "Tıkla: bu bölümün bütün hecelerini seç";
      out.push(head);
    }
    const row = el("div", "dw-line");
    const grip = el("span", "dw-grip", null, "⋮⋮");
    grip.dataset.line = line.gs.join(",");
    grip.title = "Bütün satırı seç; sürükleyip satırın başlayacağı notaya bırak";
    row.append(grip);
    let k = 0;
    while (k < line.gs.length) {
      const g = line.gs[k];
      const word = Align.wordOf(sylls, g).filter((x) => line.gs.includes(x));
      const span = el("span", "dw-word");
      span.dataset.gs = word.join(",");
      span.textContent = word.map((x) => sylls[x].text).join("");
      row.append(span, " ");
      k += word.length;
    }
    const count = el("span", "dw-count muted", null, String(line.gs.length));
    count.title = `${line.gs.length} hece`;
    row.append(count);
    out.push(row);
  }
  if (!lines.length) out.push(el("p", "muted small", null, "Bu bestenin sözü yok. «Sözü yaz» ile ekle; heceler melodiye kendiliğinden yerleşir."));
  box.replaceChildren(...out);
  refreshDawWords();
}

// What the lyrics panel's headings depend on.
const wordsKey = () => (daw.secOf ? daw.secOf.join() + "|" + daw.sections.map((s) => s.label).join() : "");

function refreshDawWords() {
  for (const span of document.querySelectorAll("#daw-words .dw-word")) {
    const gs = span.dataset.gs.split(",").map(Number);
    span.classList.toggle("selected", gs.some((g) => daw.sel.has(g)));
    const loose = gs.filter((g) => daw.map[g] == null).length;
    span.classList.toggle("loose", loose === gs.length);
    span.classList.toggle("part", loose > 0 && loose < gs.length);
    const n = daw.map[gs[0]];
    span.title = n == null ? "Notaya yerleşmemiş: sürükleyip bırak" : `ölçü ${daw.tl.vocal[n].bar + 1} · ${fmtTime(daw.tl.vocal[n].t0)}`;
  }
}

const DURATION_NAMES = { "1/16": "onaltılık", "1/8": "sekizlik", "3/16": "noktalı sekizlik", "1/4": "dörtlük",
  "3/8": "noktalı dörtlük", "1/2": "ikilik", "3/4": "noktalı ikilik", "1/1": "birlik" };

function durationText(units) {
  const whole = ScoreModel.unitDenominator(daw.model);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(units, whole);
  const fraction = `${units / g}/${whole / g}`;
  return DURATION_NAMES[fraction] ? `${DURATION_NAMES[fraction]} (${fraction})` : fraction;
}

// The picked note as the score model sees it: { rest, midi, dur, tieOut, contIn, … }.
function dawPicked() {
  const pick = daw.note;
  if (!pick) return null;
  const bar = ScoreModel.voiceNotes(daw.model, pick.voice)[pick.bar];
  return (bar && bar.notes[pick.k]) || null;
}

// YuE2 matches lyric sections to the score's sung sections by name and order. A source song sends
// both as the timeline shows them (the lyrics are tagged by the sections they are sung in), so
// only syllables on no note are worth a word there.
function compareText() {
  const placed = daw.map.filter((n) => n != null).length;
  if (daw.ctx === "source") {
    if (!daw.map.length) return { text: "", warn: false };
    const missing = daw.map.length - placed;
    return missing
      ? { text: `${missing} hece notaya yerleşmedi (aşağıda): YuE2'ye önündeki hecenin bölümünde gider ama yerini kendisi seçer. Notaya sürükle.`, warn: true }
      : { text: `${placed} hecenin hepsi bir notada. YuE2'ye zaman çizgisindeki gibi gider: bölümler Bölüm şeridindeki gibi, söz bu bölümlere göre etiketlenir (sözdeki etiketler kullanılmaz), hecesiz notalar enstrümana geçer.`, warn: false };
  }
  const scoreNames = daw.tl.sections.filter((s) => s.sung).map((s) => LyricsLayout.sectionName(s.label));
  const lyricNames = LyricsLayout.lyricSections(daw.lyrics).map((s) => s.name);
  if (!lyricNames.length) return { text: "", warn: false };
  const both = `Notada söylenen: ${scoreNames.join(" → ") || "—"} · Sözde: ${lyricNames.join(" → ")}`;
  if (scoreNames.join() === lyricNames.join()) return { text: both, warn: false };
  const hints = [];
  if (scoreNames[0] === "intro" && lyricNames[0] !== "intro") hints.push("introda söylenen nota var: giriş enstrümanla çalınacaksa intro ölçülerini seçip Vokal ⇄ Enstrüman yap");
  const missing = [...new Set(lyricNames.filter((name) => !scoreNames.includes(name)))];
  if (missing.length) hints.push(`sözde olup notada olmayan bölüm: ${missing.join(", ")}; ölçüleri seçip bölüm adını ver`);
  return { text: `Sıra farklı (YuE2 sözleri bölümlere kendisi dağıtır). ${both}${hints.length ? ` · ${hints.join("; ")}` : ""}`, warn: true };
}

function renderDawBar() {
  const note = dawPicked();
  const n = daw.sel.size;
  $("daw-note-tools").classList.toggle("hidden", !note);
  $("daw-bar-tools").classList.toggle("hidden", !!note || !daw.bars);
  const compare = compareText();
  $("daw-compare").classList.toggle("hidden", !!note || !!daw.bars || !compare.text);
  Icons.set($("daw-compare"), compare.text ? (compare.warn ? "triangle-alert" : "check") : null, compare.text);
  $("daw-compare").title = compare.text;
  $("daw-compare").classList.toggle("warn", compare.warn);
  if (note) {
    const pick = daw.note;
    const tied = note.tieOut || note.contIn ? " · ölçü çizgisinin üzerinden bağlı" : "";
    $("daw-note-info").textContent = `${note.rest ? "Sus" : ScoreModel.pitchName(note)} · ${durationText(note.dur)} · ${pick.voice === "vocal" ? "Vokal" : "Enstrüman"}, ölçü ${pick.bar + 1}${tied}`;
    $("daw-note-info").title = $("daw-note-info").textContent;
    // Buttons that do not apply are dimmed, not hidden: the others keep their places.
    for (const button of document.querySelectorAll("#daw-note-tools [data-note]")) {
      const op = button.dataset.note;
      button.disabled = ((op === "note" && !note.rest) || (op === "rest" && note.rest)
        || (note.rest && ["up", "down", "octave-up", "octave-down", "shift-back", "shift-on", "insert"].includes(op)));
    }
  }
  if (daw.bars && !note) {
    const [a, b] = daw.bars;
    $("daw-bar-info").textContent = a === b ? `Ölçü ${a + 1}` : `Ölçü ${a + 1}–${b + 1}`;
  }
  let info;
  if (daw.tray != null) info = `«${daw.sylls[daw.tray].text}» hecesini koymak için bir vokal notasına tıkla.`;
  else if (note) info = "↑/↓ yarım ses (Shift: oktav) · A/S (+/−) uzat/kısalt · ←/→ önceki/sonraki · D/F (Alt+←/→): devamıyla ötele · I: önüne nota ekle · Shift+sürükle: devamıyla taşı · Delete: sus · N: notaya çevir";
  else if (daw.marked.size) info = `${daw.marked.size} nota seçili · ←/→ ötele (Alt: ince) · ↑/↓ yarım ses (Shift: oktav) · sürükle: sağa/sola · Delete: sil · ⌘X: kes · ⌘C: kopyala · sarı çizgiyi sürükle, ⌘V: oraya yapıştır (devamı ötelenir) · ⌘+tık: ekle/çıkar · sağ tık: menü, bölüm ata`;
  else if (daw.bars) info = "Seçili ölçülere bölüm adı ver ya da söylenen ve çalınan notaları değiştir.";
  else if (n) info = `${n} hece seçili · sürükle: bıraktığın notadan başlayarak notalara dizilir (Alt: aralıkları koru), önündekiler kayar · ←/→ bir nota kaydır · çift tık: harfleri düzelt · Delete: sil`;
  else info = `Tıkla: ${daw.selMode === "word" ? "kelime" : "hece"} seç (Alt+tık: ${daw.selMode === "word" ? "tek hece" : "kelime"}) · boş yerden sürükle: alan seç (melodide: notaları seç, kes/kopyala/yapıştır) · Shift: aralık · ⌘/Ctrl: ekle · notaya tıkla: perde/süre · sürükle: taşı (Shift: devamıyla) · uçlarını çek: uzat/kısalt · melodide boş yere çift tık: yeni nota · hecenin uzatma ucunu sürükle: kaç notada söylensin · Boşluk: çal`;
  $("daw-info").textContent = info;
  $("daw-undo").disabled = !daw.history.length;
  const grid = ScoreModel.gridCheck(daw.model);
  const loose = grid.offGrid + grid.meterChanges;
  Icons.set($("daw-tidy"), "magnet", loose ? `Notaları hizala (${loose})` : "Notaları hizala");
  $("daw-tidy").classList.toggle("attention", grid.notes > 0 && (grid.offGrid / grid.notes > 0.2 || grid.meterChanges > 0));
  $("daw-save").disabled = !dawDirty() && !daw.layoutFresh;
  $("daw-after").disabled = !n;
  $("daw-origin").textContent = `Nota: ${daw.origin}${daw.scoreDirty ? " (değişti)" : ""}`;
  Icons.set($("daw-play"), daw.playing ? "pause" : "play");
  $("daw-time").textContent = `${fmtTime(daw.pos)} / ${fmtTime(daw.tl.duration)}`;
  for (const button of document.querySelectorAll("#daw-selmode [data-mode]")) button.classList.toggle("on", button.dataset.mode === daw.selMode);
}

// ---- playhead and sound

function placePlayhead() {
  const head = daw.els && daw.els.playhead;
  if (head) head.style.transform = `translateX(${dawX(daw.pos)}px)`;
  $("daw-time").textContent = `${fmtTime(daw.pos)} / ${fmtTime(daw.tl.duration)}`;
  // The note under the playhead lights up with its syllable.
  const note = daw.tl.vocal.find((v) => v.t0 <= daw.pos && daw.pos < v.t1);
  const number = daw.playing && note ? note.number : null;
  if (number === daw.focus) return;
  for (const node of document.querySelectorAll("#daw .playing")) node.classList.remove("playing");
  daw.focus = number;
  if (number == null) return;
  const box = daw.els.notes.get(number);
  if (box) box.classList.add("playing");
  const slot = daw.words.slots[number];
  if (slot && slot.index) for (const g of slot.index) { const s = daw.els.sylls.get(g); if (s) s.classList.add("playing"); }
}

// One note, to hear a pitch while correcting it.
async function playPitch(midi) {
  try {
    score.audio = score.audio || new (window.AudioContext || window.webkitAudioContext)();
    await score.audio.resume();
    if (ABCJS.synth.registerAudioContext) ABCJS.synth.registerAudioContext(score.audio);
    await ABCJS.synth.playEvent([{ pitch: midi, volume: 90, start: 0, duration: 0.6, instrument: 0, gap: 0 }], [], 1000);
  } catch (error) { console.warn(error); }
}

async function dawSynth() {
  if (daw.synth) return daw.synth;
  score.audio = score.audio || new (window.AudioContext || window.webkitAudioContext)();
  await score.audio.resume();
  const synth = new ABCJS.synth.CreateSynth();
  await synth.init({ visualObj: ABCJS.renderAbc("daw-hidden", daw.abc)[0], audioContext: score.audio });
  await synth.prime();
  daw.synth = synth;
  return synth;
}

async function dawPlay() {
  if (daw.playing) { dawPause(); return; }
  $("daw-play").disabled = true;
  try {
    const synth = await dawSynth();
    if (daw.pos >= daw.tl.duration - 0.05) daw.pos = 0;
    synth.seek(daw.pos, "seconds");
    synth.start();
    daw.follow = true;
    daw.startedAt = score.audio.currentTime - daw.pos;
    daw.playing = true;
    const tick = () => {
      if (!daw.playing) return;
      daw.pos = score.audio.currentTime - daw.startedAt;
      if (daw.pos >= daw.tl.duration) { dawPause(); daw.pos = daw.tl.duration; placePlayhead(); return; }
      placePlayhead();
      // Keep the playhead in view, unless the view was scrolled by hand: then it is left where it is
      // until the playhead comes into it again (or the next play).
      const scroll = $("daw-scroll"), x = dawX(daw.pos);
      const outside = x > scroll.scrollLeft + scroll.clientWidth - 80 || x < scroll.scrollLeft + DAW_LEFT;
      if (!daw.follow && !outside) daw.follow = true;
      if (daw.follow && outside) scroll.scrollLeft = x - DAW_LEFT - 40;
      daw.raf = requestAnimationFrame(tick);
    };
    daw.raf = requestAnimationFrame(tick);
  } catch (error) {
    dawMsg(`Çalınamadı: ${error.message || error}`);
  }
  $("daw-play").disabled = false;
  renderDawBar();
}

function dawPause() {
  if (daw.synth && daw.playing) daw.synth.stop();
  daw.playing = false;
  cancelAnimationFrame(daw.raf);
  placePlayhead();
  renderDawBar();
}

function dawSeek(t) {
  daw.pos = Math.max(0, Math.min(daw.tl.duration, t));
  if (daw.playing) {
    daw.synth.stop();
    daw.synth.seek(daw.pos, "seconds");
    daw.synth.start();
    daw.startedAt = score.audio.currentTime - daw.pos;
  }
  placePlayhead();
}

// ---- editing

function dawSnapshot() {
  const { model, abc, tl, map, melisma, lyrics, note, bars, scoreDirty, layoutDirty, tracksDirty } = daw;
  return { model, abc, tl, map, melisma, lyrics, note, bars, scoreDirty, layoutDirty, tracksDirty, tracks: JSON.parse(JSON.stringify(daw.tracks)) };
}

// A new syllable layout or lyrics.
function dawChange(next) {
  daw.history.push(dawSnapshot());
  const lyricsChanged = next.lyrics !== daw.lyrics;
  if (lyricsChanged) daw.melisma = LyricsLayout.carryBySyllable(daw.lyrics, next.lyrics, daw.melisma);
  daw.map = next.map;
  daw.lyrics = next.lyrics;
  daw.layoutDirty = true;
  dawMsg("");
  renderDaw();
  if (lyricsChanged) renderDawWords();
}

// A new score: the synth must be primed again and the syllables follow their notes by time
// (or keep `keepMap`, when the notes stay in order and only one moved).
// `lyrics`: new lyrics going with it (syllables taken out or put in with the notes).
function dawScore(model, note, bars, keepMap, lyrics) {
  const abc = ScoreModel.serialize(model).text;
  const tl = Timeline.build(abc);
  daw.history.push(dawSnapshot());
  const lyricsChanged = lyrics != null && lyrics !== daw.lyrics;
  if (lyricsChanged) {
    daw.melisma = LyricsLayout.carryBySyllable(daw.lyrics, lyrics, daw.melisma);
    daw.lyrics = lyrics;
    daw.layoutDirty = true;
  }
  const map = keepMap || carryMap(daw.tl, tl, daw.map);
  if (map.some((n, g) => (n == null) !== (daw.map[g] == null))) daw.layoutDirty = true;
  dawPause();
  if (daw.synth) { daw.synth.stop(); daw.synth = null; }
  const lost = map.filter((n) => n == null).length - daw.map.filter((n) => n == null).length;
  Object.assign(daw, { model, abc, tl, map, note, bars: bars === undefined ? daw.bars : bars, scoreDirty: true });
  dawMsg(lost > 0 ? `${lost} hece notasız kaldı (aşağıdaki listede). Söz listesinden sürükleyip yerleştir ya da "Otomatik yerleştir"e bas.` : "");
  renderDaw();
  if (lyricsChanged) renderDawWords();
}

const scoreLocked = () => {
  if (daw.item) return false;
  dawMsg("Bu düzenlemenin bir bestesi yok; nota yalnızca bir besteye kaydedilebilir.");
  return true;
};

const NOTE_OPS = {
  up: ["pitch", { semitones: 1 }], down: ["pitch", { semitones: -1 }],
  "octave-up": ["pitch", { semitones: 12 }], "octave-down": ["pitch", { semitones: -12 }],
  longer: ["longer"], shorter: ["shorter"], rest: ["rest"], note: ["note"], split: ["split"], merge: ["merge"],
};

function dawNoteAction(name) {
  const pick = daw.note;
  if (!pick) return;
  if (name === "prev" || name === "next") { stepDawNote(name === "next" ? 1 : -1); return; }
  if (scoreLocked()) return;
  const [op, arg] = NOTE_OPS[name] || [];
  const item = !dawPicked().rest && daw.tl[pick.voice].find((n) => n.bar === pick.bar && n.k === pick.k);
  if (item && (name === "shift-on" || name === "shift-back")) { shiftDawFrom(item, name === "shift-on" ? stepUnits() : -stepUnits()); return; }
  if (item && name === "insert") { insertDawBefore(item); return; }
  if (item && (op === "longer" || op === "shorter")) {
    // A held note grows or shrinks at its end, over barlines too.
    resizeDawNote(item, item.u0, op === "longer" ? item.u1 + stepUnits() : Math.max(item.u0 + 1, item.u1 - stepUnits()));
    return;
  }
  if (!op) return;
  try {
    const result = ScoreModel.editNote(daw.model, pick.voice, { bar: pick.bar, note: pick.k }, op, { ...arg, step: Number($("daw-step").value) || 1 });
    dawScore(result.model, { voice: pick.voice, bar: result.sel.bar, k: result.sel.note }, null);
    const note = dawPicked();
    if (note && !note.rest && (op === "pitch" || op === "note")) playPitch(note.midi);
  } catch (error) {
    dawMsg(error.message);
  }
}

// ---- lengthening, moving on and adding notes

const stepUnits = () => Number($("daw-step").value) || 1;
const midiText = (midi) => `${["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"][midi % 12]}${Math.floor(midi / 12) - 1}`;

// A vocal note with a syllable on it.
const isSungNote = (n) => { const slot = daw.words && daw.words.slots[n]; return !!(slot && !slot.hold) || daw.sung.has(n); };

// Vocal notes keep their numbers when notes only move (the syllables stay on them); a note added
// before note n pushes the numbers from n on.
const mapAfterInsert = (n) => daw.map.map((m) => (m == null || m < n ? m : m + 1));

// A score change that moves notes on: the syllables keep their notes.
function applyMoveOn(result, voice, message) {
  dawScore(result.model, result.sel ? { voice: result.sel.voice || voice, bar: result.sel.bar, k: result.sel.note } : daw.note, null, daw.map);
  if (message && !$("daw-msg").textContent) dawMsg(message);
}

// The note made to sound from `start` to `end` (one edge moved). Where syllables are, what comes
// after always moves with it (longer pushes on, shorter pulls back). Elsewhere the editor asks:
// move on, or leave the rest in place (a note it now covers sounds together with it).
function resizeDawNote(item, start, end) {
  if (scoreLocked() || (start === item.u0 && end === item.u1)) { renderDaw(); return; }
  const notes = daw.tl[item.voice], at = notes.indexOf(item);
  const before = at > 0 ? notes[at - 1].u1 : 0;
  const after = at + 1 < notes.length ? notes[at + 1].u0 : Infinity;
  const clash = start < before || end > after;
  const lo = Math.min(start, item.u0), hi = Math.max(end, item.u1);
  const sung = item.voice === "vocal" && notes.some((n) => n.u1 > lo && n.u0 < hi && isSungNote(n.number));
  const apply = (mode) => {
    try {
      const result = ScoreModel.resizeNote(daw.model, item.voice, item.u0, start, end, mode);
      const sel = result.sel ? { voice: result.sel.voice, bar: result.sel.bar, k: result.sel.note } : daw.note;
      dawScore(result.model, sel, null, mode === "ripple" ? daw.map : undefined);
      if ($("daw-msg").textContent) return;
      if (mode === "overlap") dawMsg("Nota Enstrüman sesine geçti ve üstüne geldiği notayla birlikte çalıyor.");
      else if (mode === "ripple" && at + 1 < notes.length) dawMsg(`Devamındaki ${sung ? "notalar ve sözler de" : "notalar da"} ${start < item.u0 || end > item.u1 ? "ileri" : "geri"} kaydı.`);
    } catch (error) { renderDaw(); dawMsg(error.message); }
  };
  if (sung) { apply("ripple"); return; }
  if (!clash && at + 1 >= notes.length) { apply("plain"); return; }
  askDaw(item, end > item.u1 || start < item.u0 ? "Devamındaki notalar da ileri ötelensin mi?" : "Devamındaki notalar da geri çekilsin mi?", [
    { label: "Evet, ötele", key: "Enter", run: () => apply("ripple") },
    clash
      ? { label: "Hayır, üst üste çalsın", key: "Escape", run: () => apply("overlap") }
      : { label: "Hayır, yerinde kalsın", key: "Escape", run: () => apply("plain") },
  ]);
}

// A small question next to a note; the choice's key (Enter, Escape) answers it too.
function askDaw(item, text, choices) {
  closeAskDaw();
  const box = el("div", "daw-ask");
  box.append(el("div", "daw-ask-text", null, text));
  const row = el("div", "daw-ask-row");
  for (const choice of choices) {
    const button = el("button", "btn small" + (choice.key === "Enter" ? " primary" : " ghost"), null, `${choice.label} (${choice.key === "Enter" ? "↵" : "Esc"})`);
    button.type = "button";
    button.onclick = () => { closeAskDaw(); choice.run(); };
    row.append(button);
  }
  const cancel = Icons.set(el("button", "icon-btn daw-ask-x"), "x");
  cancel.type = "button";
  cancel.title = "Vazgeç";
  cancel.onclick = () => { closeAskDaw(); renderDaw(); dawMsg(""); };
  box.append(row, cancel);
  box.style.left = dawX(item.t0) + "px";
  daw.rollGeom.el.append(box);
  daw.ask = choices;
  box.querySelector(".btn.primary").focus({ preventScroll: true });
}
function closeAskDaw() {
  daw.ask = null;
  for (const box of document.querySelectorAll(".daw-ask")) box.remove();
}

// Unit position under the pointer (fractional).
function unitAt(clientX) {
  return unitOfTime(Math.min(daw.tl.duration - 1e-6, timeAt(clientX)));
}
function unitOfTime(t) {
  const bar = daw.tl.bars[barAt(Math.max(0, t))];
  return bar.u0 + Math.max(0, Math.min(1, (t - bar.t0) / (bar.t1 - bar.t0))) * (bar.u1 - bar.u0);
}

// Dragging a note's edge (right: its end, left: its start): the length follows the pointer in
// steps, over other notes too; applied on release.
function dragNoteEdge(event, box, left) {
  const item = daw.tl[box.dataset.voice].find((n) => n.bar === Number(box.dataset.bar) && n.k === Number(box.dataset.k));
  if (!item || scoreLocked()) return;
  closeAskDaw();
  const step = stepUnits();
  const perUnit = (item.t1 - item.t0) / (item.u1 - item.u0);
  const least = Math.min(step, item.u1 - item.u0);
  let start = item.u0, end = item.u1;
  box.classList.add("resizing");
  const move = (e) => {
    const u = unitAt(e.clientX);
    if (left) start = Math.max(0, Math.min(item.u1 - least, item.u1 - Math.round((item.u1 - u) / step) * step));
    else end = Math.min(daw.tl.bars[daw.tl.bars.length - 1].u1 + 64 * step, item.u0 + Math.max(least, Math.round((u - item.u0) / step) * step));
    box.style.left = dawX(start * perUnit) + "px";
    box.style.width = Math.max(3, (end - start) * perUnit * daw.pps - 1) + "px";
    dawMsg(`Süre: ${durationText(end - start)}`);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (start === item.u0 && end === item.u1) { box.classList.remove("resizing"); renderDaw(); dawMsg(""); return; }
    daw.note = { voice: item.voice, bar: item.bar, k: item.k };
    resizeDawNote(item, start, end);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// The picked note and everything after it in its voice, `by` units on (or back).
function shiftDawFrom(item, by) {
  if (scoreLocked()) return;
  try {
    const result = ScoreModel.shiftFrom(daw.model, item.voice, item.u0, by);
    const count = daw.tl[item.voice].length - daw.tl[item.voice].indexOf(item);
    applyMoveOn(result, item.voice, `${count} nota${item.voice === "vocal" ? " sözleriyle birlikte" : ""} ${durationText(Math.abs(by))} ${by > 0 ? "ileri" : "geri"} ötelendi.`);
  } catch (error) { dawMsg(error.message); }
}

// A new note, one step long at the same pitch, in front of the picked note; it and the rest move on.
function insertDawBefore(item) {
  if (scoreLocked()) return;
  const step = stepUnits();
  try {
    const result = ScoreModel.insertBefore(daw.model, item.voice, item.u0, step, item.midi);
    dawScore(result.model, { voice: item.voice, bar: result.sel.bar, k: result.sel.note }, null, item.voice === "vocal" ? mapAfterInsert(item.number) : daw.map);
    playPitch(item.midi);
    if (!$("daw-msg").textContent) dawMsg("Araya yeni nota eklendi, devamı ötelendi; ↑/↓ ile perdesini, uçlarından süresini ayarla.");
  } catch (error) { dawMsg(error.message); }
}

// Dragging a note by its body: left/right on the step grid, up/down by semitones; it stays between
// its neighbours, so the notes keep their order and their syllables. With Shift the note takes
// everything after it along (left/right only). A click without a drag picks it.
function dragNote(event, box, item) {
  const x0 = event.clientX, y0 = event.clientY, along = event.shiftKey;
  const notes = daw.tl[item.voice], at = notes.indexOf(item);
  const lo = at > 0 ? notes[at - 1].u1 : 0;
  const hi = along ? Infinity : (at + 1 < notes.length ? notes[at + 1].u0 : daw.tl.bars[daw.tl.bars.length - 1].u1) - (item.u1 - item.u0);
  const step = stepUnits();
  const { row } = daw.rollGeom;
  const boxes = along ? notes.slice(at).map((n) => daw.rollGeom.el.querySelector(`.daw-note[data-voice="${n.voice}"][data-bar="${n.bar}"][data-k="${n.k}"], .daw-ins[data-voice="${n.voice}"][data-bar="${n.bar}"][data-k="${n.k}"]`)).filter(Boolean) : [box];
  let moved = false, to = item.u0, midi = item.midi;
  const move = (e) => {
    if (!moved && Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) < 4) return;
    if (!moved && scoreLocked()) { window.removeEventListener("pointermove", move); return; }
    moved = true;
    closeAskDaw();
    const du = (e.clientX - x0) / daw.pps / daw.tl.perUnit;
    to = Math.max(lo, Math.min(hi, item.u0 + Math.round(du / step) * step));
    if (!along) {
      const pitch = Math.max(36, Math.min(96, item.midi - Math.round((e.clientY - y0) / row)));
      if (pitch !== midi) playPitch(pitch);
      midi = pitch;
    }
    for (const b of boxes) {
      b.classList.add("resizing");
      b.style.transform = `translate(${(to - item.u0) * daw.tl.perUnit * daw.pps}px, ${(item.midi - midi) * row}px)`;
    }
    dawMsg(along ? `Devamıyla birlikte ${to >= item.u0 ? "ileri" : "geri"} ${durationText(Math.abs(to - item.u0)) || "0"} · ${notes.length - at} nota`
      : `${fmtTime(to * daw.tl.perUnit)} · ${midiText(midi)}`);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!moved) { pickDawNote(item); return; }
    if (to === item.u0 && midi === item.midi) { renderDaw(); dawMsg(""); return; }
    if (along) { shiftDawFrom(item, to - item.u0); return; }
    try {
      const result = ScoreModel.moveNote(daw.model, item.voice, item.u0, to, midi);
      dawScore(result.model, { voice: item.voice, bar: result.sel.bar, k: result.sel.note }, null, daw.map);
    } catch (error) { renderDaw(); dawMsg(error.message); }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// Double click on an empty place of the melody lane: a new note there (Alt: in the instrument),
// at the pitch under the pointer, one step long, on the step grid.
function placeDawNote(event) {
  if (scoreLocked()) return;
  const voice = event.altKey ? "ins" : "vocal";
  const step = Number($("daw-step").value) || 1;
  const raw = unitAt(event.clientX);
  const bar = daw.tl.bars[barAt(timeAt(event.clientX))];
  const u = bar.u0 + Math.floor((raw - bar.u0) / step) * step;
  const rest = daw.tl.rests[voice].find((x) => x.u0 <= u && u < x.u1);
  if (!rest) { dawMsg(voice === "vocal" ? "Burada vokal notası var; boş bir yere çift tıkla (Alt+çift tık: enstrüman notası)." : "Burada enstrüman notası var."); return; }
  const { el: lane, top, row } = daw.rollGeom;
  const midi = Math.max(36, Math.min(96, top - Math.floor((event.clientY - lane.getBoundingClientRect().top) / row)));
  try {
    const result = ScoreModel.editNote(daw.model, voice, { bar: rest.bar, note: rest.k }, "place", { offset: u - rest.u0, dur: step, midi });
    dawScore(result.model, { voice, bar: result.sel.bar, k: result.sel.note }, null);
    playPitch(midi);
    if (!$("daw-msg").textContent) dawMsg(`${voice === "vocal" ? "Vokal" : "Enstrüman"} notası eklendi; sağ ucunu çekerek uzat, ↑/↓ ile perdesini değiştir.`);
  } catch (error) { dawMsg(error.message); }
}

// The next or previous note or rest of the picked note's voice.
function stepDawNote(direction) {
  const pick = daw.note;
  const items = [...(pick.voice === "vocal" ? daw.tl.vocal : daw.tl.ins), ...daw.tl.rests[pick.voice]].sort((a, b) => a.u0 - b.u0);
  const at = items.findIndex((x) => x.bar === pick.bar && x.k === pick.k);
  const next = items[at + direction];
  if (!next) return;
  pickDawNote(next);
}

function pickDawNote(item) {
  daw.note = { voice: item.voice, bar: item.bar, k: item.k };
  daw.sel.clear();
  daw.marked.clear();
  daw.tray = null;
  daw.bars = null;
  dawMsg("");
  dawSeek(item.t0);
  renderDaw();
  scrollDawTo(item.t0);
  const note = dawPicked();
  if (note && !note.rest && !daw.playing) playPitch(note.midi);
}

function scrollDawTo(t) {
  const scroll = $("daw-scroll"), x = dawX(t);
  if (x < scroll.scrollLeft + DAW_LEFT || x > scroll.scrollLeft + scroll.clientWidth - 60) scroll.scrollLeft = x - DAW_LEFT - 80;
}

// Puts the selection's span on the notes from note `start` and pushes the syllables in the way.
function flowResult(base, start, keepShape) {
  const out = Align.flow(base, [...daw.sel], start, dawCount(), keepShape);
  return out;
}

function flowMessage(out) {
  const parts = [];
  if (out.pushed) parts.push(`${out.pushed} hece kaydırıldı`);
  if (out.lost) parts.push(`${out.lost} hece notaların dışına taştı (aşağıdaki listede; geri alabilirsin)`);
  return parts.join(" · ");
}

// ←/→: one note, keeping the selection's shape; the syllables in the way are pushed along.
function moveDawSelection(delta) {
  if (!daw.sel.size) return;
  const first = Math.min(...daw.sel);
  const from = Align.range(first, Math.max(...daw.sel)).map((g) => daw.map[g]).find((n) => n != null);
  if (from == null) { dawMsg("Seçili heceler notada değil; sürükleyip bir notaya bırak."); return; }
  const lead = daw.map[first] != null ? daw.map[first] : from;
  const out = flowResult(daw.map, lead + delta, true);
  if (typeof out === "string") { dawMsg(out); return; }
  dawChange({ map: out.map, lyrics: daw.lyrics });
  dawMsg(flowMessage(out));
}

function editDawSyllable(g, anchor) {
  const input = el("input", "daw-edit");
  input.value = daw.sylls[g].text;
  const box = anchor.getBoundingClientRect(), host = $("daw").getBoundingClientRect();
  Object.assign(input.style, { left: box.left - host.left + "px", top: box.top - host.top + "px", width: Math.max(80, box.width + 30) + "px" });
  $("daw").append(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    input.remove();
    const text = input.value.trim();
    if (!keep || text === daw.sylls[g].text) return;
    if (text && ![...text].some((ch) => /\p{L}/u.test(ch))) { dawMsg("Hecede en az bir harf olmalı (silmek için boş bırak)."); return; }
    daw.sel.clear();
    if (daw.tray === g) daw.tray = null;
    dawChange(LyricsLayout.editSyllable(daw.lyrics, daw.map, g, text, dawCount()));
    dawMsg(text ? "Harfler düzeltildi. Hece sayısı değiştiyse yeni heceler sonraki boş notalara kondu." : "Hece silindi.");
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") { event.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

function deleteDawSelection() {
  if (!daw.sel.size) return;
  let next = { map: daw.map, lyrics: daw.lyrics };
  for (const g of [...daw.sel].sort((a, b) => b - a)) next = LyricsLayout.editSyllable(next.lyrics, next.map, g, "", dawCount());
  daw.sel.clear();
  dawChange(next);
  dawMsg("Seçili heceler sözden silindi (geri alınabilir).");
}

// What a click on syllable g selects: its word, or the syllable alone (the other with Alt).
function clickUnit(g, event) {
  const word = (daw.selMode === "word") !== !!event.altKey;
  return word ? Align.wordOf(daw.sylls, g) : [g];
}

function selectDaw(g, event, unit = clickUnit(g, event)) {
  daw.tray = null;
  daw.marked.clear();
  daw.note = null;
  daw.bars = null;
  if (event.shiftKey && daw.anchor != null) {
    const [a, b] = [Math.min(daw.anchor, ...unit), Math.max(daw.anchor, ...unit)];
    daw.sel = new Set(Align.range(a, b));
  } else if (event.metaKey || event.ctrlKey) {
    const on = unit.every((x) => daw.sel.has(x));
    for (const x of unit) if (on) daw.sel.delete(x); else daw.sel.add(x);
    daw.anchor = unit[0];
  } else {
    if (!unit.every((x) => daw.sel.has(x))) daw.sel = new Set(unit);
    daw.anchor = unit[0];
  }
}

// The vocal note whose middle is nearest to time t.
function nearestNote(t) {
  let best = 0, gap = Infinity;
  for (const note of daw.tl.vocal) {
    const d = Math.abs((note.t0 + note.t1) / 2 - t);
    if (d < gap) { gap = d; best = note.number; }
  }
  return best;
}

const barAt = (t) => Math.max(0, daw.tl.bars.findIndex((bar) => t < bar.t1) < 0 ? daw.tl.bars.length - 1 : daw.tl.bars.findIndex((bar) => t < bar.t1));
const timeAt = (clientX) => {
  const scroll = $("daw-scroll");
  return (clientX - scroll.getBoundingClientRect().left + scroll.scrollLeft - DAW_LEFT) / daw.pps;
};

// Dragging the selection: the grabbed syllable follows the pointer to the nearest note and the span
// is laid out from there. `grab` is the grabbed syllable (or the span's first one).
function dragSelection(event, grab, { fromPanel = false } = {}) {
  const base = daw.map, startX = event.clientX, startY = event.clientY;
  const span = Align.range(Math.min(...daw.sel), Math.max(...daw.sel));
  let last = null, moved = false, ghost = null, inside = !fromPanel;
  const scroll = $("daw-scroll");
  const overTimeline = (e) => {
    const box = scroll.getBoundingClientRect();
    return e.clientX > box.left + DAW_LEFT && e.clientX < box.right && e.clientY > box.top && e.clientY < box.bottom;
  };
  const move = (e) => {
    if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
    moved = true;
    if (fromPanel) {
      if (!ghost) {
        ghost = el("div", "dw-ghost", null, span.slice(0, 12).map((g) => daw.sylls[g].text + (daw.sylls[g].joined ? "" : " ")).join("").trim() + (span.length > 12 ? "…" : ""));
        document.body.append(ghost);
        $("daw").append(ghost);
      }
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
      if (!overTimeline(e)) { if (last) { daw.map = base; last = null; renderDaw(); } return; }
    }
    const keep = e.altKey;
    const target = nearestNote(timeAt(e.clientX));
    let start;
    if (keep && base[grab] != null) {
      const anchor = span.map((g) => base[g]).find((n) => n != null);
      start = target - (base[grab] - anchor);
    } else start = target - (grab - span[0]);
    const key = `${start}:${keep}`;
    if (key === last) return;
    const out = Align.flow(base, span, start, dawCount(), keep);
    if (typeof out === "string") { dawMsg(out); return; }
    last = key;
    daw.map = out.map;
    dawMsg(flowMessage(out));
    renderDaw();
    // Follow the pointer near the edges (once it has been inside: coming from the lyrics panel
    // it crosses the right edge first).
    const box = scroll.getBoundingClientRect();
    if (e.clientX < box.right - 60) inside = true;
    if (!inside) return;
    if (e.clientX > box.right - 40) scroll.scrollLeft += 20;
    else if (e.clientX < box.left + DAW_LEFT + 30) scroll.scrollLeft -= 20;
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (ghost) ghost.remove();
    if (last && daw.map !== base) {
      daw.history.push({ ...dawSnapshot(), map: base });
      daw.layoutDirty = true;
      renderDawBar();
      renderDawTray();
    } else if (fromPanel && moved) {
      daw.map = base;
      dawMsg("Bırakmak için zaman çizgisinin üzerine getir.");
      renderDaw();
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// Rubber band from an empty place: selects the syllables whose notes it crosses.
function marquee(event) {
  const x0 = event.clientX;
  const t0 = timeAt(x0);
  const before = event.shiftKey || event.metaKey || event.ctrlKey ? new Set(daw.sel) : new Set();
  const box = el("div", "daw-marquee");
  const lanes = daw.els.lanes;
  let moved = false;
  const move = (e) => {
    if (!moved && Math.abs(e.clientX - x0) < 4) return;
    if (!moved) { lanes.append(box); moved = true; Object.assign(daw, { tray: null, note: null, bars: null }); daw.marked.clear(); }
    const t1 = timeAt(e.clientX);
    const [a, b] = [Math.min(t0, t1), Math.max(t0, t1)];
    Object.assign(box.style, { left: dawX(a) + "px", width: (b - a) * daw.pps + "px" });
    daw.sel = new Set(before);
    daw.map.forEach((n, g) => { if (n != null && daw.tl.vocal[n].t1 > a && daw.tl.vocal[n].t0 < b) daw.sel.add(g); });
    refreshDawSelection();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    box.remove();
    if (moved) { daw.anchor = daw.sel.size ? Math.min(...daw.sel) : null; renderDaw(); return; }
    if (daw.sel.size || daw.marked.size || daw.tray != null || daw.note || daw.bars) {
      Object.assign(daw, { tray: null, note: null, bars: null });
      daw.sel.clear();
      daw.marked.clear();
      renderDaw();
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---- several notes at once: a rubber band in the melody lane picks notes (sung or not, both
// voices); they are deleted, cut or copied, and pasted where the playhead is, the first note on it,
// everything from there on moving on to make room.

const noteKey = (item) => `${item.voice}:${item.u0}`;
let dawClip = null;   // stays when another song is opened, to paste there

function marqueeNotes(event) {
  const roll = daw.rollGeom.el;
  const at = (e) => { const r = roll.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const p0 = at(event);
  const before = event.shiftKey || event.metaKey || event.ctrlKey ? new Set(daw.marked) : new Set();
  const boxes = [...roll.querySelectorAll(".daw-note, .daw-ins")];
  const box = el("div", "daw-marquee daw-marquee-notes");
  const scroll = $("daw-scroll");
  let moved = false, last = event;
  const move = (e) => {
    last = e;
    const p = at(e);
    if (!moved && Math.abs(p.x - p0.x) + Math.abs(p.y - p0.y) < 4) return;
    if (!moved) {
      moved = true;
      roll.append(box);
      Object.assign(daw, { tray: null, note: null, bars: null });
      daw.sel.clear();
      closeAskDaw();
      refreshDawSelection();
      for (const b of roll.querySelectorAll(".picked")) b.classList.remove("picked");
    }
    const x0 = Math.max(DAW_LEFT, Math.min(p0.x, p.x)), x1 = Math.max(p0.x, p.x);
    const y0 = Math.max(0, Math.min(p0.y, p.y)), y1 = Math.min(roll.offsetHeight, Math.max(p0.y, p.y));
    Object.assign(box.style, { left: x0 + "px", width: x1 - x0 + "px", top: y0 + "px", height: y1 - y0 + "px" });
    daw.marked = new Set(before);
    for (const b of boxes) {
      if (b.offsetLeft < x1 && b.offsetLeft + b.offsetWidth > x0 && b.offsetTop < y1 && b.offsetTop + b.offsetHeight > y0) daw.marked.add(`${b.dataset.voice}:${b.dataset.u0}`);
    }
    for (const b of boxes) b.classList.toggle("marked", daw.marked.has(`${b.dataset.voice}:${b.dataset.u0}`));
    $("daw-info").textContent = `${daw.marked.size} nota seçili`;
  };
  // Near the edges the view follows the band.
  const follow = setInterval(() => {
    if (!moved) return;
    const r = scroll.getBoundingClientRect();
    const by = last.clientX > r.right - 30 ? 20 : last.clientX < r.left + DAW_LEFT + 20 ? -20 : 0;
    if (by) { scroll.scrollLeft += by; move(last); }
  }, 40);
  const up = () => {
    clearInterval(follow);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    box.remove();
    if (moved) { renderDaw(); return; }
    if (daw.sel.size || daw.marked.size || daw.tray != null || daw.note || daw.bars) {
      Object.assign(daw, { tray: null, note: null, bars: null });
      daw.sel.clear();
      daw.marked.clear();
      renderDaw();
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// The picked notes by voice ({ vocal: [u0], ins: [u0] }): the rubber band's, else the one clicked.
function markedPick() {
  const pick = { vocal: [], ins: [] };
  for (const key of daw.marked) { const [voice, u0] = key.split(":"); pick[voice].push(Number(u0)); }
  if (!daw.marked.size && daw.note) {
    const item = daw.tl[daw.note.voice].find((n) => n.bar === daw.note.bar && n.k === daw.note.k);
    if (item) pick[item.voice].push(item.u0);
  }
  return pick;
}

// The syllables on the picked vocal notes, for pasting them with the notes: { text, notes } with
// the note of every syllable as its place among the clip's vocal notes. Whole stretches of the
// lyrics keep their line breaks and section tags.
function clipLyrics(pick) {
  const vocal = daw.tl.vocal.filter((n) => pick.vocal.includes(n.u0)).map((n) => n.number);
  const gs = daw.map.map((m, g) => (m != null && vocal.includes(m) ? g : -1)).filter((g) => g >= 0);
  if (!gs.length) return null;
  const sylls = daw.sylls, last = gs[gs.length - 1];
  const text = last - gs[0] + 1 === gs.length
    ? daw.lyrics.slice(sylls[gs[0]].from, sylls[last].to)
    : gs.map((g, k) => sylls[g].text + (sylls[g].joined && gs[k + 1] === g + 1 ? "" : " ")).join("");
  return { text: text.trim(), notes: gs.map((g) => vocal.indexOf(daw.map[g])) };
}

function makeClip(pick) {
  const clip = ScoreModel.clipNotes(daw.model, pick);
  if (clip) clip.lyrics = clipLyrics(pick);
  return clip;
}

function copyDawNotes() {
  const clip = makeClip(markedPick());
  if (!clip) return false;
  dawClip = clip;
  const count = clip.vocal.length + clip.ins.length;
  dawMsg(`${count} nota${clip.lyrics ? " (sözleriyle)" : ""} kopyalandı. Sarı çizgiyi yapıştıracağın yere çek, ⌘V (ya da sağ tık → Yapıştır).`);
  return true;
}

// Delete (or cut): rests take the notes' places, nothing else moves; the syllables on them go out
// of the lyrics too (a cut keeps them to paste).
function deleteDawNotes(cut) {
  const pick = markedPick();
  const count = pick.vocal.length + pick.ins.length;
  if (!count || scoreLocked()) return;
  try {
    if (cut) dawClip = makeClip(pick);
    const model = ScoreModel.removeNotes(ScoreModel.removeNotes(daw.model, "vocal", pick.vocal), "ins", pick.ins);
    const gone = daw.tl.vocal.filter((n) => pick.vocal.includes(n.u0)).map((n) => n.number);
    let next = { lyrics: daw.lyrics, map: daw.map };
    const words = daw.map.map((m, g) => (m != null && gone.includes(m) ? g : -1)).filter((g) => g >= 0);
    for (const g of [...words].reverse()) next = LyricsLayout.editSyllable(next.lyrics, next.map, g, "", dawCount());
    // Lines left with nothing on them go, and the spaces left where the syllables were.
    const lyrics = words.length
      ? next.lyrics.replace(/^[ \t]+$\n?/gm, "").replace(/^[ \t]+|[ \t]+$/gm, "").replace(/(\S)[ \t]{2,}(?=\S)/g, "$1 ")
      : daw.lyrics;
    const map = next.map.map((m) => (m == null ? null : m - gone.filter((x) => x < m).length));
    daw.marked.clear();
    dawScore(model, null, null, map, lyrics);
    const said = $("daw-msg").textContent;
    dawMsg(`${count} nota${words.length ? ` ve üzerlerindeki ${words.length} hece` : ""} ${cut ? "kesildi; sarı çizgiyi yapıştıracağın yere çek, ⌘V" : "silindi"} (geri alınabilir).${said ? " " + said : ""}`);
  } catch (error) { dawMsg(error.message); }
}

// A length as whole bars when it is one ("2 ölçü"), else as a note value.
function spanText(units) {
  const bar = daw.tl.bars[0] && daw.tl.bars[0].units;
  if (!bar || units < bar) return durationText(units);
  const rest = units % bar;
  return `${Math.floor(units / bar)} ölçü${rest ? " + " + durationText(rest) : ""}`;
}

// Paste where the playhead is. When the clip carries syllables the editor asks whether they come
// along; without them the notes go in with no syllables.
function pasteDawNotes() {
  if (!dawClip) { dawMsg("Yapıştırılacak nota yok: önce melodide boş yerden sürükleyerek notaları seç, ⌘C ya da ⌘X."); return; }
  if (scoreLocked()) return;
  const step = stepUnits();
  const bar = daw.tl.bars[barAt(daw.pos)];
  let u = unitOfTime(daw.pos);
  // On a note start the playhead was snapped to; elsewhere on the step grid.
  const start = [...daw.tl.vocal, ...daw.tl.ins].find((n) => Math.abs(n.u0 - u) < 1e-6);
  u = start ? start.u0 : Math.min(bar.u1, bar.u0 + Math.round((u - bar.u0) / step) * step);
  const clip = dawClip;
  if (!clip.lyrics) { pasteClip(clip, u, false); return; }
  const words = clip.lyrics.text.length > 40 ? clip.lyrics.text.slice(0, 40).trim() + "…" : clip.lyrics.text;
  askDaw({ t0: u * daw.tl.perUnit }, `Kopyalanan notaların sözleri de var («${words.replace(/\s+/g, " ")}»). Sözleriyle birlikte yapıştırayım mı?`, [
    { label: "Evet, sözleriyle", key: "Enter", run: () => pasteClip(clip, u, true) },
    { label: "Hayır, sözsüz", key: "Escape", run: () => pasteClip(clip, u, false) },
  ]);
}

function pasteClip(clip, u, withLyrics) {
  try {
    const result = ScoreModel.pasteNotes(daw.model, u, clip);
    const after = daw.tl.vocal.find((n) => n.u0 >= result.at);
    const from = after ? after.number : daw.tl.vocal.length, added = clip.vocal.length;
    let next = { lyrics: daw.lyrics, map: daw.map.map((m) => (m == null || m < from ? m : m + added)) };
    if (withLyrics) next = LyricsLayout.insertSyllables(next.lyrics, next.map, clip.lyrics.text, clip.lyrics.notes.map((k) => from + k));
    Object.assign(daw, { note: null, tray: null, bars: null });
    daw.sel.clear();
    daw.marked = new Set(["vocal", "ins"].flatMap((voice) => clip[voice].map((c) => `${voice}:${result.at + c.off}`)));
    dawScore(result.model, null, null, next.map, next.lyrics);
    // The playhead goes to the end of what was pasted: ⌘V again puts the next copy after it.
    dawSeek((result.at + clip.length) * daw.tl.perUnit);
    const count = clip.vocal.length + clip.ins.length;
    if (!$("daw-msg").textContent) {
      dawMsg(`${count} nota${withLyrics ? " sözleriyle" : clip.lyrics ? " sözsüz" : ""} yapıştırıldı; devamındaki notalar${added && after ? " ve sözleri" : ""} ${spanText(clip.length)} ileri ötelendi.`);
    }
  } catch (error) { dawMsg(error.message); }
}

// The picked notes moved `by` units and `semitones` up; they overwrite what they land on. The
// syllables go with their notes (by the unit they start on), those on overwritten notes go to the list.
function moveMarked(by, semitones) {
  const pick = markedPick();
  if (!(pick.vocal.length + pick.ins.length) || (!by && !semitones) || scoreLocked()) return;
  try {
    const { model, overwritten } = ScoreModel.moveNotes(daw.model, pick, by, semitones);
    const tl = Timeline.fromModel(model);
    const at = Timeline.onsets(daw.tl, daw.map).map((u) => (u != null && pick.vocal.includes(u) ? u + by : u));
    daw.marked = new Set(["vocal", "ins"].flatMap((voice) => pick[voice].map((u) => `${voice}:${u + by}`)));
    Object.assign(daw, { note: null, tray: null, bars: null });
    dawScore(model, null, null, Timeline.mapFromOnsets(tl, at));
    if (semitones) {
      const top = daw.tl.vocal.concat(daw.tl.ins).find((n) => daw.marked.has(noteKey(n)));
      if (top && !daw.playing) playPitch(top.midi);
    }
    const said = $("daw-msg").textContent;
    dawMsg([by ? `${by > 0 ? "İleri" : "Geri"} ${durationText(Math.abs(by))}` : `${semitones > 0 ? "+" : ""}${semitones} yarım ses`,
      overwritten ? `${overwritten} notanın üstüne yazıldı` : "", said].filter(Boolean).join(" · "));
  } catch (error) { dawMsg(error.message); }
}

// Dragging picked notes by one of them: left/right only, unit by unit (the finest grid).
function dragMarked(event, item) {
  const x0 = event.clientX;
  const boxes = [...daw.rollGeom.el.querySelectorAll(".daw-note.marked, .daw-ins.marked")];
  const pick = markedPick();
  const first = Math.min(...pick.vocal, ...pick.ins);
  let moved = false, by = 0;
  const move = (e) => {
    if (!moved && Math.abs(e.clientX - x0) < 4) return;
    moved = true;
    closeAskDaw();
    by = Math.max(-first, Math.round((e.clientX - x0) / daw.pps / daw.tl.perUnit));
    for (const b of boxes) { b.classList.add("resizing"); b.style.transform = `translateX(${by * daw.tl.perUnit * daw.pps}px)`; }
    dawMsg(`${by >= 0 ? "İleri" : "Geri"} ${durationText(Math.abs(by)) || "0"} · ${boxes.length} nota`);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!moved) { pickDawNote(item); return; }
    if (!by) { renderDaw(); dawMsg(""); return; }
    moveMarked(by, 0);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// The bars the picked notes are in: [from, to].
function markedBars() {
  const pick = markedPick();
  const items = ["vocal", "ins"].flatMap((voice) => daw.tl[voice].filter((n) => pick[voice].includes(n.u0)));
  if (!items.length) return null;
  const u0 = Math.min(...items.map((n) => n.u0)), u1 = Math.max(...items.map((n) => n.u1));
  const bars = daw.tl.bars;
  let from = bars.findIndex((b) => u0 < b.u1), to = bars.findIndex((b) => u1 <= b.u1);
  if (to < 0) to = bars.length - 1;
  // An edge bar the picked notes only touch (a note held over the bar line, a pickup) stays
  // with its own section; the section is the bars the picked notes mostly fill.
  const covered = (bar) => items.reduce((sum, n) => sum + Math.max(0, Math.min(n.u1, bar.u1) - Math.max(n.u0, bar.u0)), 0);
  const slight = (bar) => covered(bar) * 2 < bar.u1 - bar.u0;
  while (from < to && slight(bars[from])) from++;
  while (to > from && slight(bars[to])) to--;
  return [from, to];
}

// The picked notes' bars as one section of the score (intro, verse, chorus …). In an arrangement's
// score the syllables sung there become a lyric section of that name too; a source song's lyrics
// take their sections from the score anyway.
function assignDawSection(label) {
  const range = markedBars();
  if (!range || scoreLocked()) return;
  const [from, to] = range, { bars } = daw.tl;
  if (daw.ctx === "source") {
    try {
      dawScore(ScoreModel.setSection(daw.model, from, to, label), null);
      dawMsg(`${from === to ? `Ölçü ${from + 1}` : `Ölçü ${from + 1}–${to + 1}`} artık ${label}; burada söylenen sözler de bu bölümle gider (geri alınabilir).`);
    } catch (error) { dawMsg(error.message); }
    return;
  }
  const inside = (g) => daw.map[g] != null && daw.tl.vocal[daw.map[g]].u0 >= bars[from].u0 && daw.tl.vocal[daw.map[g]].u0 < bars[to].u1;
  const sung = daw.map.map((m, g) => (inside(g) ? g : -1)).filter((g) => g >= 0);
  // Only words sung wholly inside these bars change section: a word reaching over the edge,
  // and every syllable before or after, keeps the section it is in.
  const syls = LyricsLayout.allSyllables(daw.lyrics);
  let first = sung[0], last = sung[sung.length - 1];
  const wordStart = (g) => { while (g > 0 && syls[g - 1].joined) g--; return g; };
  const wordEnd = (g) => { while (g < syls.length - 1 && syls[g].joined) g++; return g; };
  const whole = (g) => { for (let k = wordStart(g); k <= wordEnd(g); k++) if (!inside(k)) return false; return true; };
  while (first <= last && !whole(first)) first = wordEnd(first) + 1;
  while (last >= first && !whole(last)) last = wordStart(last) - 1;
  const tag = Arrange.tagText(label);
  const retagged = sung.length && first <= last;
  const lyrics = retagged ? LyricsLayout.retag(daw.lyrics, first, last, tag) : null;
  try {
    dawScore(ScoreModel.setSection(daw.model, from, to, label), null, null, daw.map, lyrics);
    dawMsg(`${from === to ? `Ölçü ${from + 1}` : `Ölçü ${from + 1}–${to + 1}`} artık ${label}${retagged ? `; tamamı burada söylenen sözler de [${tag}] bölümü oldu` : ""} (geri alınabilir).`);
  } catch (error) { dawMsg(error.message); }
}

// The end of a syllable's melisma line dragged: it is sung over the notes up to the one under the
// pointer (never onto the next syllable's note). A double click leaves it to the arrangement.
function dragMelisma(event, g) {
  event.preventDefault();
  const n = daw.map[g];
  if (n == null) return;
  const next = daw.map.find((m, i) => i > g && m != null && m > n);
  const last = (next ?? daw.tl.vocal.length) - 1;
  const before = dawSnapshot();
  let changed = false;
  const move = (e) => {
    const t = timeAt(e.clientX);
    // A note is taken once the pointer is past its middle.
    let x = n;
    while (x < last && (daw.tl.vocal[x + 1].t0 + daw.tl.vocal[x + 1].t1) / 2 < t) x++;
    if (daw.melisma[g] === x - n) return;
    daw.melisma = daw.melisma.map((k, i) => (i === g ? x - n : k));
    changed = true;
    renderDaw();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!changed) return;
    daw.history.push(before);
    daw.layoutDirty = true;
    const k = daw.melisma[g];
    dawMsg(`«${daw.sylls[g].text}» ${k + 1} notada söylenecek${k ? "" : " (yalnız kendi notasında)"}; sonraki hecesiz notaları enstrüman çalar.`);
    renderDawBar();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

$("daw-scroll").addEventListener("dblclick", (event) => {
  const grip = event.target.closest(".daw-melisma");
  if (!grip) return;
  const g = Number(grip.dataset.g);
  if (daw.melisma[g] == null) return;
  daw.history.push(dawSnapshot());
  daw.melisma = daw.melisma.map((k, i) => (i === g ? null : k));
  daw.layoutDirty = true;
  dawMsg(`«${daw.sylls[g].text}» kaç notada söyleneceği yine otomatik (geri alınabilir).`);
  renderDaw();
});

// Dragging the playhead (by the ruler or its grip): it sticks to note starts near the pointer.
function dragPlayhead(event) {
  const wasPlaying = daw.playing;
  if (wasPlaying) dawPause();
  const to = (e) => {
    const t = Math.max(0, Math.min(daw.tl.duration, timeAt(e.clientX)));
    let best = null;
    for (const n of [...daw.tl.vocal, ...daw.tl.ins]) if (Math.abs(n.t0 - t) * daw.pps < 8 && (!best || Math.abs(n.t0 - t) < Math.abs(best.t0 - t))) best = n;
    return best ? best.t0 : t;
  };
  dawSeek(to(event));
  const move = (e) => { dawSeek(to(e)); };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (wasPlaying) dawPlay();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// The empty bars after the song's last note (in either voice): how many there are.
function trailingBars() {
  const end = Math.max(0, ...[...daw.tl.vocal, ...daw.tl.ins].map((n) => n.u1));
  const keep = Math.max(1, daw.tl.bars.filter((b) => b.u0 < end).length);
  return daw.tl.bars.length - keep;
}

// Takes the empty bars at the end of the song out; the tracks end with the song.
function trimDawEnd() {
  const extra = trailingBars();
  if (!extra || scoreLocked()) return;
  const keep = daw.model.bars.length - extra;
  try {
    dawScore({ ...daw.model, bars: daw.model.bars.slice(0, keep) }, null, null, daw.map);
  } catch (error) { dawMsg(error.message); return; }
  let cut = false;
  for (const track of daw.tracks) {
    if (!track.bars) continue;
    const bars = track.bars.filter(([a]) => a < keep).map(([a, z]) => [a, Math.min(z, keep - 1)]);
    if (JSON.stringify(bars) !== JSON.stringify(track.bars)) { track.bars = bars; cut = true; }
  }
  if (cut) { daw.tracksDirty = true; renderDaw(); }
  dawMsg(`Sondaki ${extra} boş ölçü silindi; şarkı artık ${keep} ölçü (geri alınabilir).`);
}

// The whole score on the beat grid and in one meter (ScoreModel.tidy). Every vocal note stays, in
// order, so the syllables stay on theirs; track ranges follow their bars.
function tidyDaw() {
  if (scoreLocked()) return;
  const before = ScoreModel.gridCheck(daw.model);
  let result;
  try { result = ScoreModel.tidy(daw.model); } catch (error) { dawMsg(error.message); return; }
  if (!result.moved && !result.fixed) { dawMsg("Notalar zaten vuruşta ve tek ölçüde; değişecek bir şey yok."); return; }
  const count = daw.model.bars.length;
  try { dawScore(result.model, null, null, daw.map); } catch (error) { dawMsg(error.message); return; }
  const newCount = daw.model.bars.length;
  let moved = false;
  for (const track of daw.tracks) {
    if (!track.bars || !result.fixed) continue;
    const end = (z) => (z + 1 < count ? result.barMap[z + 1] - 1 : newCount - 1);
    const bars = track.bars.map(([a, z]) => [result.barMap[a] ?? newCount - 1, Math.max(result.barMap[a] ?? newCount - 1, end(z))]);
    if (JSON.stringify(bars) !== JSON.stringify(track.bars)) { track.bars = bars; moved = true; }
  }
  if (moved) { daw.tracksDirty = true; renderDaw(); }
  const after = ScoreModel.gridCheck(daw.model);
  const parts = [];
  if (result.moved) parts.push(`${result.moved} nota vuruşa oturtuldu (vuruş dışında başlayan vokal notası ${before.offGrid} → ${after.offGrid})`);
  if (result.fixed) parts.push(`${result.fixed} yerde farklı ölçü (ör. 2/4) kaldırıldı, araya sus eklendi ya da sus kısaltıldı`);
  dawMsg(`${parts.join("; ")}. Heceler notalarında kaldı. Dinleyip kontrol et; beğenmezsen "Geri al". Akorları melodiden önerdiysen, kaydettikten sonra "Melodiden öner"i yeniden çalıştır.`);
}

function closeDawMenu() {
  for (const menu of document.querySelectorAll(".daw-menu")) menu.remove();
}

// Right click in the melody lane: cut, copy, paste, delete.
function openDawMenu(event) {
  closeDawMenu();
  const noteBox = event.target.closest(".daw-note, .daw-ins");
  if (noteBox && !daw.marked.has(`${noteBox.dataset.voice}:${noteBox.dataset.u0}`)) {
    Object.assign(daw, { note: null, tray: null, bars: null });
    daw.sel.clear();
    daw.marked = new Set([`${noteBox.dataset.voice}:${noteBox.dataset.u0}`]);
    renderDaw();
  }
  const pick = markedPick(), has = pick.vocal.length + pick.ins.length > 0;
  const menu = el("div", "menu daw-menu");
  menu.setAttribute("role", "menu");
  menu.addEventListener("click", (e) => e.stopPropagation());   // the page's menus close on any click
  const item = (label, key, on, run, extra = "") => {
    const button = el("button", "menu-item" + extra);
    button.type = "button";
    button.disabled = !on;
    button.append(el("span", null, null, label), key === "▸" ? Icons.set(el("span", "daw-menu-key"), "chevron-right") : el("span", "daw-menu-key", null, key));
    button.addEventListener("click", () => {
      if (run === sectionList) { sectionList(); return; }
      closeDawMenu();
      $("daw-scroll").focus({ preventScroll: true });   // the keys (⌘Z, ⌘V …) keep working
      run();
    });
    return button;
  };
  // The section names, in place of the menu's items.
  const range = has && markedBars(), extra = trailingBars();
  function sectionList() {
    const [from, to] = range;
    menu.replaceChildren(el("div", "menu-label", null, from === to ? `Ölçü ${from + 1} bölümü` : `Ölçü ${from + 1}–${to + 1} bölümü`),
      ...[...$("daw-label-name").options].map((o) => item(o.textContent, "", true, () => assignDawSection(o.value))));
    place();
  }
  menu.append(
    item("Kes", "⌘X", has, () => deleteDawNotes(true)),
    item("Kopyala", "⌘C", has, copyDawNotes),
    item("Yapıştır (sarı çizgiye)", "⌘V", !!dawClip, pasteDawNotes),
    item("Sil", "⌫", has, () => deleteDawNotes(false), " danger"),
    el("div", "menu-divider"),
    item("Bölüm ata (verse, chorus …)", "▸", !!range, sectionList),
    el("div", "menu-divider"),
    item(extra ? `Sondaki boşluğu sil (${extra} boş ölçü)` : "Sonda boş ölçü yok", "", !!extra, trimDawEnd),
  );
  const host = $("daw").getBoundingClientRect();
  $("daw").append(menu);
  function place() {
    const x = Math.min(event.clientX, host.right - menu.offsetWidth - 8), y = Math.min(event.clientY, host.bottom - menu.offsetHeight - 8);
    Object.assign(menu.style, { left: x - host.left + "px", top: y - host.top + "px", right: "auto" });
  }
  place();
}

// Painting a track's bars: a drag adds (or, started on a painted bar, removes) the bars it crosses;
// a click adds or removes the whole section under it.
// Bar ranges of a track: a click on an empty place adds that bar, a drag adds the bars it crosses;
// a range's edges stretch or shrink it, its middle moves it; Shift+click adds the whole section.
// Ranges that touch become one.
function paintTrack(event, k) {
  const track = daw.tracks[k];
  const count = daw.tl.bars.length;
  const first = barAt(timeAt(event.clientX));
  const ranges = (track.bars || [[0, count - 1]]).map((r) => [...r]);
  const block = event.target.closest(".daw-track-block");
  const r = block ? Number(block.dataset.r) : -1;
  // The ends of a bar (10 px, more forgiving than the drawn handles) stretch it; the rest moves it.
  const box = block && block.getBoundingClientRect();
  const edge = box ? Math.min(10, box.width / 3) : 0;
  const mode = !block ? "paint" : event.clientX - box.left < edge ? "left" : box.right - event.clientX < edge ? "right" : "move";
  const before = dawSnapshot();
  let moved = false;
  const clamp = (b) => Math.max(0, Math.min(count - 1, b));
  const apply = (next) => {
    const on = barSet(next.filter(([a, z]) => a <= z), count);
    track.bars = on.size === count ? null : toRanges(on);
    daw.tracksDirty = true;
    renderDaw();
  };
  if (event.shiftKey && mode === "paint") {
    const run = daw.sections.find((s) => s.from <= first && first <= s.to) || { from: first, to: first };
    daw.history.push(before);
    apply([...ranges, [run.from, run.to]]);
    renderDawBar();
    return;
  }
  const move = (e) => {
    const b = clamp(barAt(timeAt(e.clientX)));
    if (b === first && !moved) return;
    moved = true;
    const next = ranges.map((x) => [...x]);
    if (mode === "paint") next.push([Math.min(first, b), Math.max(first, b)]);
    else if (mode === "left") next[r][0] = Math.min(b, next[r][1]);
    else if (mode === "right") next[r][1] = Math.max(b, next[r][0]);
    else {
      const shift = Math.max(-ranges[r][0], Math.min(count - 1 - ranges[r][1], b - first));
      next[r] = [ranges[r][0] + shift, ranges[r][1] + shift];
    }
    apply(next);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!moved && mode === "paint") apply([...ranges, [first, first]]);
    if (moved || mode === "paint") daw.history.push(before);
    renderDawBar();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

$("daw-scroll").addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (target === event.currentTarget) { daw.follow = false; return; }   // its scrollbar
  closeDawMenu();
  if (event.button !== 0) return;   // a right click opens the menu
  if (target.closest(".daw-ask")) return;   // its buttons answer on click
  if (target.closest(".daw-playhead-grip")) { dragPlayhead(event); return; }
  if (target.closest(".daw-track-add")) { addTrack(); return; }
  const trackLabel = target.closest(".daw-track-label");
  if (trackLabel) { openTrackEditor(Number(trackLabel.closest(".daw-track").dataset.track), trackLabel); return; }
  if (target.closest(".daw-label")) return;
  if (target.closest(".daw-ruler")) { dragPlayhead(event); return; }
  const trackRow = target.closest(".daw-track");
  if (trackRow) { paintTrack(event, Number(trackRow.dataset.track)); return; }
  if (target.closest(".daw-tracks-head")) return;

  // Bars: a click on a section takes it whole, a drag takes the bars it crosses.
  if (target.closest(".daw-sections")) {
    const block = target.closest(".daw-section");
    const first = barAt(timeAt(event.clientX));
    let moved = false;
    const move = (e) => {
      const b = barAt(timeAt(e.clientX));
      if (b === first && !moved) return;
      moved = true;
      daw.bars = [Math.min(first, b), Math.max(first, b)];
      renderDaw();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) daw.bars = block ? [Number(block.dataset.from), Number(block.dataset.to)] : [first, first];
      const run = daw.sections.find((s) => s.from === daw.bars[0]);
      if (run && run.label && [...$("daw-label-name").options].some((o) => o.value === run.label)) $("daw-label-name").value = run.label;
      renderDaw();
    };
    daw.note = null;
    daw.sel.clear();
    daw.marked.clear();
    daw.tray = null;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return;
  }

  const melismaGrip = target.closest(".daw-melisma");
  if (melismaGrip) { dragMelisma(event, Number(melismaGrip.dataset.g)); return; }

  const sylBlock = target.closest(".daw-syl");
  if (sylBlock) {
    const g = Number(sylBlock.dataset.g);
    const hadNote = !!daw.note || !!daw.bars;
    selectDaw(g, event);
    if (hadNote) renderDaw(); else refreshDawSelection();
    if (event.shiftKey || event.metaKey || event.ctrlKey || !daw.sel.has(g)) return;
    dragSelection(event, g);
    return;
  }
  const lyricBlock = target.closest(".daw-lyric-section");
  if (lyricBlock) {
    const k = Number(lyricBlock.dataset.section);
    Object.assign(daw, { tray: null, note: null, bars: null });
    daw.marked.clear();
    daw.sel = new Set(sectionSyllables(k));
    daw.anchor = [...daw.sel][0] ?? null;
    renderDaw();
    return;
  }
  const noteBox = target.closest(".daw-note, .daw-ins, .daw-rest");
  if (noteBox && target.closest(".rz") && daw.tray == null) { dragNoteEdge(event, noteBox, target.classList.contains("rz-left")); return; }
  if (noteBox) {
    if (daw.tray != null && noteBox.dataset.n != null) {
      const out = Align.flow(daw.map, [daw.tray], Number(noteBox.dataset.n), dawCount());
      if (typeof out === "string") { dawMsg(out); return; }
      daw.tray = null;
      dawChange({ map: out.map, lyrics: daw.lyrics });
      dawMsg(flowMessage(out));
      return;
    }
    const { voice } = noteBox.dataset, bar = Number(noteBox.dataset.bar), k = Number(noteBox.dataset.k);
    const item = [...daw.tl[voice], ...daw.tl.rests[voice]].find((x) => x.bar === bar && x.k === k);
    if (item && item.midi != null && (event.metaKey || event.ctrlKey)) {
      // ⌘/Ctrl+click: the note in or out of the picked notes (the clicked one comes along).
      if (daw.note && !daw.marked.size) { const p = markedPick(); for (const v of ["vocal", "ins"]) for (const u of p[v]) daw.marked.add(`${v}:${u}`); }
      const key = noteKey(item);
      if (daw.marked.has(key)) daw.marked.delete(key); else daw.marked.add(key);
      Object.assign(daw, { note: null, tray: null, bars: null });
      daw.sel.clear();
      renderDaw();
      return;
    }
    if (item && item.midi != null && daw.marked.has(noteKey(item))) { dragMarked(event, item); return; }
    if (item && item.midi != null) dragNote(event, noteBox, item);
    else if (item) pickDawNote(item);
    return;
  }
  if (target.closest(".daw-roll")) { marqueeNotes(event); return; }
  marquee(event);
});

$("daw-scroll").addEventListener("contextmenu", (event) => {
  if (!event.target.closest(".daw-roll") || event.target.closest(".daw-label, .daw-ask")) return;
  event.preventDefault();
  openDawMenu(event);
});
$("daw-scroll").addEventListener("scroll", closeDawMenu);

$("daw-scroll").addEventListener("dblclick", (event) => {
  if (event.target.closest(".daw-ask")) return;
  if (event.target.closest(".daw-roll") && !event.target.closest(".daw-note, .daw-ins, .daw-label")) { placeDawNote(event); return; }
  const trackBlock = event.target.closest(".daw-track-block");
  if (trackBlock) {
    const track = daw.tracks[Number(trackBlock.closest(".daw-track").dataset.track)];
    const ranges = (track.bars || [[0, daw.tl.bars.length - 1]]).filter((_, r) => r !== Number(trackBlock.dataset.r));
    daw.history.push(dawSnapshot());
    track.bars = ranges;
    daw.tracksDirty = true;
    renderDaw();
    dawMsg("Çubuk silindi (geri alınabilir).");
    return;
  }
  const block = event.target.closest(".daw-syl");
  if (block) editDawSyllable(Number(block.dataset.g), block);
});

// The lyrics panel: a click selects a word (a line by its grip, a section by its name); dragging
// takes the selection onto the timeline.
$("daw-words").addEventListener("pointerdown", (event) => {
  const word = event.target.closest(".dw-word"), grip = event.target.closest(".dw-grip"), head = event.target.closest(".dw-section");
  if (!word && !grip && !head) return;
  event.preventDefault();
  let unit;
  if (head) unit = sectionSyllables(Number(head.dataset.section));
  else unit = (word || grip).dataset[word ? "gs" : "line"].split(",").map(Number);
  if (word && event.altKey) unit = [unit[0]];
  selectDaw(unit[0], event, unit);
  if (daw.note || daw.bars) renderDaw(); else refreshDawSelection();
  // A plain click shows where the word is now; scrolling at the start of a drag would move the
  // place it is dropped on.
  const x0 = event.clientX, y0 = event.clientY;
  window.addEventListener("pointerup", (e) => {
    if (Math.hypot(e.clientX - x0, e.clientY - y0) >= 4) return;
    const placed = unit.map((g) => daw.map[g]).find((n) => n != null);
    if (placed != null) scrollDawTo(daw.tl.vocal[placed].t0);
  }, { once: true });
  if (event.shiftKey || event.metaKey || event.ctrlKey || !daw.sel.size) return;
  dragSelection(event, Math.min(...daw.sel), { fromPanel: true });
});
$("daw-words").addEventListener("dblclick", (event) => {
  const word = event.target.closest(".dw-word");
  if (!word) return;
  const g = Number(word.dataset.gs.split(",")[0]);
  const block = daw.els.sylls.get(g);
  if (block) editDawSyllable(g, block);
});

$("daw").addEventListener("keydown", (event) => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
  const mod = event.metaKey || event.ctrlKey;
  if (event.key === " ") { event.preventDefault(); dawPlay(); return; }
  if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); $("daw-undo").click(); return; }
  if (daw.ask && (event.key === "Enter" || event.key === "Escape")) {
    event.preventDefault();
    const choice = daw.ask.find((c) => c.key === event.key);
    closeAskDaw();
    if (choice) choice.run();
    return;
  }
  if (event.key === "Escape" && document.querySelector(".daw-menu")) { event.preventDefault(); closeDawMenu(); return; }
  if (mod && !event.shiftKey && !event.altKey) {
    const key = event.key.toLowerCase();
    const notes = daw.marked.size || (daw.note && dawPicked() && !dawPicked().rest);
    if (key === "c" && notes) { event.preventDefault(); copyDawNotes(); return; }
    if (key === "x" && notes) { event.preventDefault(); deleteDawNotes(true); return; }
    if (key === "v") { event.preventDefault(); pasteDawNotes(); return; }
  }
  if (daw.marked.size && !mod && /^Arrow/.test(event.key)) {
    event.preventDefault();
    const fine = event.altKey ? 1 : stepUnits();
    if (event.key === "ArrowLeft") moveMarked(-fine, 0);
    else if (event.key === "ArrowRight") moveMarked(fine, 0);
    else moveMarked(0, (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 12 : 1));
    return;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && daw.marked.size) { event.preventDefault(); deleteDawNotes(false); return; }
  if (event.key === "Escape" && (daw.sel.size || daw.marked.size || daw.tray != null || daw.note || daw.bars || daw.trackOpen != null)) {
    event.preventDefault();
    closeTrackEditor();
    Object.assign(daw, { tray: null, note: null, bars: null });
    daw.sel.clear();
    daw.marked.clear();
    renderDaw();
    return;
  }
  if (daw.note) {
    if (mod) return;
    const name = {
      ArrowUp: event.shiftKey ? "octave-up" : "up", ArrowDown: event.shiftKey ? "octave-down" : "down",
      ArrowLeft: event.altKey ? "shift-back" : "prev", ArrowRight: event.altKey ? "shift-on" : "next", "+": "longer", "=": "longer", "-": "shorter",
      Delete: "rest", Backspace: "rest", n: "note", N: "note", i: "insert", I: "insert",
      a: "longer", A: "longer", s: "shorter", S: "shorter", d: "shift-back", D: "shift-back", f: "shift-on", F: "shift-on",
    }[event.key];
    if (name) { event.preventDefault(); dawNoteAction(name); }
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); moveDawSelection(event.key === "ArrowRight" ? 1 : -1); }
  else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deleteDawSelection(); }
  else if (event.key === "Enter" && daw.sel.size === 1) { event.preventDefault(); const g = [...daw.sel][0]; if (daw.els.sylls.get(g)) editDawSyllable(g, daw.els.sylls.get(g)); }
  else if (event.key.toLowerCase() === "w" && !mod) { daw.selMode = daw.selMode === "word" ? "syllable" : "word"; renderDawBar(); }
});

for (const button of document.querySelectorAll("#daw-note-tools [data-note]")) {
  button.addEventListener("click", () => dawNoteAction(button.dataset.note));
}
for (const button of document.querySelectorAll("#daw-selmode [data-mode]")) {
  button.addEventListener("click", () => { daw.selMode = button.dataset.mode; renderDawBar(); });
}

$("daw-set-section").addEventListener("click", () => {
  if (!daw.bars || scoreLocked()) return;
  dawScore(ScoreModel.setSection(daw.model, daw.bars[0], daw.bars[1], $("daw-label-name").value), null);
});

$("daw-swap").addEventListener("click", () => {
  if (!daw.bars || scoreLocked()) return;
  const [a, b] = daw.bars;
  const { model, from, to } = ScoreModel.swapVoices(daw.model, a, b);
  dawScore(model, null, [from, to]);
  if (from !== a || to !== b) {
    dawMsg(`Bağlı (uzatılan) bir nota bölünmesin diye seçim ölçü ${from + 1}–${to + 1} olarak ayarlandı; bağlı nota devamıyla aynı seste kaldı. ${$("daw-msg").textContent}`);
  }
});

$("daw-play").addEventListener("click", dawPlay);
// Horizontal zoom around a point of the view (the pointer, else the playhead when it is in view,
// else the middle): the moment under it stays where it was.
function zoomDaw(factor, clientX) {
  const scroll = $("daw-scroll"), box = scroll.getBoundingClientRect();
  const pps = Math.max(8, Math.min(1500, daw.pps * factor));
  if (pps === daw.pps) return;
  if (clientX == null) {
    const head = box.left + dawX(daw.pos) - scroll.scrollLeft;
    clientX = head > box.left + DAW_LEFT && head < box.right ? head : box.left + box.width / 2;
  }
  const t = Math.max(0, timeAt(clientX));
  daw.pps = pps;
  renderDaw();
  scroll.scrollLeft = Math.max(0, dawX(t) - (clientX - box.left));
}
$("daw-zoom-in").addEventListener("click", () => zoomDaw(1.4));
$("daw-zoom-out").addEventListener("click", () => zoomDaw(1 / 1.4));
// ⌘/Ctrl + wheel and a trackpad pinch zoom the time axis at the pointer.
$("daw-scroll").addEventListener("wheel", (event) => {
  if (!(event.ctrlKey || event.metaKey)) { if (event.deltaX || event.shiftKey) daw.follow = false; return; }
  event.preventDefault();
  zoomDaw(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025)), event.clientX);
}, { passive: false });
$("daw-after").addEventListener("click", () => {
  const first = Math.min(...daw.sel);
  daw.sel = new Set(Align.range(first, daw.map.length - 1));
  refreshDawSelection();
});
$("daw-undo").addEventListener("click", () => {
  const last = daw.history.pop();
  if (!last) return;
  if (last.abc !== daw.abc) { dawPause(); if (daw.synth) { daw.synth.stop(); daw.synth = null; } }
  const lyricsChanged = last.lyrics !== daw.lyrics;
  Object.assign(daw, last);
  daw.sel.clear();
  daw.marked.clear();
  closeTrackEditor();
  renderDaw();
  if (lyricsChanged) renderDawWords();
});
$("daw-tidy").addEventListener("click", tidyDaw);
$("daw-auto").addEventListener("click", () => {
  if (!confirm("Heceler melodinin cümlelerine göre yeniden yerleşsin mi? (Harf düzeltmeleri kalır; geri alınabilir.)")) return;
  daw.sel.clear();
  dawChange({ map: Align.autoAlign(daw.tl, daw.lyrics), lyrics: daw.lyrics });
});

// ---- the lyrics text

$("daw-lyrics-edit").addEventListener("click", () => {
  $("daw-lyrics-text").value = daw.lyrics;
  $("daw-side").classList.add("editing");
  $("daw-lyrics-text").focus();
});
$("daw-lyrics-cancel").addEventListener("click", () => $("daw-side").classList.remove("editing"));
$("daw-lyrics-apply").addEventListener("click", () => {
  const text = $("daw-lyrics-text").value.trim();
  $("daw-side").classList.remove("editing");
  if (text === daw.lyrics) return;
  // The syllables that were there keep their notes (a corrected one too); new ones go on the empty
  // notes where they are put in. Only lyrics with nothing left of the old ones are laid out anew.
  const carried = LyricsLayout.carryLayout(daw.lyrics, text, daw.map, daw.tl.vocal.length);
  dawChange({ map: carried ? carried.map : Align.autoAlign(daw.tl, text), lyrics: text });
  if (!carried) { dawMsg("Söz baştan değişti; heceler melodiye yeniden yerleştirildi."); return; }
  const parts = [`${carried.kept} hece yerinde kaldı`];
  if (carried.placed) parts.push(`${carried.placed} yeni hece boş notalara yerleşti`);
  if (carried.loose) parts.push(`${carried.loose} yeni hece için boş nota yok: aşağıda, sürükleyip yerleştir`);
  dawMsg(`Söz güncellendi; ${parts.join(", ")}.`);
});
$("daw-side-toggle").addEventListener("click", () => {
  const hidden = $("daw").classList.toggle("no-side");
  Icons.set($("daw-side-toggle"), hidden ? "panel-right-open" : "panel-right-close");
  renderDaw();
});

// ---- tracks

function addTrack() {
  daw.history.push(dawSnapshot());
  daw.tracks.push({ id: dawId(), instrument: "strings", feel: [], text: "", bars: [], lead: false });
  daw.tracksDirty = true;
  renderDaw();
  const label = document.querySelector(`.daw-track[data-track="${daw.tracks.length - 1}"] .daw-label`);
  openTrackEditor(daw.tracks.length - 1, label);
}

function closeTrackEditor() {
  daw.trackOpen = null;
  $("daw-track-pop").classList.add("hidden");
}

function openTrackEditor(k, anchor) {
  const track = daw.tracks[k];
  if (!track) return;
  daw.trackOpen = k;
  const pop = $("daw-track-pop");
  const known = Arrange.INSTRUMENTS.some(([en]) => en === track.instrument);
  $("dt-instrument").replaceChildren(...Arrange.INSTRUMENTS.map(([en, tr]) => new Option(tr, en)), new Option("Diğer (kendin yaz)…", ""));
  $("dt-instrument").value = known ? track.instrument : "";
  $("dt-custom").value = known ? "" : track.instrument;
  $("dt-custom").classList.toggle("hidden", known);
  $("dt-text").value = track.text || "";
  $("dt-lead").checked = !!track.lead;
  $("dt-feel").replaceChildren(...Arrange.FEELS.map(([en, tr]) => {
    const chip = el("button", "chip" + ((track.feel || []).includes(en) ? " on" : ""), null, tr);
    chip.type = "button";
    chip.dataset.feel = en;
    chip.title = en;
    return chip;
  }));
  renderTrackPhrase();
  pop.classList.remove("hidden");
  // Beside the track's name, below its row or (no room there) above it, so the row stays visible.
  const host = $("daw").getBoundingClientRect(), box = (anchor || $("daw-scroll")).getBoundingClientRect();
  const below = box.bottom - host.top + 4, above = box.top - host.top - pop.offsetHeight - 4;
  const top = below + pop.offsetHeight <= host.height - 12 ? below : Math.max(56, above);
  Object.assign(pop.style, { left: Math.max(8, box.right - host.left + 8) + "px", top: top + "px" });
}

function editTrack(change) {
  const track = daw.tracks[daw.trackOpen];
  if (!track) return;
  daw.history.push(dawSnapshot());
  change(track);
  daw.tracksDirty = true;
  renderDaw();
  renderTrackPhrase();
}

function renderTrackPhrase() {
  const track = daw.tracks[daw.trackOpen];
  if (!track) return;
  $("dt-phrase").textContent = Arrange.trackPhrase(track, daw.sections, daw.tl.bars.length)
    || "— (henüz bir yere çubuk eklenmedi; şeritte başlayacağı ölçüye tıkla ya da sürükle)";
  for (const chip of $("dt-feel").children) chip.classList.toggle("on", (track.feel || []).includes(chip.dataset.feel));
}

$("dt-instrument").addEventListener("change", () => {
  const value = $("dt-instrument").value;
  $("dt-custom").classList.toggle("hidden", !!value);
  if (value) editTrack((t) => { t.instrument = value; });
  else $("dt-custom").focus();
});
$("dt-custom").addEventListener("input", () => editTrack((t) => { t.instrument = $("dt-custom").value.trim().slice(0, 80); }));
$("dt-text").addEventListener("input", () => editTrack((t) => { t.text = $("dt-text").value.slice(0, 300); }));
$("dt-lead").addEventListener("change", () => editTrack((t) => { t.lead = $("dt-lead").checked; }));
$("dt-feel").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-feel]");
  if (!chip) return;
  editTrack((t) => {
    const feel = new Set(t.feel || []);
    if (feel.has(chip.dataset.feel)) feel.delete(chip.dataset.feel); else feel.add(chip.dataset.feel);
    t.feel = [...feel].slice(0, 12);
  });
});
$("dt-all").addEventListener("click", () => editTrack((t) => { t.bars = null; }));
$("dt-none").addEventListener("click", () => editTrack((t) => { t.bars = []; }));
$("dt-delete").addEventListener("click", () => {
  const k = daw.trackOpen;
  if (k == null) return;
  daw.history.push(dawSnapshot());
  daw.tracks.splice(k, 1);
  daw.tracksDirty = true;
  closeTrackEditor();
  renderDaw();
});
$("dt-close").addEventListener("click", closeTrackEditor);

// ---- what YuE2 will get

function dawBaseStyle() {
  const item = daw.item;
  if (item && source && source.id === item.id && $("style").value.trim()) return $("style").value.trim();
  return (item && item.style) || (daw.job && (daw.job.style_base || daw.job.style)) || "";
}

$("daw-preview").addEventListener("click", () => {
  try {
    const compiled = Arrange.compile({ abc: daw.abc, lyrics: daw.lyrics, map: daw.map, melisma: daw.melisma, tracks: daw.tracks, style: dawBaseStyle(),
      chords: !(daw.design && daw.design.harmony === "free") });
    showYuePreview(compiled, daw.design ? `${daw.item.name} · ${daw.design.name}` : daw.job.title, dawDirty() || daw.layoutFresh);
  } catch (error) { dawMsg(`Önizleme hazırlanamadı: ${error.message}`); }
});

// ---- saving

$("daw-save").addEventListener("click", async () => {
  const notes = [];
  $("daw-save").disabled = true;
  const at = () => Timeline.onsets(daw.tl, daw.map);
  // The syllables' notes, and how many notes the hand-set melismas take.
  const layoutOf = () => ({ at: at(), ...(daw.melisma.some((k) => k != null) ? { melisma: daw.melisma } : {}) });
  const trackList = () => daw.tracks.map(({ id, instrument, feel, text, bars, lead }) => ({ id, instrument, feel: feel || [], text: text || "", bars: bars ?? null, lead: !!lead }));
  try {
    if (daw.design) {
      // Everything belongs to the eser tasarımı; the source and the recording stay as they are.
      const design = daw.design;
      const body = {};
      if (daw.scoreDirty) body.abc = daw.abc;
      if (daw.scoreDirty || daw.layoutDirty || daw.layoutFresh) body.lyrics_layout = layoutOf();
      if (daw.lyrics !== (design.lyrics || "")) body.lyrics = daw.lyrics;
      if (daw.tracksDirty) body.tracks = trackList();
      if (Object.keys(body).length) {
        const updated = await api(`/designs/${design.id}`, { method: "PATCH", body: JSON.stringify(body) });
        daw.design = updated;
        updateDesign(updated);
        if (body.lyrics != null && source && source.design_id === design.id) $("lyrics").value = daw.lyrics;
        const what = [body.abc && "nota", body.lyrics_layout && "hece yerleşimi", body.lyrics != null && "söz", body.tracks && "izler"].filter(Boolean);
        notes.push(`${what.join(", ").replace(/^./, (c) => c.toUpperCase())} «${updated.name}» eser tasarımına kaydedildi; onunla yapılacak düzenlemeler bunlarla hazırlanır.`);
      }
      daw.scoreDirty = daw.layoutDirty = daw.tracksDirty = daw.layoutFresh = false;
    } else if (daw.ctx === "job" && daw.scoreDirty && daw.item) {
      // An arrangement's score edited: kept as a new eser tasarımı of its source.
      const job = daw.job;
      const made = await api(`/sources/${daw.item.id}/designs`, { method: "POST", body: JSON.stringify({
        name: `${job.title} notası`, abc: daw.abc, lyrics: daw.lyrics, lyrics_layout: layoutOf(), tracks: trackList(),
        origin: `«${job.title}» düzenlemesinden`,
      }) });
      daw.design = made;
      daw.origin = `eser tasarımı «${made.name}»`;
      updateDesign(made);
      daw.scoreDirty = daw.layoutDirty = daw.tracksDirty = daw.layoutFresh = false;
      notes.push(`Nota, söz ve hece yerleşimi "${daw.item.name}" bestesinde «${made.name}» adlı yeni eser tasarımı olarak kaydedildi. Ondan düzenleme yapmak için bestede "Bununla düzenle"yi seç.`);
    } else if (daw.layoutDirty) {
      const job = daw.job;
      const changed = daw.lyrics !== (job.lyrics || "");
      const layout = changed ? { ...layoutOf(), lyrics: daw.lyrics } : layoutOf();
      const updated = await api(`/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ lyrics_layout: layout, lyrics_start: null }) });
      jobs = jobs.map((j) => (j.id === updated.id ? updated : j));
      job.lyrics_layout = layout;
      job.lyrics_start = null;
      score.layout = LyricsLayout.normalize(layout);
      daw.layoutDirty = false;
      notes.push("Hece yerleşimi bu düzenlemeye kaydedildi.");
      const item = daw.item;
      if (changed && item && daw.lyrics !== (item.lyrics || "")) {
        const other = item.lyrics && item.lyrics !== job.lyrics ? "\n\nDikkat: bestenin kayıtlı sözü bu düzenlemeninkinden farklı; düzeltilmiş sözle değiştirilir." : "";
        if (confirm(`Sözdeki harfleri değiştirdin. "${item.name}" bestesinin sözü de bu sözle güncellensin mi? Bu besteden yapılacak yeni düzenlemeler düzeltilmiş sözle üretilir (YuE2 sözü okur).${other}`)) {
          await saveSourceText(item, item.style || "", daw.lyrics);
          renderSources();
          notes.push("Bestenin sözü de güncellendi.");
        }
      }
    }
    dawMsg(notes.join(" "));
  } catch (error) {
    dawMsg(`Kaydedilemedi: ${error.message}`);
  }
  renderDawBar();
});

const fmtStamp = (seconds) => new Date(seconds * 1000).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function closeDaw() {
  if (dawDirty() && !confirm("Kaydedilmemiş değişiklikler silinsin mi?")) return;
  dawPause();
  if (daw.synth) { daw.synth.stop(); daw.synth = null; }
  closeTrackEditor();
  $("daw").close();
  if (daw.ctx === "job") {
    layLyrics();
    drawScore();
    setScoreButtons(true);
  } else {
    renderSources();
    updateCreate();
  }
}
$("daw-close").addEventListener("click", closeDaw);
$("daw").addEventListener("cancel", (event) => { event.preventDefault(); closeDaw(); });
$("score-daw").addEventListener("click", openDaw);
window.addEventListener("resize", () => { if ($("daw").open) renderDaw(); });
