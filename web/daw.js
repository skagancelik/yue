"use strict";
// The timeline editor: the score drawn left to right like a DAW (bars and sections, the melody as
// a piano roll, the syllables as a track under it) with a playhead that follows the melody synth.
//
// Two things are edited here and saved to different places:
// - the score (pitches, lengths, section names, which bars are sung or played): saved on the
//   source song; new arrangements made from it send this score to YuE2 instead of transcribing
//   the recording again (ScoreModel in score-model.js does the edits);
// - the syllables (which note each one sits on, their letters): saved on the arrangement, by the
//   unit their note starts on so they find their notes again after the score changes. Changed
//   letters can also go to the source song's lyrics. YuE2 reads the lyrics, never the layout.

const daw = {
  job: null, item: null, origin: "", model: null, abc: "", tl: null, lyrics: "", map: [], words: null, sylls: [],
  history: [], sel: new Set(), anchor: null, tray: null, note: null, bars: null,
  pps: 70, pos: 0, playing: false, synth: null, startedAt: 0, raf: 0, focus: null, els: null,
  scoreDirty: false, layoutDirty: false,
};
const DAW_LEFT = 84;      // the track names column

const dawCount = () => daw.tl.vocal.length;
const dawX = (t) => DAW_LEFT + t * daw.pps;
const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const dawSectionColor = (k) => `hsl(${(k * 67 + 200) % 360} 55% 42%)`;
const dawDirty = () => daw.scoreDirty || daw.layoutDirty;

// The note of every syllable on a score, from an arrangement's saved layout (null = on no note).
function layoutMap(abc, lyrics, layout) {
  const total = LyricsLayout.allSyllables(lyrics).length;
  if (layout.at && layout.at.length === total) {
    try { return Timeline.mapFromOnsets(Timeline.build(abc), layout.at); } catch (error) { /* laid out below */ }
  }
  const words = LyricsLayout.layOut(abc, lyrics, layout);
  return LyricsLayout.toMap(words, total);
}

async function openDaw() {
  const job = score.job;
  const item = scoreSource();
  let abc = score.abc, origin = "bu düzenlemenin notası";
  try {
    if (item && item.score_edited && item.score_url) {
      const response = await fetch(item.score_url);
      if (!response.ok) throw new Error(`bestenin notası alınamadı (${response.status})`);
      abc = await response.text();
      origin = "bestenin düzeltilmiş notası";
    }
    daw.model = ScoreModel.parse(abc);
    daw.tl = Timeline.fromModel(daw.model);
  } catch (error) {
    $("score-status").textContent = `Zaman çizgisi açılamadı: ${error.message}`;
    return;
  }
  stopScore();
  Object.assign(daw, { job, item, origin, abc, history: [], sel: new Set(), anchor: null, tray: null, note: null, bars: null,
    pos: 0, focus: null, scoreDirty: false, layoutDirty: false });
  daw.lyrics = score.layout.lyrics ?? job.lyrics ?? "";
  // The layout belongs to this arrangement's score; on the source's corrected score the syllables
  // go to the notes starting at the same moments.
  const jobMap = layoutMap(score.abc, daw.lyrics, score.layout);
  daw.map = abc === score.abc ? jobMap : carryMap(Timeline.build(score.abc), daw.tl, jobMap);
  // Zoom so a typical note is wide enough for its syllable.
  const lengths = daw.tl.vocal.map((n) => n.t1 - n.t0).sort((a, b) => a - b);
  daw.pps = lengths.length ? Math.max(40, Math.min(400, 34 / lengths[Math.floor(lengths.length / 2)])) : 70;
  const unit = ScoreModel.unitDenominator(daw.model);
  // Lengthen/shorten steps a musician thinks in, as L: units (only the ones the grid can hold).
  $("daw-step").replaceChildren(...[[16, "1/16"], [8, "1/8"], [4, "1/4"]]
    .filter(([den]) => unit % den === 0).map(([den, name]) => new Option(`adım ${name}`, String(unit / den))));
  $("daw-title").textContent = job.title;
  $("daw-msg").textContent = "";
  $("daw").showModal();
  renderDaw();
  $("daw-scroll").scrollLeft = 0;
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

function renderDaw() {
  const { tl } = daw;
  const words = LyricsLayout.layOut(daw.abc, daw.lyrics, LyricsLayout.normalize({ map: daw.map }));
  daw.words = words;
  const sylls = LyricsLayout.allSyllables(daw.lyrics);
  daw.sylls = sylls;
  const width = dawX(tl.duration) + 40;
  const lanes = el("div", "daw-lanes", { width: width + "px" });
  daw.els = { notes: new Map(), sylls: new Map() };

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
  const free = $("daw-scroll").clientHeight - 26 - 24 - 20 - 34 - 20;
  const row = Math.max(5, Math.min(16, Math.floor((free - 10) / (top - low + 1))));
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
  for (const note of tl.vocal) {
    const slot = words.slots[note.number];
    const box = tag(el("div", "daw-note" + (slot && !slot.hold ? " sung" : slot ? " held" : "") + (picked(note) ? " picked" : ""),
      { ...span(note), top: (top - note.midi) * row + "px", height: row - 1 + "px" }), note);
    box.dataset.n = note.number;
    box.title = `${note.name} · ölçü ${note.bar + 1} · ${fmtTime(note.t0)}`;
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
  const lyricLane = lane("Söz bölümü", 20);
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
      const block = el("div", "daw-syl" + (daw.sel.has(g) ? " selected" : ""), {
        left: dawX(note.t0) + i * part + "px", width: Math.max(14, part - 2) + "px", borderColor: dawSectionColor(sylls[g].section),
      }, sylls[g].text);
      block.dataset.g = g;
      block.title = `${sylls[g].text} · ${words.sections[sylls[g].section].tag || "söz"} · ölçü ${note.bar + 1}`;
      syl.append(block);
      daw.els.sylls.set(g, block);
    });
  });

  lanes.append(ruler, sections, roll, lyricLane, syl);
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
}

