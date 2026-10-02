"use strict";
// The timeline editor: the score drawn left to right like a DAW (bars and sections, the melody as
// a piano roll, the syllables as a track under it) with a playhead that follows the melody synth.
// Syllables can be selected, moved note by note (only the selected ones move) and their letters
// corrected. The layout is saved on the arrangement; changed letters can also go to the source
// song's lyrics, which new arrangements are made from (YuE2 reads the lyrics, never the layout).

const daw = {
  job: null, abc: "", tl: null, lyrics: "", map: [], history: [], sel: new Set(), anchor: null, tray: null,
  pps: 70, pos: 0, playing: false, synth: null, startedAt: 0, raf: 0, dirty: false, focus: null, els: null,
};
const DAW_LEFT = 84;      // the track names column

const dawCount = () => daw.tl.vocal.length;
const dawX = (t) => DAW_LEFT + t * daw.pps;
const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const dawSectionColor = (k) => `hsl(${(k * 67 + 200) % 360} 55% 42%)`;
const dawWords = () => LyricsLayout.layOut(daw.abc, daw.lyrics, LyricsLayout.normalize({ map: daw.map, lyrics: daw.lyrics }));

async function openDaw() {
  const job = score.job;
  try {
    daw.tl = Timeline.build(score.abc);
  } catch (error) {
    $("score-status").textContent = `Zaman çizgisi açılamadı: ${error.message}`;
    return;
  }
  stopScore();
  daw.job = job;
  daw.abc = score.abc;
  daw.lyrics = score.layout.lyrics ?? job.lyrics ?? "";
  const words = LyricsLayout.layOut(daw.abc, daw.lyrics, score.layout);
  daw.map = LyricsLayout.toMap(words, words.total);
  Object.assign(daw, { history: [], sel: new Set(), anchor: null, tray: null, pos: 0, dirty: false, focus: null });
  // Zoom so a typical note is wide enough for its syllable.
  const lengths = daw.tl.vocal.map((n) => n.t1 - n.t0).sort((a, b) => a - b);
  daw.pps = lengths.length ? Math.max(40, Math.min(400, 34 / lengths[Math.floor(lengths.length / 2)])) : 70;
  $("daw-title").textContent = job.title;
  $("daw-msg").textContent = "";
  $("daw").showModal();
  renderDaw();
  $("daw-scroll").scrollLeft = 0;
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
  const words = dawWords();
  daw.words = words;
  const sylls = LyricsLayout.allSyllables(daw.lyrics);
  daw.sylls = sylls;
  const width = dawX(tl.duration) + 40;
  const lanes = el("div", "daw-lanes", { width: width + "px" });
  daw.els = { notes: new Map(), sylls: new Map() };

  // Ruler: bar numbers and seconds.
  const ruler = lane("", 26, "daw-ruler");
  const step = [1, 2, 5, 10, 15, 30].find((s) => s * daw.pps >= 60) || 60;
  for (let t = 0; t <= tl.duration; t += step) ruler.append(el("div", "daw-tick", { left: dawX(t) + "px" }, fmtTime(t).replace(/\.\d$/, "")));
  const barEvery = Math.max(1, Math.ceil(28 / ((tl.bars[0] ? tl.bars[0].t1 - tl.bars[0].t0 : 1) * daw.pps)));
  tl.bars.forEach((bar, b) => {
    if (b % barEvery === 0) ruler.append(el("div", "daw-barno", { left: dawX(bar.t0) + "px" }, String(b + 1)));
  });
  ruler.dataset.seek = "1";

  // Score sections (from the score: what YuE2 is told is intro, verse, …).
  const sections = lane("Bölüm", 22);
  for (const section of tl.sections) {
    const block = el("div", "daw-section" + (section.sung ? " sung" : ""), {
      left: dawX(section.t0) + "px", width: (section.t1 - section.t0) * daw.pps - 2 + "px",
    }, `${section.label || "adsız"} ${section.sung ? "🎤" : "🎹"}`);
    block.title = `Notadaki bölüm: ${section.label || "adsız"}, ölçü ${section.from + 1}–${section.to + 1} (${section.sung ? "söylenen" : "yalnız enstrüman"})`;
    sections.append(block);
  }

  // Piano roll: vocal notes over faded instrument notes.
  const pitches = [...tl.vocal, ...tl.ins].map((n) => n.midi);
  const top = Math.max(...pitches, 72) + 2, low = Math.min(...pitches, 55) - 2;
  // The roll takes the height the other lanes leave free.
  const free = $("daw-scroll").clientHeight - 26 - 22 - 20 - 34 - 20;
  const DAW_ROW = Math.max(5, Math.min(16, Math.floor(free / (top - low + 1))));
  const rollHeight = (top - low + 1) * DAW_ROW;
  const roll = lane("Melodi", rollHeight, "daw-roll");
  for (let m = low; m <= top; m++) if (m % 12 === 0) roll.append(el("div", "daw-c-line", { top: (top - m) * DAW_ROW + DAW_ROW - 1 + "px" }, `C${m / 12 - 1}`));
  for (const bar of tl.bars) roll.append(el("div", "daw-bar-line", { left: dawX(bar.t0) + "px" }));
  const noteBox = (note) => ({ left: dawX(note.t0) + "px", width: Math.max(3, (note.t1 - note.t0) * daw.pps - 1) + "px", top: (top - note.midi) * DAW_ROW + "px", height: DAW_ROW - 1 + "px" });
  for (const note of tl.ins) roll.append(el("div", "daw-ins", noteBox(note)));
  for (const note of tl.vocal) {
    const slot = words.slots[note.number];
    const box = el("div", "daw-note" + (slot && !slot.hold ? " sung" : slot ? " held" : ""), noteBox(note));
    box.dataset.n = note.number;
    box.title = `${note.name} · ölçü ${note.bar + 1} · ${fmtTime(note.t0)}`;
    if (slot && !slot.hold && words.slots[note.number].index.some((g) => daw.sel.has(g))) box.classList.add("selected");
    roll.append(box);
    daw.els.notes.set(note.number, box);
  }

  // Lyric sections: where each [Verse], [Chorus] … of the lyrics is sung; a click selects it.
  const lyricLane = lane("Söz bölümü", 20);
  words.sections.forEach((section, k) => {
    if (!section.placed) return;
    const t0 = tl.vocal[section.start].t0, t1 = tl.vocal[section.end - 1].t1;
    const block = el("div", "daw-lyric-section", { left: dawX(t0) + "px", width: Math.max(20, (t1 - t0) * daw.pps - 2) + "px", background: dawSectionColor(k) },
      `${section.tag || "söz"}${section.count - section.placed ? ` ⚠ ${section.count - section.placed}` : ""}`);
    block.dataset.section = k;
    block.title = `${section.tag || "söz"}: ${section.count} hece${section.count - section.placed ? `, ${section.count - section.placed} hece notaya düşmüyor` : ""}. Tıkla: bu bölümün bütün hecelerini seç`;
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
    chip.title = `${daw.words.sections[sylls[g].section].tag || "söz"}: notaya düşmüyor. Seç, sonra boş bir notaya tıkla; ya da çift tıklayıp sil.`;
    chip.onclick = () => { daw.tray = daw.tray === g ? null : g; daw.sel.clear(); refreshDawSelection(); };
    chip.ondblclick = () => editDawSyllable(g, chip);
    return chip;
  });
  $("daw-tray").replaceChildren(el("span", "muted small", null, `Notaya düşmeyen ${loose.length} hece:`), ...chips);
}

