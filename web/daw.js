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
  tracks: [], history: [], sel: new Set(), anchor: null, tray: null, note: null, bars: null, sung: new Set(),
  pps: 70, pos: 0, playing: false, synth: null, startedAt: 0, raf: 0, focus: null, els: null, selMode: "word",
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

// From an arrangement's score window.
async function openDaw() {
  const job = score.job;
  const item = scoreSource();
  let abc = score.abc, origin = "bu düzenlemenin notası";
  try {
    if (item && item.score_edited && item.score_url) {
      abc = await fetchText(item.score_url, "bestenin notası");
      origin = "bestenin düzeltilmiş notası";
    }
  } catch (error) {
    $("score-status").textContent = `Zaman çizgisi açılamadı: ${error.message}`;
    return;
  }
  const lyrics = score.layout.lyrics ?? job.lyrics ?? "";
  // The layout belongs to this arrangement's score; on the source's corrected score the syllables
  // go to the notes starting at the same moments.
  const jobMap = layoutMap(score.abc, lyrics, score.layout);
  let map = jobMap;
  if (abc !== score.abc) {
    try { map = carryMap(Timeline.build(score.abc), Timeline.build(abc), jobMap); } catch (error) { /* shown below */ }
  }
  stopScore();
  if (!startDaw({ ctx: "job", job, item, origin, abc, lyrics, map, tracks: [], title: job.title })) return;
}

// From a source song: its own score (corrected, else the extracted one), lyrics, layout and tracks.
// `lyrics`: the lyrics typed in the form when they differ from the saved ones (laid out afresh and
// saved on the source with the layout).
async function openSourceDaw(item, lyrics = item.lyrics || "") {
  try {
    await loadAbcjs();
    const url = item.score_url || item.transcript_url;
    if (!url) throw new Error("bu bestenin notası henüz çıkarılmadı");
    const abc = await fetchText(url, "bestenin notası");
    const own = lyrics === (item.lyrics || "");
    const opened = startDaw({
      ctx: "source", job: null, item, abc, lyrics, title: item.name,
      origin: item.score_edited ? "bestenin düzeltilmiş notası" : "SheetSage2'nin çıkardığı nota",
      map: layoutMap(abc, lyrics, own && item.lyrics_layout ? LyricsLayout.normalize(item.lyrics_layout) : null),
      tracks: JSON.parse(JSON.stringify(item.tracks || [])).map((t) => ({ ...t, id: t.id || dawId() })),
    });
    if (!opened) return;
    // An automatic layout is offered for saving like an edited one (the summary on the source card
    // and the create panel then count it as placed).
    const at = own && item.lyrics_layout && item.lyrics_layout.at;
    if (!(at && at.length === daw.map.length) && daw.map.length) { daw.layoutFresh = true; renderDawBar(); }
    if (!own) { daw.layoutDirty = true; renderDawBar(); }
    if (!own) dawMsg("Formdaki söz (bestede kayıtlı olandan farklı) melodiye otomatik yerleştirildi; Kaydet ile söz de besteye kaydedilir.");
  } catch (error) { report(error); }
}