// Syllables on no note: the lyrics have more syllables than the melody there.
function renderDawTray() {
  const sylls = daw.sylls;
  const loose = daw.map.map((n, g) => (n == null ? g : -1)).filter((g) => g >= 0);
  $("daw-tray").classList.toggle("hidden", !loose.length);
  if (!loose.length) return;
  const chips = loose.map((g) => {
    const chip = el("button", "daw-loose" + (daw.tray === g ? " on" : ""), null, sylls[g].text);
    chip.type = "button";
    chip.title = `${daw.words.sections[sylls[g].section].tag || "söz"}: notaya düşmüyor. Seç, sonra boş bir vokal notasına tıkla; ya da çift tıklayıp sil.`;
    chip.onclick = () => { daw.tray = daw.tray === g ? null : g; daw.sel.clear(); daw.note = null; refreshDawSelection(); };
    chip.ondblclick = () => editDawSyllable(g, chip);
    return chip;
  });
  $("daw-tray").replaceChildren(el("span", "muted small", null, `Notaya düşmeyen ${loose.length} hece:`), ...chips);
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

// YuE2 matches lyric sections to the score's sung sections by name and order; show where they differ.
function compareText() {
  const scoreNames = daw.tl.sections.filter((s) => s.sung).map((s) => LyricsLayout.sectionName(s.label));
  const lyricNames = LyricsLayout.lyricSections(daw.lyrics).map((s) => s.name);
  if (!lyricNames.length) return { text: "", warn: false };
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
  if (daw.tray != null) info = `«${daw.sylls[daw.tray].text}» hecesini koymak için boş bir vokal notasına tıkla.`;
  else if (note) info = "↑/↓ yarım ses (Shift: oktav) · +/− uzat/kısalt · ←/→ önceki/sonraki · Delete: sus · N: notaya çevir";
  else if (daw.bars) info = "Seçili ölçülere bölüm adı ver ya da söylenen ve çalınan notaları değiştir.";
  else if (n) info = `${n} hece seçili · sürükle ya da ←/→ ile kaydır · çift tıkla: harfleri düzelt · Delete: sil`;
  else info = "Notaya tıkla: perde/süre · Bölüm şeridinde tıkla ya da sürükle: ölçü seç · Heceye tıkla: kaydır, düzelt · Cetvel: oraya git · Boşluk: çal/durdur";
  $("daw-info").textContent = info;
  $("daw-undo").disabled = !daw.history.length;
  $("daw-save").disabled = !dawDirty();
  $("daw-after").disabled = !n;
  $("daw-reset").classList.toggle("hidden", !(daw.item && daw.item.score_edited));
  $("daw-origin").textContent = `Nota: ${daw.origin}${daw.scoreDirty ? " (değişti)" : ""}`;
  $("daw-play").textContent = daw.playing ? "⏸" : "▶";
  $("daw-time").textContent = `${fmtTime(daw.pos)} / ${fmtTime(daw.tl.duration)}`;
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
    $("daw-msg").textContent = `Çalınamadı: ${error.message || error}`;
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
  const { model, abc, tl, map, lyrics, note, bars, scoreDirty, layoutDirty } = daw;
  return { model, abc, tl, map, lyrics, note, bars, scoreDirty, layoutDirty };
}

// A new syllable layout or lyrics.
function dawChange(next) {
  daw.history.push(dawSnapshot());
  daw.map = next.map;
  daw.lyrics = next.lyrics;
  daw.layoutDirty = true;
  $("daw-msg").textContent = "";
  renderDaw();
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
  $("daw-msg").textContent = lost > 0
    ? `${lost} hece notasız kaldı (aşağıdaki listede). Tek tek yerleştir ya da bölümler değiştiyse "Otomatik yerleştir"e bas.`
    : "";
  renderDaw();
}

const scoreLocked = () => {
  if (daw.item) return false;
  $("daw-msg").textContent = "Bu düzenlemenin bir bestesi yok; nota yalnızca bir besteye kaydedilebilir.";
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
    $("daw-msg").textContent = error.message;
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
  $("daw-msg").textContent = "";
  dawSeek(item.t0);
  renderDaw();
  const scroll = $("daw-scroll"), x = dawX(item.t0);
  if (x < scroll.scrollLeft + DAW_LEFT || x > scroll.scrollLeft + scroll.clientWidth - 60) scroll.scrollLeft = x - DAW_LEFT - 80;
  const note = dawPicked();
  if (note && !note.rest && !daw.playing) playPitch(note.midi);
}

function moveDawSelection(delta) {
  if (!daw.sel.size) return;
  const out = LyricsLayout.moveSyllables(daw.map, daw.sel, delta, dawCount());
  if (typeof out === "string") { $("daw-msg").textContent = out; return; }
  dawChange({ map: out, lyrics: daw.lyrics });
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
    if (text && ![...text].some((ch) => /\p{L}/u.test(ch))) { $("daw-msg").textContent = "Hecede en az bir harf olmalı (silmek için boş bırak)."; return; }
    daw.sel.clear();
    if (daw.tray === g) daw.tray = null;
    dawChange(LyricsLayout.editSyllable(daw.lyrics, daw.map, g, text, dawCount()));
    $("daw-msg").textContent = text ? "Harfler düzeltildi. Hece sayısı değiştiyse yeni heceler sonraki boş notalara kondu." : "Hece silindi.";
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
  $("daw-msg").textContent = "Seçili heceler sözden silindi (geri alınabilir).";
}

function selectDaw(g, event) {
  daw.tray = null;
  daw.note = null;
  daw.bars = null;
  if (event.shiftKey && daw.anchor != null) {
    const [a, b] = [Math.min(daw.anchor, g), Math.max(daw.anchor, g)];
    daw.sel = new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k).filter((x) => daw.map[x] != null));
  } else if (event.metaKey || event.ctrlKey) {
    if (daw.sel.has(g)) daw.sel.delete(g); else daw.sel.add(g);
    daw.anchor = g;
  } else {
    if (!daw.sel.has(g)) daw.sel = new Set([g]);
    daw.anchor = g;
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

$("daw-scroll").addEventListener("pointerdown", (event) => {
  const target = event.target;
  const scroll = $("daw-scroll");
  const timeAt = (clientX) => (clientX - scroll.getBoundingClientRect().left + scroll.scrollLeft - DAW_LEFT) / daw.pps;
  if (target.closest(".daw-label")) return;
  if (target.closest(".daw-ruler")) { dawSeek(timeAt(event.clientX)); return; }

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
    // Drag: the grabbed syllable snaps to the note nearest the pointer; the others keep their distance.
    const base = daw.map, from = base[g], startX = event.clientX;
    let delta = 0;
    const move = (e) => {
      const t = (daw.tl.vocal[from].t0 + daw.tl.vocal[from].t1) / 2 + (e.clientX - startX) / daw.pps;
      const d = nearestNote(t) - from;
      if (d === delta) return;
      const out = LyricsLayout.moveSyllables(base, daw.sel, d, dawCount());
      if (typeof out === "string") { $("daw-msg").textContent = out; return; }
      delta = d;
      daw.map = out;
      $("daw-msg").textContent = "";
      renderDaw();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (delta) { daw.history.push({ ...dawSnapshot(), map: base }); daw.layoutDirty = true; renderDawBar(); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return;
  }
  const lyricBlock = target.closest(".daw-lyric-section");
  if (lyricBlock) {
    const k = Number(lyricBlock.dataset.section);
    Object.assign(daw, { tray: null, note: null, bars: null });
    daw.sel = new Set(daw.sylls.filter((s) => s.section === k && daw.map[s.index] != null).map((s) => s.index));
    daw.anchor = [...daw.sel][0] ?? null;
    renderDaw();
    return;
  }
  const noteBox = target.closest(".daw-note, .daw-ins, .daw-rest");
  if (noteBox) {
    if (daw.tray != null && noteBox.dataset.n != null) {
      const out = LyricsLayout.placeSyllable(daw.map, daw.tray, Number(noteBox.dataset.n), dawCount());
      if (typeof out === "string") { $("daw-msg").textContent = out; return; }
      daw.tray = null;
      dawChange({ map: out, lyrics: daw.lyrics });
      return;
    }
    const { voice } = noteBox.dataset, bar = Number(noteBox.dataset.bar), k = Number(noteBox.dataset.k);
    const item = [...daw.tl[voice], ...daw.tl.rests[voice]].find((x) => x.bar === bar && x.k === k);
    if (item) pickDawNote(item);
    return;
  }
  if (daw.sel.size || daw.tray != null || daw.note || daw.bars) {
    Object.assign(daw, { tray: null, note: null, bars: null });
    daw.sel.clear();
    renderDaw();
  }
});

$("daw-scroll").addEventListener("dblclick", (event) => {
  const block = event.target.closest(".daw-syl");
  if (block) editDawSyllable(Number(block.dataset.g), block);
});

$("daw").addEventListener("keydown", (event) => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
  const mod = event.metaKey || event.ctrlKey;
  if (event.key === " ") { event.preventDefault(); dawPlay(); return; }
  if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); $("daw-undo").click(); return; }
  if (event.key === "Escape" && (daw.sel.size || daw.tray != null || daw.note || daw.bars)) {
    event.preventDefault();
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
  else if (event.key === "Enter" && daw.sel.size === 1) { event.preventDefault(); const g = [...daw.sel][0]; editDawSyllable(g, daw.els.sylls.get(g)); }
});

