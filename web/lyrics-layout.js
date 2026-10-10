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

  // [{ name, tag, syllables: [{ text, joined, from, to, index }] }]; joined = the next syllable is
  // in the same word; from/to = where it is in the lyrics text; index counts all syllables from 0.
  function lyricSections(lyrics) {
    const sections = [];
    let current = null, offset = 0, index = 0;
    for (const raw of (lyrics || "").split("\n")) {
      const lineStart = offset;
      offset += raw.length + 1;
      const tag = raw.trim().match(/^\[([^\]]+)\]$/);
      if (tag) { current = { name: sectionName(tag[1]), tag: tag[1].trim(), syllables: [] }; sections.push(current); continue; }
      // Characters that mean something on an ABC w: line are dropped.
      const words = [...raw.replace(/[-_*~|%\\\r]/g, " ").matchAll(/\S+/g)].filter((m) => [...m[0]].some(isLetter));
      if (!words.length) continue;
      if (!current) { current = { name: "", tag: "", syllables: [] }; sections.push(current); }
      for (const word of words) {
        let at = lineStart + word.index;
        const parts = syllables(word[0]);
        parts.forEach((text, k) => {
          current.syllables.push({ text, joined: k < parts.length - 1, from: at, to: at + text.length, index: index++ });
          at += text.length;
        });
      }
    }
    return sections.filter((section) => section.syllables.length);
  }

  const allSyllables = (lyrics) => lyricSections(lyrics).flatMap((section, k) => section.syllables.map((syl) => ({ ...syl, section: k })));

  // The notes and rests of one ABC music line, in the order abcjs pairs them with w: tokens.
  // starts is false for the held continuation of a tie; at is the note's position in the line;
  // bar counts the line's bar lines before it ("Z4" is four bars). tiedIn: the line starts by
  // continuing a note tied over from the voice's previous line.
  function noteSlots(line, tiedIn = false) {
    const token = /"[^"]*"|\[[A-Za-z]:[^\]]*\]|!.*?!|\||(?:\^\^|__|\^|_|=)?([A-Ga-gzxZX])[,']*([0-9]*)\/*[0-9]*(-?)/g;
    const slots = [];
    let tied = tiedIn, bar = 0, bars = 1, match;
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
    return { slots, bars: bar, tied };
  }

  // The saved layout of a job, or an empty one: { starts: [note or null per lyric section],
  // holds: [notes that hold the syllable before], doubles: [notes that carry two syllables] }.
  // Vocal notes are numbered from 0, tie continuations not counted.
  // The timeline editor saves instead map: the note of every syllable (null = on no note), and
  // lyrics: the arrangement's lyrics with corrected letters, when they were changed.
  function normalize(saved, legacyStart) {
    const ints = (list) => (Array.isArray(list) ? list.filter((n) => Number.isInteger(n) && n >= 0) : []);
    const starts = saved && Array.isArray(saved.starts)
      ? saved.starts.map((n) => (Number.isInteger(n) && n >= 0 ? n : null))
      : legacyStart ? [legacyStart] : [];
    const layout = { starts, holds: ints(saved && saved.holds), doubles: ints(saved && saved.doubles) };
    if (saved && Array.isArray(saved.at)) layout.at = saved.at.map((u) => (Number.isInteger(u) && u >= 0 ? u : null));
    if (saved && Array.isArray(saved.map)) layout.map = saved.map.map((n) => (Number.isInteger(n) && n >= 0 ? n : null));
    if (saved && typeof saved.lyrics === "string") layout.lyrics = saved.lyrics;
    return layout;
  }

  const isEmpty = (layout) => !layout.map && !layout.at && layout.lyrics == null
    && !layout.starts.some((n) => n != null) && !layout.holds.length && !layout.doubles.length;

  // What the saved form keeps: trailing automatic starts dropped, notes sorted.
  function compact(layout) {
    if (layout.at) return layout.lyrics == null ? { at: layout.at } : { at: layout.at, lyrics: layout.lyrics };
    if (layout.map) return layout.lyrics == null ? { map: layout.map } : { map: layout.map, lyrics: layout.lyrics };
    const starts = [...layout.starts];
    while (starts.length && starts[starts.length - 1] == null) starts.pop();
    const sorted = (list) => [...new Set(list)].sort((a, b) => a - b);
    return { starts, holds: sorted(layout.holds), doubles: sorted(layout.doubles) };
  }

  // Syllables on the notes the map gives them. Two syllables on one note are sung together; an
  // empty note between two syllables of the same section holds the syllable before it.
  function placeByMap(lyricParts, map, count, slots, sections, noteBars) {
    let g = 0;
    lyricParts.forEach((section, k) => {
      let placed = 0, first = count, end = 0;
      for (const syl of section.syllables) {
        const n = map[g++];
        if (n == null || n >= count) continue;
        placed++;
        first = Math.min(first, n);
        end = Math.max(end, n + 1);
        const slot = slots[n];
        if (slot) {
          slot.text += (slot.joined ? "" : "~") + syl.text;
          slot.joined = syl.joined;
          slot.double = true;
          slot.index.push(syl.index);
        } else slots[n] = { section: k, text: syl.text, joined: syl.joined, index: [syl.index] };
      }
      sections.push({
        tag: section.tag || section.name, count: section.syllables.length, placed, start: first, end: placed ? end : first,
        limit: count, bar: noteBars[first], auto: false, spare: 0,
        first: section.syllables.slice(0, 4).map((x) => x.text + (x.joined ? "" : " ")).join("").trim(),
      });
    });
    let previous = null;
    for (let n = 0; n < count; n++) {
      if (slots[n]) { previous = slots[n]; continue; }
      const next = slots.slice(n + 1).find(Boolean);
      if (previous && next && previous.section === next.section) slots[n] = { section: previous.section, hold: true, text: "" };
    }
    sections.forEach((section, k) => {
      const next = sections.slice(k + 1).find((s) => s.placed);
      let spare = 0;
      for (let n = section.end; n < (next ? next.start : count); n++) if (!slots[n]) spare++;
      section.spare = section.placed ? spare : 0;
    });
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
    let body = false, voice = "", part = null, comment = "", bar = 0, tied = false;
    lines.forEach((line, index) => {
      if (!body) { if (/^K:/.test(line)) body = true; return; }
      const section = line.match(/^%\s*(.+)$/);
      if (section) { comment = sectionName(section[1]); part = null; return; }
      const voiceLine = line.match(/^V:\s*(\S+)/);
      if (voiceLine) { voice = voiceLine[1]; return; }
      if (/^[A-Za-z]:/.test(line) || !line.trim() || voice.toLowerCase() !== "vocal") return;
      const { slots, bars, tied: tiedOut } = noteSlots(line, tied);
      tied = tiedOut;
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

    const map = layout.map && layout.map.length === total ? layout.map : null;
    const holds = new Set(layout.holds), doubles = new Set(layout.doubles);
    const chosen = (k) => (layout.starts[k] != null && layout.starts[k] < count ? layout.starts[k] : null);
    const slots = [];
    const sections = [];
    let cursor = 0, placed = 0, base = 0;
    if (map) {
      placeByMap(lyricParts, map, count, slots, sections, noteBars);
      placed = sections.reduce((sum, section) => sum + section.placed, 0);
    }
    if (!map) lyricParts.forEach((section, k) => {
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
          slots[n] = { section: k, double: true, text: a.text + (a.joined ? "" : "~") + b.text, joined: b.joined, index: [base + s, base + s + 1] };
          s += 2;
        } else {
          slots[n] = { section: k, text: sylls[s].text, joined: sylls[s].joined, index: [base + s] };
          s += 1;
        }
        last = n;
      }
      // The last syllable can be held too.
      for (; n < limit && holds.has(n) && last === n - 1 && s; n++) { slots[n] = { section: k, hold: true, text: "" }; last = n; }
      placed += s;
      base += sylls.length;
      cursor = last + 1;
      sections.push({
        tag: section.tag || section.name, count: sylls.length, placed: s, start, limit, end: cursor, bar: noteBars[start],
        auto: chosen(k) == null, first: sylls.slice(0, 4).map((x) => x.text + (x.joined ? "" : " ")).join("").trim(),
      });
    });
    // Notes a section leaves empty before the next section starts (a following section that just
    // continues where this one stopped leaves none).
    if (!map) sections.forEach((section, k) => {
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

  // The note of every syllable as the layout puts it (null = on no note).
  function toMap(words, total) {
    const map = new Array(total).fill(null);
    words.slots.forEach((slot, n) => { if (slot && slot.index) for (const g of slot.index) map[g] = n; });
    return map;
  }

  // A syllable map is valid when every syllable is on an existing note and the order of the
  // syllables never goes back (two syllables may share a note).
  function checkMap(map, count) {
    let last = -1;
    for (const n of map) {
      if (n == null) continue;
      if (n < 0 || n >= count) return "Bu kadar kaydırınca hece notaların dışına çıkıyor.";
      if (n < last) return "Heceler birbirinin üzerinden atlayamaz; sıraları değişmez.";
      last = n;
    }
    return null;
  }

  // Moves the selected syllables by delta notes. Only they move: one that would land on a note
  // another syllable sits on, or pass it, stops the move (an error text is returned).
  function moveSyllables(map, selected, delta, count) {
    const out = map.map((n, g) => (selected.has(g) && n != null ? n + delta : n));
    const taken = new Set(map.filter((n, g) => n != null && !selected.has(g)));
    if (out.some((n, g) => selected.has(g) && n != null && taken.has(n))) return "Orada başka bir hece var; önce onu kaydır.";
    return checkMap(out, count) || out;
  }

  // Puts one syllable (that was on no note) on note n.
  function placeSyllable(map, g, n, count) {
    if (map.some((m, j) => j !== g && m === n)) return "Bu notada zaten bir hece var.";
    const out = [...map];
    out[g] = n;
    return checkMap(out, count) || out;
  }

  // Replaces the letters of syllable g in the lyrics ("" deletes it). The map keeps every other
  // syllable on its note; when the new letters make more syllables, the extra ones go on the
  // following empty notes (or on no note when there is no room).
  function editSyllable(lyrics, map, g, text, count) {
    const before = allSyllables(lyrics);
    const syl = before[g];
    const next = lyrics.slice(0, syl.from) + text + lyrics.slice(syl.to);
    const grown = allSyllables(next).length - before.length;
    const made = Math.max(0, 1 + grown);
    const out = map.slice(0, g);
    const after = map.slice(g + 1 + Math.max(0, -grown - 1));
    const limit = after.find((n) => n != null) ?? count;
    for (let k = 0; k < made; k++) {
      const n = k === 0 ? map[g] : out[out.length - 1] != null && out[out.length - 1] + 1 < limit ? out[out.length - 1] + 1 : null;
      out.push(n);
    }
    return { lyrics: next, map: out.concat(after) };
  }

  // Lyrics `text` put in where note `notes[0]` is sung: after the syllables on notes before it (at
  // the end of their section when the next syllable starts another one, on a line of its own when
  // the next one starts a line). Its syllables go on `notes` in order (null for any more there are).
  // `map` must already count the new notes. Returns { lyrics, map }.
  function insertSyllables(lyrics, map, text, notes) {
    const syls = allSyllables(lyrics);
    const n = notes.find((x) => x != null);
    let i = 0;
    map.forEach((m, g) => { if (m != null && m < n) i = g + 1; });
    const prev = syls[i - 1], next = syls[i];
    const lineStart = (pos) => lyrics.lastIndexOf("\n", pos - 1) + 1;
    let pos, piece;
    if (next && (!prev || prev.section === next.section)) {
      const start = lineStart(next.from);
      if (![...lyrics.slice(start, next.from)].some(isLetter)) { pos = start; piece = text + "\n"; }
      else { pos = next.from; piece = (/\s/.test(lyrics[pos - 1]) ? "" : " ") + text + " "; }
    } else if (prev) {
      pos = prev.to;
      piece = "\n" + text;
    } else {
      pos = lyrics.length;
      piece = (lyrics.trim() ? "\n" : "") + text;
    }
    const out = lyrics.slice(0, pos) + piece + lyrics.slice(pos);
    const added = allSyllables(out).length - syls.length;
    const put = Array.from({ length: Math.max(0, added) }, (_, k) => notes[k] ?? null);
    return { lyrics: out, map: [...map.slice(0, i), ...put, ...map.slice(i)] };
  }

  // Syllables first..last (widened to whole words) made one lyric section tagged `tag`: tags inside
  // go, the section they start in is split before them (or retagged when they start it) and the
  // one they end in goes on after them under its old tag. Syllables stay where they are.
  function retag(lyrics, first, last, tag) {
    const syls = allSyllables(lyrics);
    if (!syls[first] || !syls[last]) return lyrics;
    const sections = lyricSections(lyrics);
    let a = first, z = last;
    while (a > 0 && syls[a - 1].joined) a--;
    while (z < syls.length - 1 && syls[z].joined) z++;
    const start = syls[a].from, end = syls[z].to;
    const tags = [];
    let offset = 0;
    for (const line of lyrics.split("\n")) {
      if (/^\s*\[[^\]]+\]\s*$/.test(line)) tags.push({ from: offset, to: Math.min(lyrics.length, offset + line.length + 1) });
      offset += line.length + 1;
    }
    const edits = [];   // [from, to, text]
    const after = syls[z + 1];
    // Spaces next to a line break that is put in go.
    const spacesAfter = (pos) => { while (pos < lyrics.length && /[ \t]/.test(lyrics[pos])) pos++; return pos; };
    const spacesBefore = (pos) => { while (pos > 0 && /[ \t]/.test(lyrics[pos - 1])) pos--; return pos; };
    // A section next to them with the same name becomes one with them.
    const same = (k) => k != null && sectionName(sections[k].tag) === sectionName(tag);
    const tagBetween = (from, to) => tags.filter((t) => t.from >= from && t.from < to).pop();
    if (after && after.section === syls[z].section) {
      const old = sections[syls[z].section].tag;
      if (old && !same(after.section)) {
        const to = spacesAfter(end);
        edits.push([end, to, lyrics[to] === "\n" ? `\n[${old}]` : `\n[${old}]\n`]);
      }
    } else if (after && same(after.section)) {
      const t = tagBetween(end, after.from);
      if (t) edits.push([t.from, t.to, ""]);
    }
    for (const t of tags) if (t.from > start && t.from < end) edits.push([t.from, t.to, ""]);
    const lineStart = lyrics.lastIndexOf("\n", start - 1) + 1;
    const before = syls[a - 1];
    if (!before || before.section !== syls[a].section) {
      const own = tagBetween(before ? before.to : 0, start);
      if (before && same(before.section)) { if (own) edits.push([own.from, own.to, ""]); }
      else if (own) edits.push([own.from, own.to, `[${tag}]\n`]);
      else edits.push([lineStart, lineStart, `[${tag}]\n`]);
    } else if (!same(syls[a].section)) {
      if (![...lyrics.slice(lineStart, start)].some(isLetter)) edits.push([lineStart, lineStart, `[${tag}]\n`]);
      else edits.push([spacesBefore(start), start, `\n[${tag}]\n`]);
    }
    let out = lyrics;
    for (const [from, to, text] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, from) + text + out.slice(to);
    return out;
  }

  return { syllables, sectionName, lyricSections, allSyllables, noteSlots, normalize, isEmpty, compact, layOut, toMap, checkMap, moveSyllables, placeSyllable, editSyllable, insertSyllables, retag };
})();

if (typeof module !== "undefined") module.exports = LyricsLayout;