async function fetchText(url, what) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${what} alınamadı (${response.status})`);
  return response.text();
}

const dawId = () => Math.random().toString(36).slice(2, 10);

function startDaw({ ctx, job, item, origin, abc, lyrics, map, tracks, title }) {
  let model, tl;
  try {
    model = ScoreModel.parse(abc);
    tl = Timeline.fromModel(model);
  } catch (error) {
    const message = `Zaman çizgisi açılamadı: ${error.message}`;
    if (ctx === "job") $("score-status").textContent = message; else report(new Error(message));
    return false;
  }
  Object.assign(daw, { ctx, job, item, origin, abc, model, tl, lyrics, map, tracks, history: [], sel: new Set(), anchor: null, tray: null,
    note: null, bars: null, pos: 0, focus: null, scoreDirty: false, layoutDirty: false, tracksDirty: false, trackOpen: null, layoutFresh: false });
  if (daw.map.length !== LyricsLayout.allSyllables(lyrics).length) daw.map = Align.autoAlign(tl, lyrics);
  // Zoom so a typical note is wide enough for its syllable.
  const lengths = tl.vocal.map((n) => n.t1 - n.t0).sort((a, b) => a - b);
  daw.pps = lengths.length ? Math.max(40, Math.min(400, 34 / lengths[Math.floor(lengths.length / 2)])) : 70;
  const unit = ScoreModel.unitDenominator(model);
  // Lengthen/shorten steps a musician thinks in, as L: units (only the ones the grid can hold).
  $("daw-step").replaceChildren(...[[16, "1/16"], [8, "1/8"], [4, "1/4"]]
    .filter(([den]) => unit % den === 0).map(([den, name]) => new Option(`adım ${name}`, String(unit / den))));
  $("daw-title").textContent = title;
  $("daw").classList.toggle("source-mode", ctx === "source");
  dawMsg(ctx === "source" && !(item.lyrics_layout && item.lyrics_layout.at && item.lyrics_layout.at.length === daw.map.length) && daw.map.length
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

function trackName(track) {
  return Arrange.instrumentLabel[track.instrument] || track.instrument || "enstrüman";
}

function renderDaw() {
  const { tl } = daw;
  const words = LyricsLayout.layOut(daw.abc, daw.lyrics, LyricsLayout.normalize({ map: daw.map }));
  daw.words = words;
  const sylls = LyricsLayout.allSyllables(daw.lyrics);
  daw.sylls = sylls;
  daw.sung = sylls.length ? Arrange.sungNotes(daw.map, sylls, tl) : new Set();
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

  // Score sections (what YuE2 is told is intro, verse, …); a click or a drag selects bars.
  const sections = lane("Bölüm", 24, "daw-sections");
  for (const section of tl.sections) {
    const block = el("div", "daw-section" + (section.sung ? " sung" : ""), {
      left: dawX(section.t0) + "px", width: (section.t1 - section.t0) * daw.pps - 2 + "px",
    }, `${section.label || "adsız"} ${section.sung ? "🎤" : "🎹"}`);
    block.title = `Notadaki bölüm: ${section.label || "adsız"}, ölçü ${section.from + 1}–${section.to + 1} (${section.sung ? "söylenen" : "yalnız enstrüman"}). Tıkla ya da sürükle: ölçüleri seç`;
    block.dataset.from = section.from;
    block.dataset.to = section.to;
    sections.append(block);
  }

  // Piano roll: vocal notes over faded instrument notes; vocal rests along the bottom.
  const pitches = [...tl.vocal, ...tl.ins].map((n) => n.midi);
  const top = Math.max(...pitches, 72) + 2, low = Math.min(...pitches, 55) - 2;
  // The roll takes the height the other lanes leave free.
  const trackHeight = daw.ctx === "source" ? 22 + daw.tracks.length * 30 : 0;
  const free = $("daw-scroll").clientHeight - 26 - 24 - 20 - 34 - 20 - trackHeight;
  const row = Math.max(4, Math.min(16, Math.floor((free - 10) / (top - low + 1))));
  const rollHeight = (top - low + 1) * row + 10;
  const roll = lane("Melodi", rollHeight, "daw-roll");
  for (let m = low; m <= top; m++) if (m % 12 === 0) roll.append(el("div", "daw-c-line", { top: (top - m) * row + row - 1 + "px" }, `C${m / 12 - 1}`));
  for (const bar of tl.bars) roll.append(el("div", "daw-bar-line", { left: dawX(bar.t0) + "px" }));
  const span = (item) => ({ left: dawX(item.t0) + "px", width: Math.max(3, (item.t1 - item.t0) * daw.pps - 1) + "px" });
  const picked = (item) => daw.note && daw.note.voice === item.voice && daw.note.bar === item.bar && daw.note.k === item.k;
  const tag = (node, item) => { node.dataset.voice = item.voice; node.dataset.bar = item.bar; node.dataset.k = item.k; return node; };
  for (const note of tl.ins) {
    const box = tag(el("div", "daw-ins" + (picked(note) ? " picked" : ""), { ...span(note), top: (top - note.midi) * row + "px", height: row - 1 + "px" }), note);
    box.title = `${note.name} · Enstrüman · ölçü ${note.bar + 1}`;
    roll.append(box);
  }
  const hasLyrics = sylls.length > 0;
  for (const note of tl.vocal) {
    const slot = words.slots[note.number];
    const state = slot && !slot.hold ? " sung" : daw.sung.has(note.number) ? " held" : hasLyrics ? " unsung" : "";
    const box = tag(el("div", "daw-note" + state + (picked(note) ? " picked" : ""),
      { ...span(note), top: (top - note.midi) * row + "px", height: row - 1 + "px" }), note);
    box.dataset.n = note.number;
    box.title = `${note.name} · ölçü ${note.bar + 1} · ${fmtTime(note.t0)}${state === " unsung" ? " · hecesi yok: düzenlemede ölçü tümüyle hecesizse enstrümana verilir, değilse YuE2 mırıldanabilir" : ""}`;
    if (slot && !slot.hold && slot.index.some((g) => daw.sel.has(g))) box.classList.add("selected");
    roll.append(box);
    daw.els.notes.set(note.number, box);
  }
  for (const rest of tl.rests.vocal) {
    const box = tag(el("div", "daw-rest" + (picked(rest) ? " picked" : ""), { ...span(rest), top: rollHeight - 8 + "px" }), rest);
    box.title = `Sus · ölçü ${rest.bar + 1}`;
    roll.append(box);
  }

  // Lyric sections: where each [Verse], [Chorus] … of the lyrics is sung; a click selects it.
  const lyricLane = lane("Söz bölümü", 20, "daw-lyric-lane");
  words.sections.forEach((section, k) => {
    if (!section.placed) return;
    const t0 = tl.vocal[section.start].t0, t1 = tl.vocal[section.end - 1].t1;
    const missing = section.count - section.placed;
    const block = el("div", "daw-lyric-section", { left: dawX(t0) + "px", width: Math.max(20, (t1 - t0) * daw.pps - 2) + "px", background: dawSectionColor(k) },
      `${section.tag || "söz"}${missing ? ` ⚠ ${missing}` : ""}`);
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
    if (slot.hold) { syl.append(el("div", "daw-hold", { left: dawX(note.t0) + "px", width: Math.max(2, w - 1) + "px" })); return; }
    slot.index.forEach((g, i) => {
      const part = w / slot.index.length;
      const block = el("div", "daw-syl" + (daw.sel.has(g) ? " selected" : "") + (sylls[g].joined ? " joined" : ""), {
        left: dawX(note.t0) + i * part + "px", width: Math.max(14, part - 2) + "px", borderColor: dawSectionColor(sylls[g].section),
      }, sylls[g].text);
      block.dataset.g = g;
      block.title = `${sylls[g].text} · ${words.sections[sylls[g].section].tag || "söz"} · ölçü ${note.bar + 1}`;
      syl.append(block);
      daw.els.sylls.set(g, block);
    });
  });
  // Held syllables: the melisma line after a syllable's last note, up to the next one.
  for (const n of daw.sung) {
    const note = tl.vocal[n];
    if (!words.slots[n] && note) syl.append(el("div", "daw-hold", { left: dawX(note.t0) + "px", width: Math.max(2, (note.t1 - note.t0) * daw.pps - 1) + "px" }));
  }

  lanes.append(ruler, sections, roll, lyricLane, syl);

  // Instrument tracks (source songs only): what plays how, and where (painted bars).
  if (daw.ctx === "source") {
    const head = lane("", 22, "daw-tracks-head");
    const add = el("button", "daw-track-add", null, "+ İz ekle");
    add.type = "button";
    add.title = "Bir enstrüman izi ekle: hangi enstrüman, nasıl ve nerede çalsın";
    head.querySelector(".daw-label").replaceChildren(add);
    head.append(el("div", "daw-tracks-hint small", { left: DAW_LEFT + 8 + "px" }, daw.tracks.length
      ? "Şeritte sürükle: ölçüleri boya/sil · bölüme tıkla: o bölümü ekle/çıkar · ada tıkla: enstrümanı ve çalışını yaz"
      : "İz ekle: örn. coşkulu yaylılar nakaratlarda, yumuşak piyano baştan sona. YuE2'ye stil metni olarak gider."));
    lanes.append(head);
    daw.tracks.forEach((track, k) => {
      const row = lane("", 30, "daw-track");
      row.dataset.track = k;
      const label = row.querySelector(".daw-label");
      label.classList.add("daw-track-label");
      label.style.borderLeft = `4px solid ${dawTrackColor(k)}`;
      label.textContent = trackName(track);
      label.title = `${Arrange.trackPhrase(track, ScoreModel.sections(daw.model), tl.bars.length)}\nTıkla: düzenle`;
      for (const s of tl.sections) row.append(el("div", "daw-track-sep", { left: dawX(s.t0) + "px" }));
      const ranges = track.bars || [[0, tl.bars.length - 1]];
      for (const [a, b] of ranges) {
        if (a >= tl.bars.length) continue;
        const z = Math.min(b, tl.bars.length - 1);
        const block = el("div", "daw-track-block", {
          left: dawX(tl.bars[a].t0) + "px", width: Math.max(4, (tl.bars[z].t1 - tl.bars[a].t0) * daw.pps - 2) + "px", background: dawTrackColor(k),
        }, [...(track.feel || []).map((f) => Arrange.feelLabel[f] || f), track.lead ? "melodi" : ""].filter(Boolean).join(", "));
        row.append(block);
      }
      lanes.append(row);
    });
  }

  if (daw.bars) {
    const [a, b] = daw.bars;
    lanes.append(el("div", "daw-range", { left: dawX(tl.bars[a].t0) + "px", width: (tl.bars[b].t1 - tl.bars[a].t0) * daw.pps + "px" }));
  }
  const head = el("div", "daw-playhead");
  daw.els.playhead = head;
  lanes.append(head);
  const scroll = $("daw-scroll");
  const left = scroll.scrollLeft;
  scroll.replaceChildren(lanes);
  scroll.scrollLeft = left;
  placePlayhead();
  renderDawTray();
  renderDawBar();
  refreshDawWords();
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
    chip.title = `${daw.words.sections[sylls[g].section].tag || "söz"}: notaya düşmüyor. Sağdaki söz listesinden sürükle ya da seç, sonra boş bir vokal notasına tıkla; çift tıkla: sil.`;
    chip.onclick = () => { daw.tray = daw.tray === g ? null : g; daw.sel.clear(); daw.note = null; refreshDawSelection(); };
    chip.ondblclick = () => editDawSyllable(g, chip);
    return chip;
  });
  $("daw-tray").replaceChildren(el("span", "muted small", null, `Notaya düşmeyen ${loose.length} hece:`), ...chips);
}

// ---- the lyrics panel: every line and word; click to select, drag onto the timeline to place

function renderDawWords() {
  const { lines, sylls } = Align.lyricLines(daw.lyrics);
  const sections = LyricsLayout.lyricSections(daw.lyrics);
  const box = $("daw-words");
  const out = [];
  let section = -1;
  for (const line of lines) {
    if (line.section !== section) {
      section = line.section;
      const head = el("div", "dw-section", { borderColor: dawSectionColor(section) }, sections[section].tag || "söz");
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
  if (!lines.length) out.push(el("p", "muted small", null, "Bu bestenin sözü yok. ✎ Sözü yaz ile ekle; heceler melodiye kendiliğinden yerleşir."));
  box.replaceChildren(...out);
  refreshDawWords();
}

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

// YuE2 matches lyric sections to the score's sung sections by name and order. In a source song the
// arrangement renames the score's sections after the lyrics anyway, so only the laying out counts.
function compareText() {
  const scoreNames = daw.tl.sections.filter((s) => s.sung).map((s) => LyricsLayout.sectionName(s.label));
  const lyricNames = LyricsLayout.lyricSections(daw.lyrics).map((s) => s.name);
  if (!lyricNames.length) return { text: "", warn: false };
  const placed = daw.map.filter((n) => n != null).length;
  if (daw.ctx === "source") {
    const missing = daw.map.length - placed;
    return missing
      ? { text: `⚠ ${missing} hece notaya yerleşmedi (aşağıda). Düzenlemede bölüm adları sözlerin yerleştiği yere göre verilir.`, warn: true }
      : { text: `✓ ${placed} hecenin hepsi bir notada. Düzenlemede notanın bölümleri sözlere göre adlandırılır, hecesiz ölçüler enstrümana geçer (👁 YuE2'ye gidecekler).`, warn: false };
  }
  const both = `Notada söylenen: ${scoreNames.join(" → ") || "—"} · Sözde: ${lyricNames.join(" → ")}`;
  if (scoreNames.join() === lyricNames.join()) return { text: `✓ ${both}`, warn: false };
  const hints = [];
  if (scoreNames[0] === "intro" && lyricNames[0] !== "intro") hints.push("introda söylenen nota var: giriş enstrümanla çalınacaksa intro ölçülerini seçip Vokal ⇄ Enstrüman yap");
  const missing = [...new Set(lyricNames.filter((name) => !scoreNames.includes(name)))];
  if (missing.length) hints.push(`sözde olup notada olmayan bölüm: ${missing.join(", ")}; ölçüleri seçip bölüm adını ver`);
  return { text: `⚠ Sıra farklı (YuE2 sözleri bölümlere kendisi dağıtır). ${both}${hints.length ? ` · ${hints.join("; ")}` : ""}`, warn: true };
}