for (const button of document.querySelectorAll("#daw-note-tools [data-note]")) {
  button.addEventListener("click", () => dawNoteAction(button.dataset.note));
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
    $("daw-msg").textContent = `Bağlı (uzatılan) bir nota bölünmesin diye seçim ölçü ${from + 1}–${to + 1} olarak ayarlandı; bağlı nota devamıyla aynı seste kaldı. ${$("daw-msg").textContent}`;
  }
});

$("daw-play").addEventListener("click", dawPlay);
$("daw-zoom-in").addEventListener("click", () => { daw.pps = Math.min(400, daw.pps * 1.4); renderDaw(); });
$("daw-zoom-out").addEventListener("click", () => { daw.pps = Math.max(12, daw.pps / 1.4); renderDaw(); });
$("daw-after").addEventListener("click", () => {
  const first = Math.min(...daw.sel);
  daw.sel = new Set(daw.map.map((n, g) => (g >= first && n != null ? g : -1)).filter((g) => g >= 0));
  refreshDawSelection();
});
$("daw-undo").addEventListener("click", () => {
  const last = daw.history.pop();
  if (!last) return;
  if (last.abc !== daw.abc) { dawPause(); if (daw.synth) { daw.synth.stop(); daw.synth = null; } }
  Object.assign(daw, last);
  daw.sel.clear();
  renderDaw();
});
$("daw-auto").addEventListener("click", () => {
  if (!confirm("Heceler yeniden kendiliğinden yerleşsin mi? (Harf düzeltmeleri kalır.)")) return;
  const words = LyricsLayout.layOut(daw.abc, daw.lyrics);
  daw.sel.clear();
  dawChange({ map: LyricsLayout.toMap(words, words.total), lyrics: daw.lyrics });
});

