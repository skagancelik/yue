"use strict";
// Lyrics under the vocal notes of the score.
// YuE2 does not report which syllable it sang on which note, and it takes no syllable-to-note
// input either, so this is for looking and checking only: the lyrics are split into Turkish
// syllables and laid on the vocal notes one by one, section by section ([Verse] on the score's
// "% verse" part, …). The user can move where a section starts, hold a syllable over the next
// note (melisma) or sing two syllables on one note; what does not fit shows where the lyrics
// have more or fewer syllables than the melody, which is worth fixing in the lyrics text.

const LyricsLayout = (() => {
  const VOWELS = "aeıioöuüâîûAEIİOÖUÜÂÎÛ";
  const isLetter = (ch) => /\p{L}/u.test(ch);

  // Turkish syllables: every syllable has one vowel; one consonant between vowels starts the next
  // syllable, of two or more only the last one does ("gel-mek", "kork-mak", "a-ra-ba").
  function syllables(word) {
    const letters = [...word].map((ch, i) => ({ ch, i })).filter((x) => isLetter(x.ch));
    const vowels = letters.map((x, k) => (VOWELS.includes(x.ch) ? k : -1)).filter((k) => k >= 0);
    if (vowels.length < 2) return [word];
    const cuts = [];
    for (let v = 1; v < vowels.length; v++) {
      const between = vowels[v] - vowels[v - 1] - 1;
      cuts.push(letters[vowels[v] - (between === 0 ? 0 : 1)].i);
    }
    const chars = [...word];
    return [0, ...cuts].map((start, k) => chars.slice(start, cuts[k] ?? chars.length).join(""));
  }

  const sectionName = (text) => text.toLowerCase().replace(/[^a-z]/g, "");

  // [{ name, tag, syllables: [{ text, joined }] }]; joined = the next syllable is in the same word.
  function lyricSections(lyrics) {
    const sections = [];
    let current = null;
    for (const raw of (lyrics || "").split(/\r?\n/)) {
      const tag = raw.trim().match(/^\[([^\]]+)\]$/);
      if (tag) { current = { name: sectionName(tag[1]), tag: tag[1].trim(), syllables: [] }; sections.push(current); continue; }
      // Characters that mean something on an ABC w: line are dropped.
      const words = raw.replace(/[-_*~|%\\]/g, " ").split(/\s+/).filter((w) => [...w].some(isLetter));
      if (!words.length) continue;
      if (!current) { current = { name: "", tag: "", syllables: [] }; sections.push(current); }
      for (const word of words) {
        const parts = syllables(word);
        parts.forEach((text, k) => current.syllables.push({ text, joined: k < parts.length - 1 }));
      }
    }
    return sections.filter((section) => section.syllables.length);
  }

  // The notes and rests of one ABC music line, in the order abcjs pairs them with w: tokens.
  // starts is false for the held continuation of a tie; at is the note's position in the line;
  // bar counts the line's bar lines before it ("Z4" is four bars).
  function noteSlots(line) {
    const token = /"[^"]*"|\[[A-Za-z]:[^\]]*\]|!.*?!|\||(?:\^\^|__|\^|_|=)?([A-Ga-gzxZX])[,']*([0-9]*)\/*[0-9]*(-?)/g;
    const slots = [];
    let tied = false, bar = 0, bars = 1, match;
    while ((match = token.exec(line))) {
      if (match[0] === "|") { bar += bars; bars = 1; continue; }
      if (!match[1]) continue;
      if ("zxZX".includes(match[1])) {
        if ("ZX".includes(match[1])) bars = Number(match[2] || 1);
        tied = false;
        slots.push({ rest: true, bar });
        continue;
      }
      slots.push({ starts: !tied, at: match.index, bar });
      tied = match[3] === "-";
    }
    return { slots, bars: bar };
  }

  // The saved layout of a job, or an empty one: { starts: [note or null per lyric section],
  // holds: [notes that hold the syllable before], doubles: [notes that carry two syllables] }.
  // Vocal notes are numbered from 0, tie continuations not counted.
  function normalize(saved, legacyStart) {
    const ints = (list) => (Array.isArray(list) ? list.filter((n) => Number.isInteger(n) && n >= 0) : []);
    const starts = saved && Array.isArray(saved.starts)
      ? saved.starts.map((n) => (Number.isInteger(n) && n >= 0 ? n : null))
      : legacyStart ? [legacyStart] : [];
    return { starts, holds: ints(saved && saved.holds), doubles: ints(saved && saved.doubles) };
  }

  const isEmpty = (layout) => !layout.starts.some((n) => n != null) && !layout.holds.length && !layout.doubles.length;

  // What the saved form keeps: trailing automatic starts dropped, notes sorted.
  function compact(layout) {
    const starts = [...layout.starts];
    while (starts.length && starts[starts.length - 1] == null) starts.pop();
    const sorted = (list) => [...new Set(list)].sort((a, b) => a - b);
    return { starts, holds: sorted(layout.holds), doubles: sorted(layout.doubles) };
  }

  // Lays the lyrics on the score. Returns
  //   abc: the score with a w: line under every vocal line,
  //   total / placed: syllables in the lyrics / that found a note,
  //   notes: [{ from, number, bar }] where each vocal note is in the returned text,
  //   sections: [{ tag, count, start, auto, limit, placed, spare, bar }] per lyric section,
  //   slots: [{ section, text, hold, double }] per vocal note (empty when no syllable lands on it).
  function layOut(abc, lyrics, layout = normalize(null)) {
    const lines = abc.split(/\r?\n/);
    const parts = [];   // vocal lines grouped by score section: { name, lines: [{ index, slots }] }
    let body = false, voice = "", part = null, comment = "", bar = 0;
    lines.forEach((line, index) => {
      if (!body) { if (/^K:/.test(line)) body = true; return; }
      const section = line.match(/^%\s*(.+)$/);
      if (section) { comment = sectionName(section[1]); part = null; return; }
      const voiceLine = line.match(/^V:\s*(\S+)/);
      if (voiceLine) { voice = voiceLine[1]; return; }
      if (/^[A-Za-z]:/.test(line) || !line.trim() || voice.toLowerCase() !== "vocal") return;
      const { slots, bars } = noteSlots(line);
      for (const slot of slots) slot.bar += bar;
      bar += bars;
      if (!slots.some((slot) => slot.starts)) return;
      if (!part) { part = { name: comment, lines: [] }; parts.push(part); }
      part.lines.push({ index, slots });
    });
    const noteBars = [];   // bar of every vocal note
    let number = -1;
    for (const part of parts) {
      part.first = number + 1;
      for (const line of part.lines) for (const slot of line.slots) {
        if (slot.rest) continue;
        if (slot.starts) noteBars[++number] = slot.bar;
        slot.number = number;   // a tie continuation shares the number of its note
      }
      part.end = number + 1;   // first note after the part
    }
    const count = number + 1;
    const lyricParts = lyricSections(lyrics);
    const total = lyricParts.reduce((sum, section) => sum + section.syllables.length, 0);
    const empty = { abc, placed: 0, total, notes: [], sections: [], slots: [], count };
    if (!count || !total) return empty;

    // Lyric sections go on score sections of the same name, in order; without matching names
    // each section follows the one before it from the first vocal note.
    let next = 0;
    const named = lyricParts.every((section) => section.name) && parts.some((p) => p.name);
    let matched = lyricParts.map((section) => {
      const found = named ? parts.findIndex((p, k) => k >= next && p.name === section.name) : -1;
      if (found >= 0) next = found + 1;
      return found < 0 ? null : parts[found];
    });
    if (matched.includes(null)) matched = matched.map(() => null);

    const holds = new Set(layout.holds), doubles = new Set(layout.doubles);
    const chosen = (k) => (layout.starts[k] != null && layout.starts[k] < count ? layout.starts[k] : null);
    const slots = [];
    const sections = [];
    let cursor = 0, placed = 0;
    lyricParts.forEach((section, k) => {
      const fixed = chosen(k) ?? (matched[k] ? matched[k].first : null);
      const start = Math.min(Math.max(fixed ?? cursor, cursor), count);
      // A section ends where the next placed one starts (or its score part ends); squeezed
      // between two chosen starts it may get no notes at all.
      let limit = count;
      for (let j = k + 1; j < lyricParts.length; j++) {
        const at = chosen(j) ?? (matched[j] ? matched[j].first : null);
        if (at != null) { limit = at; break; }
      }
      if (chosen(k) == null && matched[k]) limit = Math.min(limit, matched[k].end);
      const sylls = section.syllables;
      let s = 0, n = start, last = start - 1;
      for (; n < limit && s < sylls.length; n++) {
        if (holds.has(n) && n > start && slots[n - 1] && slots[n - 1].section === k) {
          slots[n] = { section: k, hold: true, text: "" };
        } else if (doubles.has(n) && s + 1 < sylls.length) {
          const [a, b] = [sylls[s], sylls[s + 1]];
          slots[n] = { section: k, double: true, text: a.text + (a.joined ? "" : "~") + b.text, joined: b.joined };
          s += 2;
        } else {
          slots[n] = { section: k, text: sylls[s].text, joined: sylls[s].joined };
          s += 1;
        }
        last = n;
      }
      // The last syllable can be held too.
      for (; n < limit && holds.has(n) && last === n - 1 && s; n++) { slots[n] = { section: k, hold: true, text: "" }; last = n; }
      placed += s;
      cursor = last + 1;
      sections.push({
        tag: section.tag || section.name, count: sylls.length, placed: s, start, limit, end: cursor, bar: noteBars[start],
        auto: chosen(k) == null, first: sylls.slice(0, 4).map((x) => x.text + (x.joined ? "" : " ")).join("").trim(),
      });
    });
    // Notes a section leaves empty before the next section starts (a following section that just
    // continues where this one stopped leaves none).
    sections.forEach((section, k) => {
      const nextSection = sections[k + 1];
      const follows = nextSection && nextSection.start === section.end && nextSection.auto && !matched[k + 1];
      section.spare = follows ? 0 : Math.max(0, section.limit - section.end);
    });

    const wLines = new Map();
    for (const part of parts) for (const { index, slots: lineSlots } of part.lines) {
      // A syllable skips rests on its own, but * and _ land on whatever comes next, rest or not:
      // a rest before one of them needs its own *.
      const tokens = lineSlots.map((slot) => {
        if (slot.rest) return null;
        const syl = slot.starts && slots[slot.number];
        if (!syl) return "* ";
        if (syl.hold) return "_ ";
        return syl.text + (syl.joined ? "-" : " ");
      });
      const out = tokens.map((token, n) => {
        if (token !== null) return token;
        const after = tokens.slice(n + 1).find((t) => t !== null);
        return after === "* " || after === "_ " ? "* " : "";
      });
      wLines.set(index, "w: " + out.join("").trim());
    }
    const slotsByLine = new Map(parts.flatMap((p) => p.lines).map((line) => [line.index, line.slots]));
    const result = [];
    const notes = [];
    let offset = 0;
    lines.forEach((line, index) => {
      for (const slot of slotsByLine.get(index) || []) {
        if (!slot.rest) notes.push({ from: offset + slot.at, number: slot.number, bar: slot.bar, starts: slot.starts });
      }
      result.push(line);
      offset += line.length + 1;
      if (wLines.has(index)) { result.push(wLines.get(index)); offset += wLines.get(index).length + 1; }
    });
    return { abc: result.join("\n"), placed, total, notes, sections, slots, count };
  }

  // Moves lyric section k to start on note n. Sections must stay in order: returns an error text
  // when n is not after the previous section's start or not before the next chosen start.
  function setStart(layout, words, k, n) {
    const prev = words.sections[k - 1];
    if (prev && n <= prev.start) return `"${words.sections[k].tag}" bölümü "${prev.tag}" bölümünden sonra başlamalı.`;
    for (let j = k + 1; j < words.sections.length; j++) {
      if (!words.sections[j].auto && n >= words.sections[j].start) return `"${words.sections[k].tag}" bölümü "${words.sections[j].tag}" bölümünden önce başlamalı.`;
    }
    const starts = [...layout.starts];
    while (starts.length <= k) starts.push(null);
    starts[k] = n;
    return { ...layout, starts };
  }

  function clearStart(layout, k) {
    const starts = [...layout.starts];
    if (k < starts.length) starts[k] = null;
    return { ...layout, starts };
  }

  // Turns a hold (the syllable before goes on over this note) or a double syllable on or off.
  function toggle(layout, kind, n) {
    const other = kind === "holds" ? "doubles" : "holds";
    const on = layout[kind].includes(n);
    return { ...layout, [kind]: on ? layout[kind].filter((x) => x !== n) : [...layout[kind], n], [other]: layout[other].filter((x) => x !== n) };
  }

  return { syllables, sectionName, lyricSections, noteSlots, normalize, isEmpty, compact, layOut, setStart, clearStart, toggle };
})();

if (typeof module !== "undefined") module.exports = LyricsLayout;