function renderDawBar() {
  const note = dawPicked();
  const n = daw.sel.size;
  $("daw-note-tools").classList.toggle("hidden", !note);
  $("daw-bar-tools").classList.toggle("hidden", !!note || !daw.bars);
  const compare = compareText();
  $("daw-compare").classList.toggle("hidden", !!note || !!daw.bars || !compare.text);
  $("daw-compare").textContent = compare.text;
  $("daw-compare").title = compare.text;
  $("daw-compare").classList.toggle("warn", compare.warn);
  if (note) {
    const pick = daw.note;
    const tied = note.tieOut || note.contIn ? " · ölçü çizgisinin üzerinden bağlı" : "";
    $("daw-note-info").textContent = `${note.rest ? "Sus" : ScoreModel.pitchName(note)} · ${durationText(note.dur)} · ${pick.voice === "vocal" ? "Vokal" : "Enstrüman"}, ölçü ${pick.bar + 1}${tied}`;
    for (const button of document.querySelectorAll("#daw-note-tools [data-note]")) {
      const op = button.dataset.note;
      button.classList.toggle("hidden", (op === "note" && !note.rest) || (op === "rest" && note.rest)
        || (note.rest && ["up", "down", "octave-up", "octave-down"].includes(op)));
    }
  }
  if (daw.bars && !note) {
    const [a, b] = daw.bars;
    $("daw-bar-info").textContent = a === b ? `Ölçü ${a + 1}` : `Ölçü ${a + 1}–${b + 1}`;
  }
  let info;
  if (daw.tray != null) info = `«${daw.sylls[daw.tray].text}» hecesini koymak için bir vokal notasına tıkla.`;
  else if (note) info = "↑/↓ yarım ses (Shift: oktav) · +/− uzat/kısalt · ←/→ önceki/sonraki · Delete: sus · N: notaya çevir";
  else if (daw.bars) info = "Seçili ölçülere bölüm adı ver ya da söylenen ve çalınan notaları değiştir.";
  else if (n) info = `${n} hece seçili · sürükle: bıraktığın notadan başlayarak notalara dizilir (Alt: aralıkları koru), önündekiler kayar · ←/→ bir nota kaydır · çift tık: harfleri düzelt · Delete: sil`;
  else info = `Tıkla: ${daw.selMode === "word" ? "kelime" : "hece"} seç (Alt+tık: ${daw.selMode === "word" ? "tek hece" : "kelime"}) · boş yerden sürükle: alan seç · Shift: aralık · ⌘/Ctrl: ekle · notaya tıkla: perde/süre · Boşluk: çal`;
  $("daw-info").textContent = info;
  $("daw-undo").disabled = !daw.history.length;
  $("daw-save").disabled = !dawDirty() && !daw.layoutFresh;
  $("daw-after").disabled = !n;
  $("daw-reset").classList.toggle("hidden", !(daw.item && daw.item.score_edited));
  $("daw-origin").textContent = `Nota: ${daw.origin}${daw.scoreDirty ? " (değişti)" : ""}`;
  $("daw-play").textContent = daw.playing ? "⏸" : "▶";
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
    daw.startedAt = score.audio.currentTime - daw.pos;
    daw.playing = true;
    const tick = () => {
      if (!daw.playing) return;
      daw.pos = score.audio.currentTime - daw.startedAt;
      if (daw.pos >= daw.tl.duration) { dawPause(); daw.pos = daw.tl.duration; placePlayhead(); return; }
      placePlayhead();
      // Keep the playhead in view.
      const scroll = $("daw-scroll"), x = dawX(daw.pos);
      if (x > scroll.scrollLeft + scroll.clientWidth - 80 || x < scroll.scrollLeft + DAW_LEFT) scroll.scrollLeft = x - DAW_LEFT - 40;
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
  const { model, abc, tl, map, lyrics, note, bars, scoreDirty, layoutDirty, tracksDirty } = daw;
  return { model, abc, tl, map, lyrics, note, bars, scoreDirty, layoutDirty, tracksDirty, tracks: JSON.parse(JSON.stringify(daw.tracks)) };
}

// A new syllable layout or lyrics.
function dawChange(next) {
  daw.history.push(dawSnapshot());
  const lyricsChanged = next.lyrics !== daw.lyrics;
  daw.map = next.map;
  daw.lyrics = next.lyrics;
  daw.layoutDirty = true;
  dawMsg("");
  renderDaw();
  if (lyricsChanged) renderDawWords();
}

// A new score: the synth must be primed again and the syllables follow their notes by time.
function dawScore(model, note, bars) {
  const abc = ScoreModel.serialize(model).text;
  const tl = Timeline.build(abc);
  daw.history.push(dawSnapshot());
  const map = carryMap(daw.tl, tl, daw.map);
  if (map.some((n, g) => (n == null) !== (daw.map[g] == null))) daw.layoutDirty = true;
  dawPause();
  if (daw.synth) { daw.synth.stop(); daw.synth = null; }
  const lost = map.filter((n) => n == null).length - daw.map.filter((n) => n == null).length;
  Object.assign(daw, { model, abc, tl, map, note, bars: bars === undefined ? daw.bars : bars, scoreDirty: true });
  dawMsg(lost > 0 ? `${lost} hece notasız kaldı (aşağıdaki listede). Söz listesinden sürükleyip yerleştir ya da "Otomatik yerleştir"e bas.` : "");
  renderDaw();
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
  const [op, arg] = NOTE_OPS[name];
  try {
    const result = ScoreModel.editNote(daw.model, pick.voice, { bar: pick.bar, note: pick.k }, op, { ...arg, step: Number($("daw-step").value) || 1 });
    dawScore(result.model, { voice: pick.voice, bar: result.sel.bar, k: result.sel.note }, null);
    const note = dawPicked();
    if (note && !note.rest && (op === "pitch" || op === "note")) playPitch(note.midi);
  } catch (error) {
    dawMsg(error.message);
  }
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
    if (!moved) { lanes.append(box); moved = true; Object.assign(daw, { tray: null, note: null, bars: null }); }
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
    if (daw.sel.size || daw.tray != null || daw.note || daw.bars) {
      Object.assign(daw, { tray: null, note: null, bars: null });
      daw.sel.clear();
      renderDaw();
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// Painting a track's bars: a drag adds (or, started on a painted bar, removes) the bars it crosses;
// a click adds or removes the whole section under it.
function paintTrack(event, k) {
  const track = daw.tracks[k];
  const count = daw.tl.bars.length;
  const first = barAt(timeAt(event.clientX));
  const on = barSet(track.bars, count);
  const erase = on.has(first);
  const before = dawSnapshot();
  let moved = false;
  const apply = (a, b) => {
    const next = new Set(on);
    for (let i = a; i <= b; i++) if (erase) next.delete(i); else next.add(i);
    track.bars = next.size === count ? null : toRanges(next);
    daw.tracksDirty = true;
    renderDaw();
  };
  const move = (e) => {
    const b = barAt(timeAt(e.clientX));
    if (b === first && !moved) return;
    moved = true;
    apply(Math.min(first, b), Math.max(first, b));
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!moved) {
      const run = daw.tl.sections.find((s) => s.from <= first && first <= s.to) || { from: first, to: first };
      apply(run.from, run.to);
    }
    daw.history.push(before);
    renderDawBar();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

$("daw-scroll").addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (target.closest(".daw-track-add")) { addTrack(); return; }
  const trackLabel = target.closest(".daw-track-label");
  if (trackLabel) { openTrackEditor(Number(trackLabel.closest(".daw-track").dataset.track), trackLabel); return; }
  if (target.closest(".daw-label")) return;
  if (target.closest(".daw-ruler")) { dawSeek(timeAt(event.clientX)); return; }
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
      const run = daw.tl.sections.find((s) => s.from === daw.bars[0]);
      if (run && run.label && [...$("daw-label-name").options].some((o) => o.value === run.label)) $("daw-label-name").value = run.label;
      renderDaw();
    };
    daw.note = null;
    daw.sel.clear();
    daw.tray = null;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return;
  }

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
    daw.sel = new Set(daw.sylls.filter((s) => s.section === k).map((s) => s.index));
    daw.anchor = [...daw.sel][0] ?? null;
    renderDaw();
    return;
  }
  const noteBox = target.closest(".daw-note, .daw-ins, .daw-rest");
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
    if (item) pickDawNote(item);
    return;
  }
  marquee(event);
});