function renderDawBar() {
  const n = daw.sel.size;
  let info;
  if (daw.tray != null) info = `«${daw.sylls[daw.tray].text}» hecesini koymak için boş bir notaya tıkla.`;
  else if (n) info = `${n} hece seçili · sürükle ya da ←/→ ile kaydır · çift tıkla: harfleri düzelt · Delete: sil`;
  else info = "Bir heceye tıkla (Shift: aralık, ⌘/Ctrl: ekle) · cetvele tıkla: oraya git · boşluk: çal/durdur · Yalnızca seçili heceler kayar.";
  $("daw-info").textContent = info;
  $("daw-undo").disabled = !daw.history.length;
  $("daw-save").disabled = !daw.dirty;
  $("daw-after").disabled = !n;
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

function dawChange(next) {
  daw.history.push({ map: daw.map, lyrics: daw.lyrics });
  daw.map = next.map;
  daw.lyrics = next.lyrics;
  daw.dirty = true;
  $("daw-msg").textContent = "";
  renderDaw();
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

$("daw-scroll").addEventListener("pointerdown", (event) => {
  const target = event.target;
  const scroll = $("daw-scroll");
  const timeAt = (clientX) => (clientX - scroll.getBoundingClientRect().left + scroll.scrollLeft - DAW_LEFT) / daw.pps;
  if (target.closest(".daw-ruler")) { dawSeek(timeAt(event.clientX)); return; }
  const sylBlock = target.closest(".daw-syl");
  if (sylBlock) {
    const g = Number(sylBlock.dataset.g);
    selectDaw(g, event);
    refreshDawSelection();
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
      if (delta) { daw.history.push({ map: base, lyrics: daw.lyrics }); daw.dirty = true; renderDawBar(); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return;
  }
  const lyricBlock = target.closest(".daw-lyric-section");
  if (lyricBlock) {
    const k = Number(lyricBlock.dataset.section);
    daw.tray = null;
    daw.sel = new Set(daw.sylls.filter((s) => s.section === k && daw.map[s.index] != null).map((s) => s.index));
    daw.anchor = [...daw.sel][0] ?? null;
    refreshDawSelection();
    return;
  }
  const noteBox = target.closest(".daw-note");
  if (noteBox) {
    const n = Number(noteBox.dataset.n);
    if (daw.tray != null) {
      const out = LyricsLayout.placeSyllable(daw.map, daw.tray, n, dawCount());
      if (typeof out === "string") { $("daw-msg").textContent = out; return; }
      daw.tray = null;
      dawChange({ map: out, lyrics: daw.lyrics });
      return;
    }
    dawSeek(daw.tl.vocal[n].t0);
    if (!daw.playing) playPitch(daw.tl.vocal[n].midi);
    return;
  }
  if (daw.sel.size || daw.tray != null) { daw.sel.clear(); daw.tray = null; refreshDawSelection(); }
});

$("daw-scroll").addEventListener("dblclick", (event) => {
  const block = event.target.closest(".daw-syl");
  if (block) editDawSyllable(Number(block.dataset.g), block);
});

$("daw").addEventListener("keydown", (event) => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
  const mod = event.metaKey || event.ctrlKey;
  if (event.key === " ") { event.preventDefault(); dawPlay(); }
  else if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); moveDawSelection(event.key === "ArrowRight" ? 1 : -1); }
  else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deleteDawSelection(); }
  else if (event.key === "Enter" && daw.sel.size === 1) { event.preventDefault(); const g = [...daw.sel][0]; editDawSyllable(g, daw.els.sylls.get(g)); }
  else if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); $("daw-undo").click(); }
  else if (event.key === "Escape" && (daw.sel.size || daw.tray != null)) { event.preventDefault(); daw.sel.clear(); daw.tray = null; refreshDawSelection(); }
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
  daw.map = last.map;
  daw.lyrics = last.lyrics;
  daw.dirty = daw.history.length > 0;
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
  const changed = daw.lyrics !== (job.lyrics || "");
  const layout = changed ? { map: daw.map, lyrics: daw.lyrics } : { map: daw.map };
  $("daw-save").disabled = true;
  try {
    const updated = await api(`/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ lyrics_layout: layout, lyrics_start: null }) });
    jobs = jobs.map((j) => (j.id === updated.id ? updated : j));
    job.lyrics_layout = layout;
    job.lyrics_start = null;
    score.layout = LyricsLayout.normalize(layout);
    daw.dirty = false;
    let note = "Yerleşim bu düzenlemeye kaydedildi.";
    const item = scoreSource();
    if (changed && item && daw.lyrics !== (item.lyrics || "")) {
      const other = item.lyrics && item.lyrics !== job.lyrics ? "\n\nDikkat: bestenin kayıtlı sözü bu düzenlemeninkinden farklı; düzeltilmiş sözle değiştirilir." : "";
      if (confirm(`Sözdeki harfleri değiştirdin. "${item.name}" bestesinin sözü de bu sözle güncellensin mi? Bu besteden yapılacak yeni düzenlemeler düzeltilmiş sözle üretilir (YuE2 sözü okur).${other}`)) {
        await saveSourceText(item, item.style || "", daw.lyrics);
        renderSources();
        note += " Bestenin sözü de güncellendi.";
      }
    }
    $("daw-msg").textContent = note;
  } catch (error) {
    $("daw-msg").textContent = `Kaydedilemedi: ${error.message}`;
  }
  renderDawBar();
});

function closeDaw() {
  if (daw.dirty && !confirm("Kaydedilmemiş hece değişiklikleri silinsin mi?")) return;
  dawPause();
  if (daw.synth) { daw.synth.stop(); daw.synth = null; }
  $("daw").close();
  layLyrics();
  drawScore();
}
$("daw-close").addEventListener("click", closeDaw);
$("daw").addEventListener("cancel", (event) => { event.preventDefault(); closeDaw(); });

$("score-daw").addEventListener("click", openDaw);
window.addEventListener("resize", () => { if ($("daw").open) renderDaw(); });
