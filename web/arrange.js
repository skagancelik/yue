"use strict";
// What the studio sends YuE2 for an arrangement made from a prepared score: the score, the lyrics
// and one style text. YuE2 has no way to be told "this syllable on this note" or "strings from bar
// 17", so the timeline's work is turned into what it does read (see the YuE2 repo's ABC and
// editing guides):
//
// - Vocal notes no syllable sits on would be hummed, so bars that only have such notes (and no
//   instrument notes) go to the Ins voice: the instrument plays that melody instead.
// - The score's sections ("% verse") are named after the lyric sections laid on them, in the same
//   order, with "intro", "interlude" and "outro" for the bars without lyrics around them; the lyric
//   tags get the same names ([Verse]). YuE2 matches the two by name and order.
// - The tracks (an instrument, how it plays, in which bars) become phrases of the style text, with
//   the score's tempo: "energetic strings in the choruses, soft piano throughout, 92 BPM".
//
// The syllables keep their notes: the returned `at` is the layout saved on the arrangement.

const Arrange = (() => {
  // [English for YuE2, Turkish label]
  const INSTRUMENTS = [
    ["strings", "Yaylılar (strings)"], ["violin", "Keman"], ["cello", "Çello"], ["piano", "Piyano"],
    ["electric piano", "Elektrikli piyano"], ["acoustic guitar", "Akustik gitar"], ["electric guitar", "Elektro gitar"],
    ["bass guitar", "Bas gitar"], ["synth bass", "Synth bas"], ["808 bass", "808 bas"], ["drums", "Davul"],
    ["percussion", "Perküsyon"], ["darbuka", "Darbuka"], ["synth pad", "Synth pad"], ["synth lead", "Synth lead"],
    ["brass section", "Nefesliler (brass)"], ["trumpet", "Trompet"], ["saxophone", "Saksafon"], ["flute", "Flüt"],
    ["clarinet", "Klarnet"], ["ney", "Ney"], ["baglama", "Bağlama (saz)"], ["oud", "Ud"], ["kanun", "Kanun"],
    ["accordion", "Akordeon"], ["organ", "Org"], ["harp", "Arp"], ["choir", "Koro"],
  ];
  const FEELS = [
    ["energetic", "coşkulu"], ["uplifting", "umut veren"], ["soft", "yumuşak"], ["gentle", "nazik"],
    ["emotional", "duygusal"], ["melancholic", "hüzünlü"], ["epic", "görkemli"], ["dramatic", "dramatik"],
    ["calm", "sakin"], ["warm", "sıcak"], ["bright", "parlak"], ["dark", "karanlık"], ["rhythmic", "ritmik"],
    ["driving", "sürükleyici"], ["groovy", "groove'lu"], ["staccato", "kesik kesik"], ["legato", "bağlı, akıcı"],
    ["pizzicato", "pizzicato"], ["arpeggiated", "arpejli"], ["sustained", "uzun tutulan"], ["swelling", "giderek yükselen"],
    ["sparse", "seyrek"], ["lush", "dolgun"], ["distorted", "distorsiyonlu"], ["background", "arka planda"],
    ["prominent", "önde"],
  ];
  const feelLabel = Object.fromEntries(FEELS);
  const instrumentLabel = Object.fromEntries(INSTRUMENTS);

  // Lyric tag → the score's section name. Turkish tags lose their non-ASCII letters in sectionName.
  const CANON = { prechorus: "pre-chorus", postchorus: "post-chorus", nakarat: "chorus", refrain: "chorus", kta: "verse",
    kpr: "bridge", gir: "intro", bit: "outro", ara: "interlude", aramzik: "interlude", final: "outro" };
  const canon = (tag) => { const name = LyricsLayout.sectionName(tag || ""); return CANON[name] || name; };
  const TAG = { "pre-chorus": "Pre-Chorus", "post-chorus": "Post-Chorus" };
  const tagText = (name) => TAG[name] || name.charAt(0).toUpperCase() + name.slice(1);
  const PLURAL = { chorus: "choruses", verse: "verses", bridge: "bridges", "pre-chorus": "pre-choruses", interlude: "interludes", solo: "solos" };

  // ---- tracks → style

  // "in the choruses", "in the last chorus", "in bars 9–16"; "" for (nearly) the whole song.
  function scopeText(ranges, runs, barCount) {
    if (!ranges || !ranges.length) return "";
    const on = new Set();
    for (const [a, b] of ranges) for (let i = a; i <= b && i < barCount; i++) on.add(i);
    if (on.size >= barCount * 0.9) return "";
    const named = runs.map((run) => ({ ...run, name: canon(run.label) || "part" }));
    const taken = named.filter((run) => {
      let n = 0;
      for (let i = run.from; i <= run.to; i++) if (on.has(i)) n++;
      return n / (run.to - run.from + 1) >= 0.6;
    });
    if (!taken.length) {
      const parts = ranges.map(([a, b]) => (a === b ? `bar ${a + 1}` : `bars ${a + 1}-${b + 1}`));
      return `in ${parts.join(" and ")}`;
    }
    const groups = [];
    for (const run of taken) {
      let group = groups.find((g) => g.name === run.name);
      if (!group) groups.push(group = { name: run.name, runs: [] });
      group.runs.push(run);
    }
    const parts = groups.map(({ name, runs: picked }) => {
      const all = named.filter((run) => run.name === name);
      if (picked.length === all.length) return all.length > 1 ? `the ${PLURAL[name] || name + "s"}` : `the ${name}`;
      if (picked.length === 1 && all.length > 1) {
        const k = all.indexOf(picked[0]);
        return `the ${k === 0 ? "first" : k === all.length - 1 ? "last" : ["second", "third", "fourth"][k - 1] || `${k + 1}th`} ${name}`;
      }
      return `${picked.length} of the ${PLURAL[name] || name + "s"}`;
    });
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
    return `in ${list}`;
  }

  // bars null = the whole song; [] = nowhere yet (the track is left out).
  const placedNowhere = (track) => Array.isArray(track.bars) && !track.bars.length;

  function trackPhrase(track, runs, barCount) {
    if (placedNowhere(track)) return "";
    const words = [...(track.feel || []), track.instrument].filter(Boolean).join(" ");
    const scope = scopeText(track.bars, runs, barCount);
    return [words + (track.lead ? " playing the main melody" : ""), track.text, scope].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function composeStyle(base, tracks, model, { bpm = true } = {}) {
    const runs = ScoreModel.sections(model);
    const phrases = (tracks || []).filter((t) => t.instrument && !placedNowhere(t)).map((t) => trackPhrase(t, runs, model.bars.length));
    const parts = [(base || "").trim().replace(/[\s,;.]+$/, ""), ...phrases].filter(Boolean);
    const tempo = (model.header.find((l) => l.startsWith("Q:")) || "").match(/(\d+(?:\.\d+)?)\s*$/);
    if (bpm && tempo && !/\bbpm\b/i.test(base || "")) parts.push(`${Math.round(Number(tempo[1]))} BPM`);
    return parts.join(", ");
  }

  // ---- score + lyrics

  // Notes the lyrics sing: every note with a syllable, the empty notes between two syllables of one
  // lyric section (a syllable held over them), and the notes that go on without a breath after a
  // syllable until the next one (a melisma, often the long last note of a line).
  function sungNotes(map, sylls, tl) {
    const sung = new Set();
    const phraseOf = new Map();
    Align.phrases(tl).forEach((p, k) => p.notes.forEach((n) => phraseOf.set(n, k)));
    const placed = map.map((n, g) => ({ n, g })).filter((x) => x.n != null);
    // After a section's last syllable the phrase may go on as a hum: only a short melisma (up to
    // three notes inside one bar) still belongs to the syllable.
    const barUnits = tl.bars.length ? tl.bars[0].u1 - tl.bars[0].u0 : Infinity;
    placed.forEach(({ n, g }, i) => {
      sung.add(n);
      const next = placed[i + 1];
      const end = next ? next.n : tl.vocal.length;
      const same = next && sylls[next.g].section === sylls[g].section;
      for (let x = n + 1, tail = 0; x < end; x++) {
        if (!same && (phraseOf.get(x) !== phraseOf.get(n) || ++tail > 3 || tl.vocal[x].u0 - tl.vocal[n].u0 >= barUnits)) break;
        sung.add(x);
      }
    });
    return sung;
  }

  // Bar of every L: unit range [u0, u1).
  const barsOf = (tl, u0, u1) => tl.bars.map((bar, b) => (bar.u0 < u1 && u0 < bar.u1 ? b : -1)).filter((b) => b >= 0);

  function instrumentalize(model, tl, sung, report) {
    const count = tl.bars.length;
    const hasVocal = new Array(count).fill(false), isSung = new Array(count).fill(false), hasIns = new Array(count).fill(false);
    for (const note of tl.vocal) for (const b of barsOf(tl, note.u0, note.u1)) { hasVocal[b] = true; if (sung.has(note.number)) isSung[b] = true; }
    for (const note of tl.ins) for (const b of barsOf(tl, note.u0, note.u1)) hasIns[b] = true;
    const free = (b) => hasVocal[b] && !isSung[b] && !hasIns[b];
    let moved = 0;
    for (let b = 0; b < count; b++) {
      if (!free(b)) continue;
      let e = b;
      while (e + 1 < count && free(e + 1)) e++;
      const [a, z] = ScoreModel.tieSafeRange(model, b, e);
      const ok = a <= z && Array.from({ length: z - a + 1 }, (_, k) => a + k).every((x) => !isSung[x] && !hasIns[x]);
      if (ok) {
        const notes = tl.vocal.filter((n) => tl.bars[a].u0 <= n.u0 && n.u0 < tl.bars[z].u1).length;
        model = ScoreModel.swapVoices(model, a, z).model;
        moved += notes;
        report.push({ kind: "ok", text: `Ölçü ${a + 1}${z > a ? `–${z + 1}` : ""}: hecesi olmayan ${notes} vokal notası enstrümana verildi (YuE2 mırıldanmasın diye).` });
      }
      b = e;
    }
    // What is left: vocal notes without syllables that share a bar with sung ones or with the instrument.
    const after = Timeline.fromModel(model);
    return { model, moved, after };
  }

  // What whole bars cannot take (a bar that also has sung notes, or a hum tied over a barline): the
  // vocal notes without a syllable go to the instrument note by note, where it is silent. A tied
  // note moves with all its parts or not at all.
  function handOff(model, tl, sung, report) {
    const voc = ScoreModel.voiceNotes(model, "vocal"), ins = ScoreModel.voiceNotes(model, "ins");
    if (voc.some((bar) => bar.error) || ins.some((bar) => bar.error)) return { model, moved: 0 };
    const silent = ins.map((bar) => bar.notes.every((n) => n.rest));
    const take = voc.map(() => new Set());
    let moved = 0;
    for (const note of tl.vocal) {
      if (sung.has(note.number)) continue;
      const parts = [[note.bar, note.k]];
      for (let b = note.bar, k = note.k; voc[b].notes[k].tieOut && b + 1 < voc.length; b++, k = 0) parts.push([b + 1, 0]);
      if (!parts.every(([b]) => silent[b])) continue;
      for (const [b, k] of parts) take[b].add(k);
      moved++;
    }
    if (!moved) return { model, moved };
    const merged = (list) => list.reduce((out, n) => {
      const last = out[out.length - 1];
      if (n.rest && last && last.rest) last.dur += n.dur; else out.push({ ...n });
      return out;
    }, []);
    const bars = model.bars.map((bar, b) => {
      if (!take[b].size) return bar;
      const vocal = voc[b].notes.map((n, k) => (take[b].has(k) ? { rest: true, dur: n.dur } : n));
      const played = voc[b].notes.map((n, k) => (take[b].has(k) ? n : { rest: true, dur: n.dur }));
      return { ...bar, vocal: ScoreModel.writeBar(merged(vocal), voc[b].key, voc[b].units), ins: ScoreModel.writeBar(merged(played), ins[b].key, ins[b].units) };
    });
    const where = take.map((set, b) => (set.size ? b + 1 : 0)).filter(Boolean);
    report.push({ kind: "ok", text: `Ölçü ${where.slice(0, 8).join(", ")}${where.length > 8 ? "…" : ""}: söylenen notaların yanındaki hecesiz ${moved} nota enstrümana verildi.` });
    return { model: { ...model, bars }, moved };
  }

  // Score section names from where the lyric sections were laid. Returns the new bar labels or null.
  function sectionLabels(tl, map, sylls, lyricSecs, sung, report) {
    const secs = lyricSecs.map((sec, k) => {
      const notes = map.filter((n, g) => n != null && sylls[g].section === k);
      if (!notes.length) return null;
      // The section ends with its last syllable's melisma, before the next section's first syllable.
      const next = Math.min(tl.vocal.length, ...map.filter((n, g) => n != null && sylls[g].section > k));
      let end = Math.max(...notes);
      while (end + 1 < next && sung.has(end + 1)) end++;
      const first = tl.vocal[Math.min(...notes)], last = tl.vocal[end];
      const endBar = tl.bars.findIndex((bar) => last.u1 - 1 < bar.u1);
      return { k, name: canon(sec.tag || sec.name), start: first.bar, end: endBar < 0 ? tl.bars.length - 1 : endBar };
    }).filter(Boolean);
    if (!secs.length || secs.some((s) => !s.name)) return null;
    const kept = [];
    for (const sec of secs) {
      const prev = kept[kept.length - 1];
      // A pickup: the section's first syllables share a bar with the last ones of the section before.
      if (prev && sec.start <= prev.end) sec.start = prev.end + 1;
      if (sec.start > sec.end) {
        report.push({ kind: "warn", text: `${tagText(sec.name)}: bütün heceleri önceki bölümle aynı ölçülerde; notada ayrı bölüm olamadı.` });
        if (prev) prev.end = Math.max(prev.end, sec.end);
        continue;
      }
      kept.push(sec);
    }
    const labels = new Array(tl.bars.length).fill(null);
    if (kept[0].start > 0) labels[0] = "intro";
    kept.forEach((sec, i) => {
      labels[sec.start] = sec.name;
      const next = kept[i + 1];
      const gapEnd = next ? next.start - 1 : tl.bars.length - 1;
      const gap = gapEnd - sec.end;
      if (!next && gap >= 1) labels[sec.end + 1] = "outro";
      else if (next && gap >= 2) labels[sec.end + 1] = "interlude";
    });
    return labels;
  }

  // The lyrics with their tags named like the score's sections; everything else as written.
  function retag(lyrics) {
    return lyrics.split("\n").map((line) => {
      const tag = line.trim().match(/^\[([^\]]+)\]$/);
      if (!tag) return line;
      const name = canon(tag[1]);
      return name ? `[${tagText(name)}]` : line;
    }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // abc: the score; lyrics: the lyrics (with corrected letters); map: the note of every syllable on
  // that score (null = none; another length means "lay them out automatically"); tracks; style: the
  // style as written. Returns { abc, lyrics, style, at, map, report, structure }.
  function compile({ abc, lyrics, map, tracks = [], style = "", options = {} }) {
    const opts = { instrumentalize: true, sections: true, bpm: true, ...options };
    const report = [];
    let model = ScoreModel.parse(abc);
    let tl = Timeline.fromModel(model);
    const sylls = LyricsLayout.allSyllables(lyrics);
    if (!Array.isArray(map) || map.length !== sylls.length) {
      map = Align.autoAlign(tl, lyrics);
      if (sylls.length) report.push({ kind: "warn", text: "Bu söz için kayıtlı hece yerleşimi yok; heceler otomatik yerleştirildi. Zaman çizgisinde kontrol etmek daha iyi sonuç verir." });
    }
    const loose = map.filter((n) => n == null).length;
    if (loose) report.push({ kind: "warn", text: `${loose} hece hiçbir notaya yerleşmemiş; YuE2 onları kendi yerleştirir.` });

    if (opts.instrumentalize && sylls.length) {
      const at = Timeline.onsets(tl, map);
      const done = instrumentalize(model, tl, sungNotes(map, sylls, tl), report);
      if (done.moved) {
        model = done.model;
        tl = done.after;
        map = Timeline.mapFromOnsets(tl, at);
      }
      const rest = handOff(model, tl, sungNotes(map, sylls, tl), report);
      if (rest.moved) {
        model = rest.model;
        tl = Timeline.fromModel(model);
        map = Timeline.mapFromOnsets(tl, at);
      }
    }
    const sungNow = sungNotes(map, sylls, tl);
    const still = tl.vocal.filter((n) => !sungNow.has(n.number));
    if (sylls.length && still.length) {
      const bars = [...new Set(still.map((n) => n.bar + 1))];
      report.push({ kind: "warn", text: `${still.length} vokal notasında hece yok (ölçü ${bars.slice(0, 8).join(", ")}${bars.length > 8 ? "…" : ""}). Söylenmesin istiyorsan o ölçüleri Vokal ⇄ Enstrüman yap ya da hece koy.` });
    }

    let outLyrics = lyrics.trim();
    if (opts.sections && sylls.length) {
      const lyricSecs = LyricsLayout.lyricSections(lyrics);
      const labels = sectionLabels(tl, map, sylls, lyricSecs, sungNotes(map, sylls, tl), report);
      if (labels) {
        model = { ...model, bars: model.bars.map((bar, b) => ({ ...bar, labels: labels[b] ? [labels[b]] : [] })) };
        outLyrics = retag(lyrics);
      } else if (lyricSecs.some((s) => !s.name)) {
        report.push({ kind: "warn", text: "Sözde bölüm etiketi ([Verse], [Chorus]…) olmayan dizeler var; notadaki bölümler olduğu gibi bırakıldı." });
      }
    }
    const out = ScoreModel.serialize(model).text;
    tl = Timeline.build(out);
    const structure = ScoreModel.sections(model).map((run) => ({ label: run.label, from: run.from, to: run.to, sung: run.sung }));
    const finalStyle = composeStyle(style, tracks, model, opts);
    return { abc: out, lyrics: outLyrics, style: finalStyle, at: Timeline.onsets(tl, map), map, report, structure };
  }

  return { compile, sungNotes, composeStyle, trackPhrase, scopeText, canon, tagText, INSTRUMENTS, FEELS, feelLabel, instrumentLabel };
})();

if (typeof module !== "undefined") module.exports = Arrange;
