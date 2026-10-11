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

  // The lyrics with their tags named like the score's sections; everything else as written. A tag
  // with no words under it ([Instrumental], [Solo] …) stands for bars the score names intro,
  // interlude or outro by where they are, so it takes that name when the score has it.
  function retag(lyrics, labels = []) {
    const lines = lyrics.split("\n");
    const isTag = (line) => /^\[[^\]]+\]$/.test(line.trim());
    const sung = lines.map((line) => !isTag(line) && /\p{L}/u.test(line));
    const firstSung = sung.indexOf(true), lastSung = sung.lastIndexOf(true);
    const have = new Set(labels.filter(Boolean));
    return lines.map((line, i) => {
      const tag = line.trim().match(/^\[([^\]]+)\]$/);
      if (!tag) return line;
      let next = lines.findIndex((l, j) => j > i && isTag(l));
      if (next < 0) next = lines.length;
      if (firstSung >= 0 && !sung.slice(i + 1, next).some(Boolean)) {
        const place = i < firstSung ? "intro" : i > lastSung ? "outro" : "interlude";
        if (have.has(place)) return `[${tagText(place)}]`;
      }
      const name = canon(tag[1]);
      return name ? `[${tagText(name)}]` : line;
    }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // abc: the score; lyrics: the lyrics (with corrected letters); map: the note of every syllable on
  // that score (null = none; another length means "lay them out automatically"); tracks; style: the
  // style as written; chords: false to leave the score's chords out (the accompaniment is then
  // YuE2's own). Returns { abc, lyrics, style, cot, chords, at, map, report, structure }: cot is
  // "full" when chords go with the score (YuE2 plays to them), else "melody".
  function compile({ abc, lyrics, map, tracks = [], style = "", chords = true, options = {} }) {
    const opts = { instrumentalize: true, sections: true, bpm: true, ...options };
    const report = [];
    let model = ScoreModel.parse(abc);
    const had = ScoreModel.chordLine(model).length;
    if (had && !chords) {
      model = ScoreModel.withoutChords(model);
      report.push({ kind: "ok", text: `Notadaki ${had} akor gönderilmiyor: eşliği (armoniyi) YuE2 kendisi uyduracak (mod: melody).` });
    } else if (had) {
      report.push({ kind: "ok", text: `Notadaki ${had} akor gidiyor: YuE2 eşliği şarkının bu akorlarına göre çalacak (mod: full).` });
    }
    const cot = had && chords ? "full" : "melody";
    const grid = ScoreModel.gridCheck(model);
    if (grid.notes && grid.offGrid / grid.notes > 0.2) {
      report.push({ kind: "warn", text: `Vokal notalarının ${grid.offGrid}/${grid.notes} tanesi vuruş dışında başlıyor; YuE2 melodiyi kaymış, aksak duyar. Zaman çizgisinde "🧲 Notaları hizala" ile düzelt.` });
    }
    if (grid.meterChanges) {
      report.push({ kind: "warn", text: `Notada ${grid.meterChanges} ölçü şarkının ölçüsünden farklı (ör. 4/4 içinde 2/4); ritim orada takılır. "🧲 Notaları hizala" bunu da düzeltir.` });
    }
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
        outLyrics = retag(lyrics, labels);
      } else if (lyricSecs.some((s) => !s.name)) {
        report.push({ kind: "warn", text: "Sözde bölüm etiketi ([Verse], [Chorus]…) olmayan dizeler var; notadaki bölümler olduğu gibi bırakıldı." });
      }
    }
    const out = ScoreModel.serialize(model).text;
    tl = Timeline.build(out);
    const structure = ScoreModel.sections(model).map((run) => ({ label: run.label, from: run.from, to: run.to, sung: run.sung }));
    const finalStyle = composeStyle(style, tracks, model, opts);
    return { abc: out, lyrics: outLyrics, style: finalStyle, cot, chords: cot === "full" ? had : 0, at: Timeline.onsets(tl, map), map, report, structure };
  }

  // An instrumental version of a compiled request: no words are sent, the melody the lyrics would
  // be sung on is played by the instrument voice over the same chords, sections and tempo, so the
  // backing leaves its places to the melody. Lyrics keep only their section tags; the style says
  // instrumental and loses its voice descriptions. Returns the request with its report extended.
  function instrumentalVersion(compiled) {
    // Notes about syllables do not apply: no words are sent.
    const report = compiled.report.filter((r) => !/hece/i.test(r.text));
    const moved = ScoreModel.melodyToIns(ScoreModel.parse(compiled.abc));
    const tags = compiled.lyrics.split("\n").map((line) => line.trim()).filter((line) => /^\[[^\]]+\]$/.test(line));
    const parts = compiled.style.split(",").map((p) => p.trim()).filter(Boolean);
    const voice = /vocal|voice|singer|sung|sing|choir|rap\b|vokal|şarkıcı/i;
    const dropped = parts.filter((p) => voice.test(p));
    const style = ["Instrumental", "no vocals", ...parts.filter((p) => !voice.test(p) && !/^instrumental$|^no vocals$/i.test(p)),
      "expressive lead instrument plays the melody"].join(", ");
    report.push({ kind: "ok", text: `Enstrümantal: ${moved.moved} vokal notası enstrüman sesine geçti; söz gitmiyor, yalnız bölüm etiketleri (${tags.length}) gidiyor.` });
    if (moved.cut) report.push({ kind: "warn", text: `${moved.cut} enstrüman notası vokal melodisiyle çakıştığı için kısaltıldı ya da kaldırıldı (enstrüman sesi tek melodi çalabilir).` });
    if (dropped.length) report.push({ kind: "ok", text: `Stilden vokal tarifi çıkarıldı: ${dropped.join(", ")}.` });
    return { ...compiled, abc: ScoreModel.serialize(moved.model).text, lyrics: tags.join("\n\n"), style, report, instrumental: true };
  }

  // The chords of another score of the same recording (a newer melody extraction) put into this
  // one by time: each where it starts in seconds, on the nearest eighth note. The notes, and so
  // the syllables on them, stay as they are; the score's own chords are replaced. Returns
  // { abc, count, dropped, tempo: [this bpm, that bpm] }.
  function borrowChords(abc, from) {
    const model = ScoreModel.parse(abc), other = ScoreModel.parse(from);
    const tl = Timeline.fromModel(model), otl = Timeline.fromModel(other);
    const total = tl.bars.length ? tl.bars[tl.bars.length - 1].u1 : 0;
    const eighth = Math.max(1, tl.unit / 8);
    const line = [];
    let dropped = 0;
    for (const chord of otl.chords) {
      const u = Math.round(chord.t0 / tl.perUnit / eighth) * eighth;
      if (u < 0 || u >= total) { dropped++; continue; }
      const same = line.findIndex((c) => c.u === u);
      if (same >= 0) line[same] = { u, name: chord.name }; else line.push({ u, name: chord.name });
    }
    const out = ScoreModel.placeChords(ScoreModel.withoutChords(model), line);
    return { abc: ScoreModel.serialize(out).text, count: line.length, dropped, tempo: [tl.bpm, otl.bpm] };
  }

  // ---- chords suggested from the melody (no recording needed)
  // The key's own triads; each segment (a bar, or half of a 4/4 bar) gets the one whose tones its
  // melody notes (Vocal and Ins, longer and on-the-beat notes counting more) fit best. A Viterbi pass
  // keeps the harmony from changing without reason, starts and ends on the tonic, and likes V → I.
  const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  // [semitones above the tonic, minor triad, how common]
  const MAJOR_TRIADS = [[0, false, 1], [2, true, 0.55], [4, true, 0.3], [5, false, 0.9], [7, false, 0.9], [9, true, 0.7], [10, false, 0.35]];
  const MINOR_TRIADS = [[0, true, 1], [3, false, 0.65], [5, true, 0.8], [7, false, 0.7], [7, true, 0.5], [8, false, 0.7], [10, false, 0.65]];
  // Krumhansl–Kessler key profiles (how much each degree belongs to a major / minor key).
  const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const MAJOR_KEYS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  const MINOR_KEYS = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"];

  // The key the melody is in, from how long each pitch class sounds (the written K: wins a near tie).
  function melodyKey(notes, written) {
    const hist = new Array(12).fill(0);
    for (const n of notes) hist[n.midi % 12] += n.u1 - n.u0;
    const corr = (profile, tonic) => {
      const xs = hist, ys = xs.map((_, pc) => profile[(pc - tonic + 12) % 12]);
      const mx = xs.reduce((a, b) => a + b, 0) / 12, my = ys.reduce((a, b) => a + b, 0) / 12;
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < 12; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
      return dx && dy ? num / Math.sqrt(dx * dy) : 0;
    };
    let best = { ...written, score: corr(written.minor ? MINOR_PROFILE : MAJOR_PROFILE, written.tonic) + 0.02 };
    for (let tonic = 0; tonic < 12; tonic++) for (const minor of [false, true]) {
      const score = corr(minor ? MINOR_PROFILE : MAJOR_PROFILE, tonic);
      if (score > best.score) best = { tonic, minor, score };
    }
    const name = (best.minor ? MINOR_KEYS : MAJOR_KEYS)[best.tonic];
    return { ...ScoreModel.keyInfo(`K:${name}`), name };
  }

  function suggestChords(abc) {
    const model = ScoreModel.parse(abc);
    const tl = Timeline.fromModel(model);
    const notes = [...tl.vocal, ...tl.ins];
    const key = melodyKey(notes, ScoreModel.keyInfo(model.header.find((l) => l.startsWith("K:"))));
    const names = key.flats ? FLAT_NAMES : SHARP_NAMES;
    const chords = (key.minor ? MINOR_TRIADS : MAJOR_TRIADS).map(([step, minor, common], degree) => {
      const root = (key.tonic + step) % 12;
      return { degree, root, tones: [root, (root + (minor ? 3 : 4)) % 12, (root + 7) % 12], common, name: names[root] + (minor ? "m" : "") };
    });
    // Segments: a bar, or its halves when it is four beats long or more and splits evenly.
    const beat = tl.unit / 4;
    const segments = [];
    for (const bar of tl.bars) {
      if (bar.units >= 4 * beat && bar.units % 2 === 0) segments.push([bar.u0, bar.u0 + bar.units / 2], [bar.u0 + bar.units / 2, bar.u1]);
      else segments.push([bar.u0, bar.u1]);
    }
    const fit = segments.map(([s, e]) => {
      const weights = new Map();
      let total = 0;
      for (const n of notes) {
        const over = Math.min(n.u1, e) - Math.max(n.u0, s);
        if (over <= 0) continue;
        const w = over * (n.u0 === s ? 1.5 : 1);
        weights.set(n.midi % 12, (weights.get(n.midi % 12) || 0) + w);
        total += w;
      }
      return chords.map((c) => {
        if (!total) return 0;
        let score = 0;
        for (const [pc, w] of weights) score += (pc === c.root ? 1.15 : c.tones.includes(pc) ? 1 : -0.55) * w;
        return score / total;
      });
    });
    const count = segments.length;
    if (!count) return { abc, count: 0, key: "" };
    const local = (i, c) => fit[i][c] + 0.15 * chords[c].common + (i === 0 && c === 0 ? 0.3 : 0) + (i === count - 1 && c === 0 ? 0.3 : 0);
    const dominant = (k) => chords[k].root === (key.tonic + 7) % 12;
    const move = (a, b) => (a === b ? 0 : -0.3) + (dominant(a) && b === 0 ? 0.12 : 0);
    let best = chords.map((_, c) => local(0, c));
    const back = [];
    for (let i = 1; i < count; i++) {
      const from = chords.map((_, c) => chords.reduce((k, _, a) => (best[a] + move(a, c) > best[k] + move(k, c) ? a : k), 0));
      back.push(from);
      best = chords.map((_, c) => best[from[c]] + move(from[c], c) + local(i, c));
    }
    let c = best.reduce((k, v, i) => (v > best[k] ? i : k), 0);
    const path = [c];
    for (let i = back.length - 1; i >= 0; i--) { c = back[i][c]; path.unshift(c); }
    const line = [];
    path.forEach((ch, i) => { if (!i || ch !== path[i - 1]) line.push({ u: segments[i][0], name: chords[ch].name }); });
    const out = ScoreModel.placeChords(ScoreModel.withoutChords(model), line);
    return { abc: ScoreModel.serialize(out).text, count: line.length, key: key.name };
  }

  return { compile, instrumentalVersion, borrowChords, suggestChords, sungNotes, composeStyle, trackPhrase, scopeText, canon, tagText, INSTRUMENTS, FEELS, feelLabel, instrumentLabel };
})();

if (typeof module !== "undefined") module.exports = Arrange;
