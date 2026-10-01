"use strict";
// The melody score (SheetSage2's native ABC dialect) as a list of bars, so the editor can change
// sections and voices bar by bar and write the score back in the same dialect YuE2 reads.
//
// Native layout: header up to K:, then groups of 1-4 bars. A group starts with "% label" lines
// when a section starts, then "V: Vocal" and "V: Ins", each with optional M:/K: lines (a meter or
// key change starts a group) and one music line. "Z" is a full-bar rest, "Z4" four of them.

const ScoreModel = (() => {
  const VOICES = ["vocal", "ins"];
  const VOICE_NAME = { vocal: "Vocal", ins: "Ins" };

  function splitBars(line, where) {
    if (!/\|$/.test(line) || /[:\[\]]\||\|[:\]]|\|\|/.test(line)) throw new Error(`${where}: desteklenmeyen ölçü çizgisi`);
    const bars = [];
    for (const bar of line.slice(0, -1).split("|")) {
      const rest = bar.match(/^Z(\d*)$/);
      if (rest) { for (let n = Number(rest[1] || 1); n > 0; n--) bars.push("Z"); continue; }
      if (!bar.trim()) throw new Error(`${where}: boş ölçü`);
      bars.push(bar);
    }
    return bars;
  }

  // { header: [lines], bars: [{ vocal, ins, labels: [], meter, key }] }
  function parse(abc) {
    const lines = abc.replace(/\r/g, "").split("\n");
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const k = lines.findIndex((line) => /^K:/.test(line));
    if (k < 0) throw new Error("K: satırı yok");
    const header = lines.slice(0, k + 1);
    const bars = [];
    let labels = [], group = null, voice = null;
    const close = (n) => {
      if (!group) return;
      if (!group.vocal || !group.ins || group.vocal.length !== group.ins.length) throw new Error(`satır ${n}: Vocal ve Ins ölçü sayısı farklı`);
      group.vocal.forEach((vocal, i) => bars.push({
        vocal, ins: group.ins[i], labels: i ? [] : group.labels,
        meter: i ? null : group.meter, key: i ? null : group.key,
      }));
      group = null;
    };
    lines.slice(k + 1).forEach((line, i) => {
      const n = k + 2 + i;
      if (!line.trim()) return;
      const comment = line.match(/^%\s*(.*)$/);
      if (comment) { close(n); if (comment[1].trim()) labels.push(comment[1].trim()); return; }
      const v = line.match(/^V:\s*(\S+)\s*$/);
      if (v) {
        if (v[1] === "Vocal") { close(n); group = { labels, meter: null, key: null }; labels = []; voice = "vocal"; return; }
        if (v[1] === "Ins" && group && !group.ins) { voice = "ins"; return; }
        throw new Error(`satır ${n}: beklenmeyen ses "${v[1]}"`);
      }
      if (!group) throw new Error(`satır ${n}: ses satırından önce nota`);
      const field = line.match(/^([MK]):(.*)$/);
      if (field) {
        const name = field[1] === "M" ? "meter" : "key";
        if (voice === "vocal") group[name] = line;
        else if (group[name] !== line) throw new Error(`satır ${n}: Ins ile Vocal'ın ${field[1]}: değişimi farklı`);
        return;
      }
      if (/^[A-Za-z]:/.test(line)) throw new Error(`satır ${n}: desteklenmeyen alan "${line.slice(0, 2)}"`);
      if (group[voice]) throw new Error(`satır ${n}: bir seste iki nota satırı`);
      group[voice] = splitBars(line.trim(), `satır ${n}`);
    });
    close(lines.length);
    if (!bars.length) throw new Error("notada ölçü yok");
    return { header, bars };
  }

  const isRest = (bar) => bar === "Z";
  const tiedOut = (bar) => /-\s*$/.test(bar);

  // annotate: draw section names over the staff and keep one token per bar (display copy only;
  // ranges then say where each bar's text is). Without it, full-rest runs are compressed (Z4).
  function serialize(model, { annotate = false } = {}) {
    const out = [...model.header];
    const ranges = [];   // { bar, voice, from, to }
    let length = out.reduce((sum, line) => sum + line.length + 1, 0);
    const push = (line) => { out.push(line); length += line.length + 1; };
    const groups = [];
    model.bars.forEach((bar, index) => {
      const last = groups[groups.length - 1];
      if (!last || last.length >= 4 || bar.labels.length || bar.meter || bar.key) groups.push([index]);
      else last.push(index);
    });
    for (const group of groups) {
      const first = model.bars[group[0]];
      for (const label of first.labels) push(`% ${label}`);
      for (const voice of VOICES) {
        push(`V: ${VOICE_NAME[voice]}`);
        if (first.meter) push(first.meter);
        if (first.key) push(first.key);
        let line = "";
        const spans = [];
        for (let g = 0; g < group.length; g++) {
          const index = group[g];
          const bar = model.bars[index];
          if (!annotate && isRest(bar[voice])) {
            let run = 1;
            while (g + run < group.length && isRest(model.bars[group[g + run]][voice])) run++;
            line += (run > 1 ? `Z${run}` : "Z") + "|";
            g += run - 1;
            continue;
          }
          const label = annotate && voice === "vocal" && bar.labels.length ? `"^${bar.labels[bar.labels.length - 1]}"` : "";
          spans.push({ bar: index, from: line.length, text: label + bar[voice] });
          line += label + bar[voice] + "|";
        }
        for (const span of spans) ranges.push({ bar: span.bar, voice, from: length + span.from, to: length + span.from + span.text.length });
        push(line);
      }
    }
    return { text: out.join("\n") + "\n", ranges };
  }

  // Section of every bar: the last label at or before it ("" before the first one).
  function sectionOf(model) {
    let current = "";
    return model.bars.map((bar) => (current = bar.labels.length ? bar.labels[bar.labels.length - 1] : current));
  }

  // [{ label, from, to, sung, pickup }]: runs of bars in one section; sung = has vocal notes.
  // Vocal notes only in the last bar, tied into the next section, are that section's pickup.
  function sections(model) {
    const names = sectionOf(model);
    const hasNotes = (bar) => !isRest(bar.vocal) && /[A-Ga-g]/.test(bar.vocal);
    const runs = [];
    model.bars.forEach((bar, index) => {
      const last = runs[runs.length - 1];
      if (!last || bar.labels.length) runs.push({ label: names[index], from: index, to: index, sung: false, pickup: false });
      runs[runs.length - 1].to = index;
    });
    runs.forEach((run, k) => {
      const notes = model.bars.slice(run.from, run.to + 1).map(hasNotes);
      const end = model.bars[run.to];
      run.pickup = k < runs.length - 1 && notes.lastIndexOf(true) === notes.length - 1 && notes.indexOf(true) === notes.length - 1 && tiedOut(end.vocal);
      run.sung = notes.includes(true) && !run.pickup;
    });
    return runs;
  }

  // Bars from..to as one section; the bar after keeps the section it was in.
  function setSection(model, from, to, label) {
    const before = sectionOf(model);
    const bars = model.bars.map((bar) => ({ ...bar, labels: [...bar.labels] }));
    if (to + 1 < bars.length && !bars[to + 1].labels.length) bars[to + 1].labels = before[to + 1] ? [before[to + 1]] : [];
    for (let i = from + 1; i <= to; i++) bars[i].labels = [];
    bars[from].labels = [label];
    // A label that repeats the section already running adds nothing.
    let current = "";
    for (const bar of bars) {
      if (bar.labels.length === 1 && bar.labels[0] === current) bar.labels = [];
      if (bar.labels.length) current = bar.labels[bar.labels.length - 1];
    }
    return { ...model, bars };
  }

  // A held note must not be cut between two voices. The range first shrinks, so a note tied
  // over its edge stays with the bars it is tied to (a pickup into the verse stays sung); only
  // a range made entirely of tied bars widens instead.
  function tieSafeRange(model, from, to) {
    const bars = model.bars;
    const tied = (i) => i >= 0 && i < bars.length - 1 && VOICES.some((v) => tiedOut(bars[i][v]));
    let a = from, b = to;
    while (a <= b && tied(a - 1)) a++;
    while (b >= a && tied(b)) b--;
    if (a <= b) return [a, b];
    while (tied(from - 1)) from--;
    while (tied(to)) to++;
    return [from, to];
  }

  // Vocal and Ins trade their notes in bars from..to (after widening over ties).
  function swapVoices(model, from, to) {
    [from, to] = tieSafeRange(model, from, to);
    const bars = model.bars.map((bar, i) => (i >= from && i <= to ? { ...bar, vocal: bar.ins, ins: bar.vocal } : bar));
    return { model: { ...model, bars }, from, to };
  }

  return { parse, serialize, sections, sectionOf, setSection, swapVoices, tieSafeRange };
})();

if (typeof module !== "undefined") module.exports = ScoreModel;
