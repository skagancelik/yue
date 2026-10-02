"use strict";
// The score on a time axis for the timeline editor: when every bar, section and note starts and
// ends in seconds (from the score's Q: tempo), so the editor can draw it left to right and a
// playhead can follow the melody synth. Vocal notes are numbered like LyricsLayout numbers them
// (a tied continuation belongs to the note it continues).

const Timeline = (() => {
  function build(abc) {
    const model = ScoreModel.parse(abc);
    const field = (name) => (model.header.find((l) => l.startsWith(name + ":")) || "").slice(name.length + 1).trim();
    const unit = Number(field("L").split("/")[1]) || 8;
    // Q:1/4=109 → 109 quarter notes a minute; a bare number counts quarters too.
    const tempo = field("Q").match(/^(?:(\d+)\/(\d+)\s*=\s*)?(\d+(?:\.\d+)?)$/);
    const beat = tempo && tempo[1] ? Number(tempo[1]) / Number(tempo[2]) : 1 / 4;
    const bpm = tempo ? Number(tempo[3]) : 120;
    const perUnit = 60 / bpm / beat / unit;   // seconds per L: unit

    const voices = {};
    let bars = [];
    for (const voice of ["vocal", "ins"]) {
      const notes = [];
      let t = 0, number = -1;
      const all = ScoreModel.voiceNotes(model, voice);
      const error = all.find((bar) => bar.error);
      if (error) throw new Error(error.error);
      all.forEach((bar, b) => {
        if (voice === "vocal") bars.push({ t0: t, t1: t + bar.units * perUnit, number: b });
        for (const note of bar.notes) {
          const t0 = t, t1 = t + note.dur * perUnit;
          t = t1;
          if (note.rest) continue;
          const last = notes[notes.length - 1];
          if (note.contIn && last) { last.t1 = t1; continue; }
          notes.push({ number: ++number, t0, t1, midi: note.midi, bar: b, name: ScoreModel.pitchName(note) });
        }
      });
      voices[voice] = notes;
    }
    const duration = bars.length ? bars[bars.length - 1].t1 : 0;
    const sections = ScoreModel.sections(model).map((run) => ({
      label: run.label || "", sung: run.sung, t0: bars[run.from].t0, t1: bars[run.to].t1, from: run.from, to: run.to,
    }));
    return { vocal: voices.vocal, ins: voices.ins, bars, sections, duration, bpm };
  }

  return { build };
})();

if (typeof module !== "undefined") module.exports = Timeline;