$("daw-save").addEventListener("click", async () => {
  const job = daw.job;
  const notes = [];
  $("daw-save").disabled = true;
  try {
    if (daw.scoreDirty && daw.item) {
      updateSource(await api(`/sources/${daw.item.id}/score`, { method: "PUT", body: JSON.stringify({ abc: daw.abc }) }));
      daw.item = scoreSource();
      daw.origin = "bestenin düzeltilmiş notası";
      daw.scoreDirty = false;
      score.abc = daw.abc;   // the paper view shows the corrected score from now on
      daw.layoutDirty = true;   // the syllables are saved by time, so they stay on their notes
      notes.push(`Nota "${daw.item.name}" bestesine kaydedildi; bu besteden yapılacak yeni düzenlemeler bu notayla üretilecek.`);
    }
    if (daw.layoutDirty) {
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
    $("daw-msg").textContent = notes.join(" ");
  } catch (error) {
    $("daw-msg").textContent = `Kaydedilemedi: ${error.message}`;
  }
  renderDawBar();
});

$("daw-reset").addEventListener("click", async () => {
  const item = daw.item;
  if (!item || !confirm(`"${item.name}" bestesinin düzeltilmiş notası silinsin mi? Yeni düzenlemeler melodiyi yine kayıttan çıkarır.${dawDirty() ? "\n\nKaydedilmemiş değişiklikler de silinir." : ""}`)) return;
  try {
    updateSource(await api(`/sources/${item.id}/score`, { method: "DELETE" }));
    daw.item = scoreSource();
    // Back to the score this arrangement was made from; the syllables follow by time.
    score.abc = score.jobAbc;
    const model = ScoreModel.parse(score.abc), tl = Timeline.fromModel(model);
    dawPause();
    if (daw.synth) { daw.synth.stop(); daw.synth = null; }
    const map = carryMap(daw.tl, tl, daw.map);
    Object.assign(daw, { model, abc: score.abc, tl, map, origin: "bu düzenlemenin notası", history: [], note: null, bars: null, scoreDirty: false });
    renderDaw();
    $("daw-msg").textContent = "Düzeltme silindi; yeni düzenlemeler melodiyi kayıttan çıkaracak.";
  } catch (error) { $("daw-msg").textContent = `Silinemedi: ${error.message}`; }
});

function closeDaw() {
  if (dawDirty() && !confirm("Kaydedilmemiş değişiklikler silinsin mi?")) return;
  dawPause();
  if (daw.synth) { daw.synth.stop(); daw.synth = null; }
  $("daw").close();
  layLyrics();
  drawScore();
  setScoreButtons(true);
}
$("daw-close").addEventListener("click", closeDaw);
$("daw").addEventListener("cancel", (event) => { event.preventDefault(); closeDaw(); });
$("score-daw").addEventListener("click", openDaw);
window.addEventListener("resize", () => { if ($("daw").open) renderDaw(); });
