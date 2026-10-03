"use strict";
// Putting the lyrics on the vocal notes, for the timeline editor.
//
// autoAlign: a first layout that follows the melody's phrases. The vocal notes are cut into phrases
// where the singer breathes (a rest of an eighth or more) and where a score section starts; the
// lyric lines are then matched to the phrases in order (dynamic programming), a line taking one to
// four phrases or two short lines sharing one, a phrase left out when no line fits it (a hummed or
// played part). A lyric section that starts where the score has a section of the same name is
// preferred. Inside a line the syllables go one per note from the start of each phrase.
//
// flow: what a drag does. The moved syllables are laid on the notes from the drop point one per
// note (or keep their spacing); syllables they run into are pushed along instead of blocking the
// move, and pushed past the last note they go on no note.

const Align = (() => {
  const sectionName = (text) => LyricsLayout.sectionName(text);

  // [{ gs: [syllable indices], section, first }]: the lyric lines that have syllables.
  function lyricLines(lyrics) {
    const sylls = LyricsLayout.allSyllables(lyrics);
    const starts = [0];
    for (let i = 0; i < lyrics.length; i++) if (lyrics[i] === "\n") starts.push(i + 1);
    const lineAt = (offset) => {
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
      return lo;
    };
    const lines = [];
    let last = null;
    sylls.forEach((syl, g) => {
      const line = lineAt(syl.from);
      if (!last || last.line !== line) {
        last = { line, gs: [], section: syl.section, first: !lines.length || lines[lines.length - 1].section !== syl.section };
        lines.push(last);
      }
      last.gs.push(g);
    });
    return { lines, sylls };
  }

  // [{ notes: [vocal note numbers], name }]: name = the score section the phrase starts, when it is
  // the first sung phrase of that section.
  function phrases(tl) {
    const minGap = Math.max(1, tl.unit / 8);
    const cuts = tl.sections.map((s) => ({ u: tl.bars[s.from].u0, name: sectionName(s.label || "") }));
    const sectionAt = (u) => { let k = 0; cuts.forEach((c, i) => { if (c.u <= u) k = i; }); return k; };
    const out = [];
    let current = null;
    tl.vocal.forEach((note, i) => {
      const prev = tl.vocal[i - 1];
      const k = sectionAt(note.u0);
      const newSection = !prev || sectionAt(prev.u0) !== k;
      if (!prev || newSection || note.u0 - prev.u1 >= minGap) {
        current = { notes: [], name: newSection && cuts.length ? cuts[k].name || null : null };
        out.push(current);
      }
      current.notes.push(note.number);
    });
    return out;
  }

  // How badly s syllables fit n notes: more syllables than notes means two on a note (worse).
  const fit = (s, n) => (s > n ? (s - n) * 1.6 : (n - s) * 0.5);

  function autoAlign(tl, lyrics) {
    const { lines, sylls } = lyricLines(lyrics || "");
    const map = new Array(sylls.length).fill(null);
    const ps = phrases(tl);
    if (!lines.length || !ps.length) return map;
    const names = LyricsLayout.lyricSections(lyrics).map((s) => s.name);
    const L = lines.length, P = ps.length;
    const size = (i) => lines[i].gs.length;
    const notes = (j, k) => { let n = 0; for (let x = j; x < j + k; x++) n += ps[x].notes.length; return n; };
    const bonus = (i, j) => {
      if (!lines[i].first) return 0;
      const name = names[lines[i].section];
      if (ps[j].name && name && ps[j].name === name) return -2.5;
      return ps[j].name ? -0.5 : 0.3;
    };
    const skip = (i, j) => (i === 0 || i === L ? 0.3 : 1) * ps[j].notes.length + (i === 0 || i === L ? 0 : 1);
    const INF = Infinity;
    const dp = Array.from({ length: L + 1 }, () => new Array(P + 1).fill(INF));
    const back = Array.from({ length: L + 1 }, () => new Array(P + 1).fill(null));
    dp[0][0] = 0;
    const relax = (i, j, cost, step) => { if (cost < dp[i][j]) { dp[i][j] = cost; back[i][j] = step; } };
    for (let i = 0; i <= L; i++) {
      for (let j = 0; j <= P; j++) {
        const here = dp[i][j];
        if (here === INF) continue;
        if (j < P) relax(i, j + 1, here + skip(i, j), { type: "skip", i, j });
        if (i < L) {
          for (let k = 1; k <= 4 && j + k <= P; k++) {
            relax(i + 1, j + k, here + fit(size(i), notes(j, k)) + 0.7 * (k - 1) + bonus(i, j), { type: "line", i, j, k });
          }
        }
        if (i + 1 < L && j < P && lines[i].section === lines[i + 1].section) {
          relax(i + 2, j + 1, here + fit(size(i) + size(i + 1), notes(j, 1)) + 1.2 + bonus(i, j), { type: "pair", i, j });
        }
      }
    }
    const steps = [];
    for (let i = L, j = P; i || j;) {
      const step = back[i][j];
      if (!step) break;
      steps.push(step);
      i = step.i;
      j = step.j;
    }
    for (const step of steps.reverse()) {
      if (step.type === "skip") continue;
      const gs = step.type === "pair" ? [...lines[step.i].gs, ...lines[step.i + 1].gs] : lines[step.i].gs;
      const groups = ps.slice(step.j, step.j + (step.k || 1)).map((p) => p.notes);
      place(map, gs, groups);
    }
    return map;
  }

  // Syllables gs on the phrases' notes: shared out in proportion to the phrases' lengths, one per
  // note from each phrase's start; with too few notes, two syllables share some notes.
  function place(map, gs, groups) {
    const all = groups.flat();
    const s = gs.length, n = all.length;
    if (s > n) { gs.forEach((g, i) => { map[g] = all[n === 1 ? 0 : Math.round((i * (n - 1)) / (s - 1))]; }); return; }
    const counts = groups.map((p) => Math.min(p.length, Math.round((s * p.length) / n)));
    let diff = s - counts.reduce((a, b) => a + b, 0);
    for (let p = 0; diff > 0 && p < groups.length; p = (p + 1) % groups.length) {
      if (counts[p] < groups[p].length) { counts[p]++; diff--; }
    }
    for (let p = groups.length - 1; diff < 0; p = (p - 1 + groups.length) % groups.length) {
      if (counts[p] > 0) { counts[p]--; diff++; }
    }
    let k = 0;
    groups.forEach((p, i) => { for (let x = 0; x < counts[i]; x++) map[gs[k++]] = p[x]; });
  }

  // The syllables of the word syllable g is in.
  function wordOf(sylls, g) {
    let a = g, b = g;
    while (a > 0 && sylls[a - 1].joined) a--;
    while (b < sylls.length - 1 && sylls[b].joined) b++;
    return range(a, b);
  }

  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k);

  // Lays syllables gs (in order; the span between the first and the last moves as one) on the
  // notes from note start: one per note, or with keepShape their old distances (two on one note stay
  // together). Others that are in the way are pushed along. Returns { map, pushed, lost } or an
  // error text.
  function flow(map, gs, start, count, keepShape = false) {
    if (!gs.length) return "Önce hece seç.";
    const span = range(Math.min(...gs), Math.max(...gs));
    const out = [...map];
    const base = span.map((g) => map[g]).find((n) => n != null);
    let prev = null;
    span.forEach((g, i) => {
      let n;
      if (!keepShape || base == null) n = start + i;
      else if (map[g] == null) n = prev == null ? start : prev + 1;
      else {
        n = start + map[g] - base;
        const shared = i > 0 && map[g - 1] != null && map[g - 1] === map[g];
        if (prev != null) n = shared ? Math.max(n, prev) : Math.max(n, prev + 1);
      }
      out[g] = n;
      prev = n;
    });
    if (out[span[0]] < 0) return "Bu kadar sola sığmıyor.";
    if (out[span[span.length - 1]] >= count) return "Seçili heceler buradan sonra notalara sığmıyor; daha sola bırak.";
    let pushed = 0, lost = 0;
    // To the right: each later syllable must come after the one before it.
    let last = out[span[span.length - 1]];
    for (let g = span[span.length - 1] + 1; g < out.length; g++) {
      if (out[g] == null) continue;
      if (out[g] > last) break;
      pushed++;
      if (last + 1 >= count) { out[g] = null; lost++; continue; }
      out[g] = last = last + 1;
    }
    // To the left: each earlier syllable must come before the one after it.
    let next = out[span[0]];
    for (let g = span[0] - 1; g >= 0; g--) {
      if (out[g] == null) continue;
      if (out[g] < next) break;
      pushed++;
      if (next - 1 < 0) { out[g] = null; lost++; continue; }
      out[g] = next = next - 1;
    }
    return { map: out, pushed, lost };
  }

  return { autoAlign, phrases, lyricLines, flow, wordOf, range };
})();

if (typeof module !== "undefined") module.exports = Align;
