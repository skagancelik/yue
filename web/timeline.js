"use strict";
// The score on a time axis for the timeline editor: when every bar, section, note and rest starts
// and ends, in seconds (from the score's Q: tempo) and in L: units from the start of the song, so
// the editor can draw it left to right and a playhead can follow the melody synth. Vocal notes are
// numbered like LyricsLayout numbers them (a tied continuation belongs to the note it continues).
// Syllables are saved by the unit their note starts on, so they find their notes again after the
// score is edited (notes split, merged or moved to the other voice).

const Timeline = (() => {
  function fromModel(model) {
    const field = (name) => (model.header.find((l) => l.startsWith(name + ":")) || "").slice(name.length + 1).trim();
    const unit = Number(field("L").split("/")[1]) || 8;
    // Q:1/4=109 → 109 quarter notes a minute; a bare number counts quarters too.
    const tempo = field("Q").match(/^(?:(\d+)\/(\d+)\s*=\s*)?(\d+(?:\.\d+)?)$/);
    const beat = tempo && tempo[1] ? Number(tempo[1]) / Number(tempo[2]) : 1 / 4;
    const bpm = tempo ? Number(tempo[3]) : 120;
    const perUnit = 60 / bpm / beat / unit;   // seconds per L: unit

    const voices = {}, rests = {};
    const bars = [];
    for (const voice of ["vocal", "ins"]) {
      const notes = [], pauses = [];
      let u = 0, number = -1;
      const all = ScoreModel.voiceNotes(model, voice);
      const error = all.find((bar) => bar.error);
      if (error) throw new Error(error.error);
      all.forEach((bar, b) => {
        if (voice === "vocal") bars.push({ u0: u, u1: u + bar.units, t0: u * perUnit, t1: (u + bar.units) * perUnit, units: bar.units });
        bar.notes.forEach((note, k) => {
          const u0 = u, u1 = u + note.dur;
          u = u1;
          const item = { voice, bar: b, k, u0, u1, t0: u0 * perUnit, t1: u1 * perUnit, dur: note.dur };
          if (note.rest) { pauses.push(item); return; }
          const last = notes[notes.length - 1];
          if (note.contIn && last) { last.u1 = u1; last.t1 = item.t1; return; }
          notes.push({ ...item, number: ++number, midi: note.midi, name: ScoreModel.pitchName(note) });
        });
      });
      voices[voice] = notes;
      rests[voice] = pauses;
    }
    const duration = bars.length ? bars[bars.length - 1].t1 : 0;
    const sections = ScoreModel.sections(model).map((run) => ({
      label: run.label || "", sung: run.sung, pickup: run.pickup, t0: bars[run.from].t0, t1: bars[run.to].t1, from: run.from, to: run.to,
    }));
    return { vocal: voices.vocal, ins: voices.ins, rests, bars, sections, duration, bpm, unit, perUnit };
  }

  const build = (abc) => fromModel(ScoreModel.parse(abc));

  // The unit every syllable's note starts on (null = on no note).
  const onsets = (tl, map) => map.map((n) => (n == null || !tl.vocal[n] ? null : tl.vocal[n].u0));

  // Syllables back on notes: the vocal note starting on the same unit, else the one sounding then.
  // When that one carries the syllable before (a note before it was lengthened), the syllable takes
  // the next note if it starts before the next syllable's. Syllables keep their order; one that
  // would land on a note an earlier syllable took (and did not share before) goes on no note.
  function mapFromOnsets(tl, at) {
    const starting = new Map(tl.vocal.map((n) => [n.u0, n.number]));
    let last = -1, lastAt = null;
    return at.map((u, g) => {
      if (u == null) return null;
      let n = starting.get(u);
      if (n == null) {
        const cover = tl.vocal.find((v) => v.u0 <= u && u < v.u1);
        n = cover ? cover.number : null;
        const next = tl.vocal[last + 1], nextAt = at.slice(g + 1).find((x) => x != null);
        if (n != null && n === last && next && (nextAt == null || next.u0 < nextAt)) n = next.number;
      }
      if (n == null || n < last || (n === last && u !== lastAt)) return null;
      last = n;
      lastAt = u;
      return n;
    });
  }

  return { build, fromModel, onsets, mapFromOnsets };
})();

if (typeof module !== "undefined") module.exports = Timeline;