$("daw-scroll").addEventListener("dblclick", (event) => {
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
  if (head) unit = daw.sylls.filter((s) => s.section === Number(head.dataset.section)).map((s) => s.index);
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
  if (event.key === "Escape" && (daw.sel.size || daw.tray != null || daw.note || daw.bars || daw.trackOpen != null)) {
    event.preventDefault();
    closeTrackEditor();
    Object.assign(daw, { tray: null, note: null, bars: null });
    daw.sel.clear();
    renderDaw();
    return;
  }
  if (daw.note) {
    const name = {
      ArrowUp: event.shiftKey ? "octave-up" : "up", ArrowDown: event.shiftKey ? "octave-down" : "down",
      ArrowLeft: "prev", ArrowRight: "next", "+": "longer", "=": "longer", "-": "shorter",
      Delete: "rest", Backspace: "rest", n: "note", N: "note",
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
$("daw-zoom-in").addEventListener("click", () => { daw.pps = Math.min(400, daw.pps * 1.4); renderDaw(); });
$("daw-zoom-out").addEventListener("click", () => { daw.pps = Math.max(12, daw.pps / 1.4); renderDaw(); });
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
  closeTrackEditor();
  renderDaw();
  if (lyricsChanged) renderDawWords();
});
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
  const same = LyricsLayout.allSyllables(text).length === daw.map.length;
  // The same number of syllables keeps every syllable on its note; otherwise they are laid out again.
  dawChange({ map: same ? daw.map : Align.autoAlign(daw.tl, text), lyrics: text });
  dawMsg(same ? "Söz güncellendi; heceler yerlerinde kaldı." : "Söz güncellendi; hece sayısı değiştiği için heceler melodiye yeniden yerleştirildi.");
});
$("daw-side-toggle").addEventListener("click", () => {
  $("daw").classList.toggle("no-side");
  renderDaw();
});

