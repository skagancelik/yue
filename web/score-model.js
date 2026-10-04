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
          spans.push({ bar: index, from: line.length, label: label.length, text: label + bar[voice] });
          line += label + bar[voice] + "|";
        }
        // start: where the bar's own notes begin (after a section annotation).
        for (const span of spans) {
          ranges.push({ bar: span.bar, voice, from: length + span.from, start: length + span.from + span.label, to: length + span.from + span.text.length });
        }
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

  // ---- notes inside bars
  // Pitch rules of the native dialect: an accidental lasts to the end of the bar and applies to
  // that letter in every octave; an unmarked note continuing a tie over the barline keeps the
  // tied note's pitch. Durations are counted in L: units; only DURATIONS are written as one token,
  // other lengths are tied (notes) or chained (rests) parts, e.g. 10 = 8-2.

  const DURATIONS = [48, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1];
  const LETTERS = "CDEFGAB";
  const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const KEY_SHARPS = {
    C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
    Am: 0, Em: 1, Bm: 2, "F#m": 3, "C#m": 4, "G#m": 5, "D#m": 6, "A#m": 7, Dm: -1, Gm: -2, Cm: -3, Fm: -4, Bbm: -5, Ebm: -6, Abm: -7,
  };
  const ACCIDENTAL = { "^^": 2, "^": 1, "=": 0, "_": -1, "__": -2 };
  const ACCIDENTAL_TEXT = { 2: "^^", 1: "^", 0: "=", "-1": "_", "-2": "__" };

  // { C: 0, F: 1, … }: the alteration the key signature gives each letter.
  function keyAlters(line) {
    const name = (line || "").replace(/^K:\s*/, "").trim().replace(/min$/, "m").replace(/maj$/, "");
    if (!(name in KEY_SHARPS)) throw new Error(`desteklenmeyen ton "${name}"`);
    const count = KEY_SHARPS[name];
    const alters = Object.fromEntries([...LETTERS].map((l) => [l, 0]));
    for (let i = 0; i < Math.abs(count); i++) alters[(count > 0 ? "FCGDAEB" : "BEADGCF")[i]] = Math.sign(count);
    return alters;
  }

  function headerField(model, name) {
    const line = model.header.find((l) => l.startsWith(name + ":"));
    return line ? line.slice(name.length + 1).trim() : "";
  }

  function unitsPerBar(meterText, unitDenominator) {
    const meter = meterText === "C" ? "4/4" : meterText === "C|" ? "2/2" : meterText;
    const [num, den] = meter.split("/").map(Number);
    return (num * unitDenominator) / den;
  }

  // Tokens of one bar's text: { rest, letter, octave, acc (explicit or null), dur, tie, from, to }.
  function tokenize(text, barUnits) {
    if (text === "Z") return [{ rest: true, dur: barUnits, tie: false, from: 0, to: 1 }];
    const tokens = [];
    const re = /(\^\^|__|\^|_|=)?([A-Ga-gz])([,']*)(\d*)(-?)/y;
    let at = 0;
    while (at < text.length) {
      re.lastIndex = at;
      const m = re.exec(text);
      if (!m) throw new Error(`desteklenmeyen işaret: "${text.slice(at, at + 6)}"`);
      const dur = m[4] ? Number(m[4]) : 1;
      if (!dur) throw new Error("sıfır süreli nota");
      if (m[2] === "z") {
        if (m[1] || m[3] || m[5]) throw new Error("susta perde işareti");
        tokens.push({ rest: true, dur, tie: false, from: at, to: re.lastIndex });
      } else {
        const lower = m[2] === m[2].toLowerCase();
        const octave = (lower ? 5 : 4) + [...m[3]].reduce((s, c) => s + (c === "'" ? 1 : -1), 0);
        tokens.push({ rest: false, letter: m[2].toUpperCase(), octave, acc: m[1] ? ACCIDENTAL[m[1]] : null, dur, tie: m[5] === "-", from: at, to: re.lastIndex });
      }
      at = re.lastIndex;
    }
    return tokens;
  }

  const midiOf = (letter, octave, alter) => 12 * (octave + 1) + NATURAL[letter] + alter;

  // Every bar of one voice as logical notes: a note tied to the same pitch inside the bar is one
  // note. { notes: [{ rest, midi, letter, octave, alter, dur, tieOut, contIn, from, to }], key,
  // units, error }. contIn: the first note continues the previous bar's tied note.
  function voiceNotes(model, voice) {
    const unit = Number((headerField(model, "L").split("/")[1]) || 8);
    let meter = headerField(model, "M") || "4/4";
    let keyLine = model.header.find((l) => l.startsWith("K:"));
    let carry = null;   // the tied-out note of the previous bar
    return model.bars.map((bar) => {
      if (bar.meter) meter = bar.meter.slice(2).trim();
      if (bar.key) keyLine = bar.key;
      const units = unitsPerBar(meter, unit);
      let key;
      try { key = keyAlters(keyLine); } catch (error) { carry = null; return { notes: [], units, error: error.message }; }
      try {
        const state = { ...key };
        const notes = [];
        tokenize(bar[voice], units).forEach((token, k) => {
          if (token.rest) {
            // Rests in a row are one silence (a rest of 5 is written z4z).
            const last = notes[notes.length - 1];
            if (last && last.rest) { last.dur += token.dur; last.to = token.to; return; }
            notes.push({ rest: true, dur: token.dur, from: token.from, to: token.to, tieOut: false, contIn: false });
            return;
          }
          const contIn = k === 0 && !!carry;
          let alter;
          if (token.acc !== null) { alter = token.acc; state[token.letter] = alter; }
          else if (contIn) alter = carry.midi - midiOf(token.letter, token.octave, 0);
          else alter = state[token.letter];
          const midi = midiOf(token.letter, token.octave, alter);
          if (contIn && midi !== carry.midi) throw new Error("bağlı nota farklı perdeye bağlanıyor");
          const last = notes[notes.length - 1];
          if (last && !last.rest && last.tieOut && last.midi === midi) {
            last.dur += token.dur; last.tieOut = token.tie; last.to = token.to;
          } else {
            if (last && !last.rest && last.tieOut) throw new Error("bağ farklı perdeye");
            notes.push({ rest: false, midi, letter: token.letter, octave: token.octave, alter, dur: token.dur, tieOut: token.tie, contIn, from: token.from, to: token.to });
          }
        });
        const total = notes.reduce((s, n) => s + n.dur, 0);
        if (total !== units) throw new Error(`ölçü süresi ${total}, olması gereken ${units}`);
        const end = notes[notes.length - 1];
        carry = end && !end.rest && end.tieOut ? end : null;
        return { notes, key, units };
      } catch (error) {
        carry = null;
        return { notes: [], key, units, error: error.message };
      }
    });
  }

  const parts = (dur) => {
    const out = [];
    for (const size of DURATIONS) while (dur >= size) { out.push(size); dur -= size; }
    return out;
  };

  // Spell a pitch in a key: the key's own letter first, then sharps in sharp keys (flats in flat keys).
  function spell(midi, key) {
    const flatKey = Object.values(key).some((a) => a < 0);
    const options = [];
    for (const letter of LETTERS) for (const alter of [0, 1, -1, 2, -2]) {
      const pc = (NATURAL[letter] + alter + 12) % 12;
      if (pc !== ((midi % 12) + 12) % 12) continue;
      const octave = Math.floor((midi - NATURAL[letter] - alter) / 12) - 1;
      const cost = (alter === key[letter] ? 0 : 2) + Math.abs(alter) * 2 + (alter === (flatKey ? -1 : 1) ? -1 : 0);
      options.push({ letter, octave, alter, cost });
    }
    options.sort((a, b) => a.cost - b.cost);
    return options[0];
  }

  // Bar text from logical notes, with accidentals written wherever any reading could differ:
  // the letter-wide state of the native dialect and abcjs's per-octave state both start from the key.
  function writeBar(notes, key, units) {
    if (notes.length === 1 && notes[0].rest && notes[0].dur === units) return "Z";
    const letterState = { ...key };
    const octaveState = {};
    let text = "";
    notes.forEach((note, k) => {
      if (note.rest) { text += parts(note.dur).map((d) => "z" + (d > 1 ? d : "")).join(""); return; }
      const { letter, octave, alter } = note;
      const name = (octave >= 5 ? letter.toLowerCase() : letter) + (octave >= 5 ? "'".repeat(octave - 5) : ",".repeat(4 - octave));
      const slot = letter + octave;
      const seen = slot in octaveState ? octaveState[slot] : key[letter];
      let acc = "";
      if (note.contIn && k === 0) {
        if (alter !== key[letter]) { acc = ACCIDENTAL_TEXT[alter]; octaveState[slot] = alter; }
      } else if (letterState[letter] !== alter || seen !== alter) {
        acc = ACCIDENTAL_TEXT[alter];
        letterState[letter] = alter;
        octaveState[slot] = alter;
      }
      text += parts(note.dur).map((d, i) => (i ? name : acc + name) + (d > 1 ? d : "")).join("-") + (note.tieOut ? "-" : "");
    });
    return text;
  }

  const copyNotes = (notes) => notes.map((n) => ({ ...n }));

  // One note operation. sel = { bar, note } (index into voiceNotes(model, voice)[bar].notes).
  // Returns { model, sel } or throws an Error with a message for the user.
  function editNote(model, voice, sel, op, arg) {
    const all = voiceNotes(model, voice);
    const info = all[sel.bar];
    if (info.error) throw new Error(`Bu ölçü düzenlenemiyor: ${info.error}`);
    const bars = new Map([[sel.bar, copyNotes(info.notes)]]);
    const get = (b) => {
      if (b < 0 || b >= all.length) return null;
      if (!bars.has(b)) { if (all[b].error) return null; bars.set(b, copyNotes(all[b].notes)); }
      return bars.get(b);
    };
    const notes = bars.get(sel.bar);
    let index = sel.note;
    const note = notes[index];
    if (!note) throw new Error("Nota bulunamadı");
    const step = arg && arg.step ? arg.step : 1;
    // Undo the ties into and out of a note that stops being one held sound.
    const cutTieIn = (n) => { if (n.contIn) { n.contIn = false; const prev = get(sel.bar - 1); if (prev) prev[prev.length - 1].tieOut = false; } };
    const cutTieOut = (n, b) => { if (n.tieOut) { n.tieOut = false; const next = get(b + 1); if (next && next[0]) next[0].contIn = false; } };
    const setPitch = (n, midi) => Object.assign(n, { midi }, spell(midi, all[sel.bar].key));

    if (op === "pitch") {
      if (note.rest) throw new Error("Sus işaretinin perdesi yok; önce notaya çevir");
      const midi = note.midi + arg.semitones;
      if (midi < 36 || midi > 96) throw new Error("Bu perde nota aralığının dışında");
      setPitch(note, midi);
      // A held note keeps one pitch over every barline it is tied across.
      for (let b = sel.bar, n = note; n.tieOut && get(b + 1); b++) { n = get(b + 1)[0]; Object.assign(n, { midi }, spell(midi, all[b + 1].key)); }
      for (let b = sel.bar, n = note; n.contIn && get(b - 1); b--) { const prev = get(b - 1); n = prev[prev.length - 1]; Object.assign(n, { midi }, spell(midi, all[b - 1].key)); }
    } else if (op === "longer") {
      const next = notes[index + 1];
      if (!next) {
        // Over the barline: the note goes on, tied, into the rest the next bar starts with.
        if (note.rest) throw new Error("Sus sonraki ölçüye uzatılamaz");
        if (note.tieOut) throw new Error("Nota zaten sonraki ölçüye bağlı; uzatmayı orada yap");
        const following = get(sel.bar + 1);
        if (!following) throw new Error("Son ölçü; daha fazla uzatılamaz");
        if (!following[0].rest) throw new Error("Sonraki ölçü notayla başlıyor; önce onu kısalt ya da sus yap");
        const take = Math.min(step, following[0].dur);
        following[0].dur -= take;
        if (!following[0].dur) following.splice(0, 1);
        following.unshift({ ...note, dur: take, contIn: true, tieOut: false });
        note.tieOut = true;
      } else {
        const take = Math.min(step, next.dur);
        next.dur -= take;
        note.dur += take;
        if (!next.dur) {
          if (!next.rest && next.tieOut) {
            if (!note.rest && note.midi === next.midi) note.tieOut = true;
            else cutTieOut(next, sel.bar);
          }
          notes.splice(index + 1, 1);
        }
      }
    } else if (op === "shorter") {
      if (note.dur <= step) throw new Error("Daha fazla kısaltılamaz; sus yapmayı ya da silmeyi dene");
      note.dur -= step;
      if (!note.rest) cutTieOut(note, sel.bar);
      const next = notes[index + 1];
      if (note.rest) { /* a shorter rest gives its time to a new rest anyway */ }
      if (next && next.rest) next.dur += step;
      else notes.splice(index + 1, 0, { rest: true, dur: step, tieOut: false, contIn: false });
    } else if (op === "rest") {
      if (note.rest) throw new Error("Zaten sus");
      cutTieIn(note);
      cutTieOut(note, sel.bar);
      notes[index] = { rest: true, dur: note.dur, tieOut: false, contIn: false };
    } else if (op === "note") {
      if (!note.rest) throw new Error("Zaten nota");
      // The new note starts on the pitch of the nearest note before it in this voice.
      let midi = null;
      for (let b = sel.bar, i = index - 1; b >= 0 && midi === null; b--, i = Infinity) {
        const list = b === sel.bar ? notes : (all[b].notes || []);
        for (let k = Math.min(i, list.length - 1); k >= 0; k--) if (!list[k].rest) { midi = list[k].midi; break; }
      }
      notes[index] = setPitch({ rest: false, dur: note.dur, tieOut: false, contIn: false }, midi === null ? 71 : midi);
    } else if (op === "place") {
      // A new note inside a rest: arg.offset units after the rest starts, arg.dur long (as much as
      // the rest has room for), at arg.midi.
      if (!note.rest) throw new Error("Burada zaten nota var");
      const offset = arg.offset || 0;
      const dur = Math.min(arg.dur || step, note.dur - offset);
      if (offset < 0 || dur <= 0) throw new Error("Nota bu susun içine sığmıyor");
      if (arg.midi < 36 || arg.midi > 96) throw new Error("Bu perde nota aralığının dışında");
      const parts = [];
      if (offset) parts.push({ rest: true, dur: offset, tieOut: false, contIn: false });
      parts.push(setPitch({ rest: false, dur, tieOut: false, contIn: false }, arg.midi));
      if (note.dur - offset - dur) parts.push({ rest: true, dur: note.dur - offset - dur, tieOut: false, contIn: false });
      notes.splice(index, 1, ...parts);
      if (offset) index++;
    } else if (op === "split") {
      if (note.dur < 2) throw new Error("Bu nota bölünemeyecek kadar kısa");
      const first = Math.ceil(note.dur / 2);
      const second = { ...note, dur: note.dur - first, contIn: false };
      Object.assign(note, { dur: first, tieOut: false });
      notes.splice(index + 1, 0, second);
    } else if (op === "merge") {
      const next = notes[index + 1];
      if (!next) throw new Error("Ölçünün son notası; birleşecek sonraki nota yok");
      note.dur += next.dur;
      if (!note.rest && !next.rest && next.midi === note.midi) note.tieOut = next.tieOut;
      else { cutTieOut(next, sel.bar); if (!note.rest) cutTieOut(note, sel.bar); }
      notes.splice(index + 1, 1);
    } else {
      throw new Error(`bilinmeyen işlem ${op}`);
    }

    // Neighbouring rests become one; then each touched bar is written back.
    for (const list of bars.values()) {
      for (let k = list.length - 1; k > 0; k--) {
        if (list[k].rest && list[k - 1].rest) { list[k - 1].dur += list[k].dur; list.splice(k, 1); if (k <= index && list === notes) index--; }
      }
    }
    const next = model.bars.map((bar, b) => {
      if (!bars.has(b)) return bar;
      const list = bars.get(b);
      if (list.reduce((s, n) => s + n.dur, 0) !== all[b].units) throw new Error("iç hata: ölçü süresi bozuldu");
      return { ...bar, [voice]: writeBar(list, all[b].key, all[b].units) };
    });
    const out = { ...model, bars: next };
    index = Math.max(0, Math.min(index, bars.get(sel.bar).length - 1));
    return { model: out, sel: { bar: sel.bar, note: index } };
  }

  // A note moved: the note of `voice` that starts at unit u0 (with every bar it is held over) goes
  // to start at unit `to`, at `midi`; where it was becomes rest. Its new place must be silent; over
  // a barline it is tied. Returns { model, sel } or throws an Error with a message for the user.
  function moveNote(model, voice, u0, to, midi) {
    const all = voiceNotes(model, voice);
    const starts = [];
    let total = 0;
    for (const bar of all) { starts.push(total); total += bar.units; }
    const bars = new Map();
    const get = (b) => {
      if (all[b].error) throw new Error(`Bu ölçü düzenlenemiyor: ${all[b].error}`);
      if (!bars.has(b)) bars.set(b, copyNotes(all[b].notes));
      return bars.get(b);
    };
    const joinRests = (list) => {
      for (let k = list.length - 1; k > 0; k--) if (list[k].rest && list[k - 1].rest) { list[k - 1].dur += list[k].dur; list.splice(k, 1); }
    };
    const barOf = (u) => starts.findIndex((s, b) => s <= u && u < s + all[b].units);

    // The note, silenced part by part.
    let b = barOf(u0), k = -1;
    if (b >= 0) for (let i = 0, x = starts[b]; i < all[b].notes.length; x += all[b].notes[i].dur, i++) if (x === u0) k = i;
    const first = b >= 0 && k >= 0 ? all[b].notes[k] : null;
    if (!first || first.rest || first.contIn) throw new Error("Nota bulunamadı");
    if (midi < 36 || midi > 96) throw new Error("Bu perde nota aralığının dışında");
    let dur = 0;
    for (;;) {
      const list = get(b), part = list[k];
      dur += part.dur;
      list[k] = { rest: true, dur: part.dur, tieOut: false, contIn: false };
      if (!part.tieOut || b + 1 >= all.length) break;
      b++; k = 0;
    }
    if (to < 0 || to + dur > total) throw new Error("Nota şarkının dışına taşınamaz");

    // The new place, bar by bar.
    let at = to, left = dur;
    const firstBar = barOf(to);
    for (b = firstBar; left > 0; b++) {
      const list = get(b);
      joinRests(list);
      const offset = at - starts[b], len = Math.min(left, all[b].units - offset);
      let x = 0, i = 0;
      while (i < list.length && x + list[i].dur <= offset) x += list[i++].dur;
      const rest = list[i];
      if (!rest || !rest.rest || x + rest.dur < offset + len) throw new Error("Orada başka nota var; nota yalnız boş yere taşınır");
      const parts = [];
      if (offset > x) parts.push({ rest: true, dur: offset - x, tieOut: false, contIn: false });
      parts.push(Object.assign({ rest: false, dur: len, tieOut: left > len, contIn: b !== firstBar, midi }, spell(midi, all[b].key)));
      if (x + rest.dur > offset + len) parts.push({ rest: true, dur: x + rest.dur - offset - len, tieOut: false, contIn: false });
      list.splice(i, 1, ...parts);
      at += len; left -= len;
    }

    for (const list of bars.values()) joinRests(list);
    const next = model.bars.map((bar, n) => {
      if (!bars.has(n)) return bar;
      const list = bars.get(n);
      if (list.reduce((s, x) => s + x.dur, 0) !== all[n].units) throw new Error("iç hata: ölçü süresi bozuldu");
      return { ...bar, [voice]: writeBar(list, all[n].key, all[n].units) };
    });
    let note = 0;
    for (let x = starts[firstBar], list = bars.get(firstBar); x < to; x += list[note++].dur);
    return { model: { ...model, bars: next }, sel: { bar: firstBar, note } };
  }

  // MIDI pitch as a name for the status line: "F#4", "Bb3".
  function pitchName(note) {
    return note.rest ? "sus" : note.letter + ({ 2: "𝄪", 1: "♯", 0: "", "-1": "♭", "-2": "𝄫" })[note.alter] + note.octave;
  }

  return { parse, serialize, sections, sectionOf, setSection, swapVoices, tieSafeRange,
    voiceNotes, editNote, moveNote, writeBar, pitchName, unitDenominator: (m) => Number((headerField(m, "L").split("/")[1]) || 8) };
})();

if (typeof module !== "undefined") module.exports = ScoreModel;