// ---- tracks

function addTrack() {
  daw.history.push(dawSnapshot());
  daw.tracks.push({ id: dawId(), instrument: "strings", feel: [], text: "", bars: null, lead: false });
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
  $("dt-phrase").textContent = Arrange.trackPhrase(track, ScoreModel.sections(daw.model), daw.tl.bars.length) || "—";
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
    const compiled = Arrange.compile({ abc: daw.abc, lyrics: daw.lyrics, map: daw.map, tracks: daw.tracks, style: dawBaseStyle() });
    showYuePreview(compiled, daw.item ? daw.item.name : daw.job.title, daw.lyrics !== (daw.item && daw.item.lyrics) || dawDirty());
  } catch (error) { dawMsg(`Önizleme hazırlanamadı: ${error.message}`); }
});

// ---- saving

$("daw-save").addEventListener("click", async () => {
  const notes = [];
  $("daw-save").disabled = true;
  try {
    if (daw.scoreDirty && daw.item) {
      updateSource(await api(`/sources/${daw.item.id}/score`, { method: "PUT", body: JSON.stringify({ abc: daw.abc }) }));
      daw.item = sources.find((s) => s.id === daw.item.id);
      daw.origin = "bestenin düzeltilmiş notası";
      daw.scoreDirty = false;
      if (daw.ctx === "job") { score.abc = daw.abc; daw.layoutDirty = true; }   // the paper view shows the corrected score from now on
      notes.push(`Nota "${daw.item.name}" bestesine kaydedildi.`);
    }
    if (daw.ctx === "source") {
      if (daw.layoutDirty || daw.layoutFresh || daw.tracksDirty) {
        const item = daw.item;
        const body = {};
        if (daw.layoutDirty || daw.layoutFresh) body.lyrics_layout = { at: Timeline.onsets(daw.tl, daw.map) };
        if (daw.lyrics !== (item.lyrics || "")) body.lyrics = daw.lyrics;
        if (daw.tracksDirty) body.tracks = daw.tracks.map(({ id, instrument, feel, text, bars, lead }) => ({ id, instrument, feel: feel || [], text: text || "", bars: bars ?? null, lead: !!lead }));
        const updated = await api(`/sources/${item.id}`, { method: "PATCH", body: JSON.stringify(body) });
        updateSource(updated);
        daw.item = sources.find((s) => s.id === item.id);
        if (body.lyrics != null && source && source.id === item.id) $("lyrics").value = daw.lyrics;
        daw.layoutDirty = daw.tracksDirty = daw.layoutFresh = false;
        const what = [body.lyrics_layout && "hece yerleşimi", body.lyrics != null && "söz", body.tracks && "izler"].filter(Boolean);
        notes.push(`${what.join(", ").replace(/^./, (c) => c.toUpperCase())} besteye kaydedildi; bu besteden yapılacak düzenlemeler bunlarla hazırlanır.`);
      }
    } else if (daw.layoutDirty) {
      const job = daw.job;
      const changed = daw.lyrics !== (job.lyrics || "");
      const at = Timeline.onsets(daw.tl, daw.map);
      const layout = changed ? { at, lyrics: daw.lyrics } : { at };
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

$("daw-reset").addEventListener("click", async () => {
  const item = daw.item;
  if (!item) return;
  const back = item.transcript_url ? "SheetSage2'nin çıkardığı notaya dönülür" : "yeni düzenlemeler melodiyi yine kayıttan çıkarır";
  if (!confirm(`"${item.name}" bestesinin düzeltilmiş notası silinsin mi? ${back}.${dawDirty() ? "\n\nKaydedilmemiş değişiklikler de silinir." : ""}`)) return;
  try {
    updateSource(await api(`/sources/${item.id}/score`, { method: "DELETE" }));
    daw.item = sources.find((s) => s.id === item.id);
    let abc;
    if (daw.item.transcript_url) abc = await fetchText(daw.item.transcript_url, "çıkarılan nota");
    else if (daw.ctx === "job") { abc = score.jobAbc; score.abc = score.jobAbc; }
    else {
      // No extracted score to go back to: the source has none until it is extracted again.
      daw.scoreDirty = daw.layoutDirty = daw.tracksDirty = false;
      closeDaw();
      return;
    }
    const model = ScoreModel.parse(abc), tl = Timeline.fromModel(model);
    dawPause();
    if (daw.synth) { daw.synth.stop(); daw.synth = null; }
    const map = carryMap(daw.tl, tl, daw.map);
    Object.assign(daw, { model, abc, tl, map, origin: daw.item.transcript_url ? "SheetSage2'nin çıkardığı nota" : "bu düzenlemenin notası",
      history: [], note: null, bars: null, scoreDirty: false });
    renderDaw();
    dawMsg("Düzeltme silindi; özgün notaya dönüldü.");
  } catch (error) { dawMsg(`Silinemedi: ${error.message}`); }
});

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
