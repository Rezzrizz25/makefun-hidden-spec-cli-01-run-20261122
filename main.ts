// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Section 3: a file's line break, its lines, and whether it ends with a break. */
function splitFile(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    final = true;
    parts.pop();
  }
  return { br, lines: parts, final };
}

function joinFile(br: string, lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** Section 5: a line as a tier reads it. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions at or after `from` where O's lines match the file's lines at a tier. */
function occurrences(fileLines: string[], o: string[], tier: number, from = 0): number[] {
  const pos: number[] = [];
  if (o.length === 0) return pos;
  const on = o.map((l) => normLine(l, tier));
  for (let i = from; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (normLine(fileLines[i + k]!, tier) !== on[k]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** First tier with an occurrence at or after `from`, or null. */
function findTier(fileLines: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(fileLines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * Replace fileLines[pos .. pos+o.length) with n. A context line (nCtx[j] is its index in O) is written as the
 * file's own matched line; at tier 2 every other line of N is re-indented from O's first line's leading
 * whitespace to the file's first matched line's.
 */
function replaceLines(fileLines: string[], pos: number, o: string[], n: string[], nCtx: (number | null)[], tier: number): string[] {
  const out = fileLines.slice(0, pos);
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = /^[ \t]*/.exec(fileLines[pos]!)![0];
    p = /^[ \t]*/.exec(o[0]!)![0];
  }
  for (let j = 0; j < n.length; j++) {
    const ci = nCtx[j]!;
    if (ci !== null) {
      out.push(fileLines[pos + ci]!);
    } else {
      const line = n[j]!;
      if (tier === 2 && line !== '' && !/^[ \t]+$/.test(line) && line.startsWith(p)) out.push(f + line.slice(p.length));
      else out.push(line);
    }
  }
  out.push(...fileLines.slice(pos + o.length));
  return out;
}

/** Body lines (unified hunks and V4A chunks) as old lines O, new lines N, and N's context map. */
function bodyToON(body: string[]): { o: string[]; n: string[]; nCtx: (number | null)[] } {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: (number | null)[] = [];
  for (const l of body) {
    if (l === '' || l.startsWith(' ')) {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push(t);
      nCtx.push(o.length - 1);
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push(l.slice(1));
      nCtx.push(null);
    }
  }
  return { o, n, nCtx };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, for the `R` output lines. */
  moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 6: unified diffs. */

interface Hunk {
  a: number;
  o: string[];
  n: string[];
  nCtx: (number | null)[];
  plus: string[];
  lastPlusNoNl: boolean;
  lastCtxPlusNoNl: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A `---`/`+++` path: up to the first tab, surrounding spaces removed, `/dev/null` is no file. */
function uniPath(raw: string): string | null {
  let s = raw.split('\t')[0]!.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
  raw: string;
}

/** A hunk's body from the line after its header; returns the body and the next line index. */
function parseHunkBody(lines: string[], i: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  const n = lines.length;
  let j = i;
  while (j < n) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '', raw: l });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1), raw: l });
      j++;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1), raw: l });
      j++;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: l.slice(1), raw: l });
      j++;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'mark', text: l, raw: l });
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
  return { body, next: j };
}

function buildHunk(a: number, body: BodyLine[]): Hunk {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: (number | null)[] = [];
  const plus: string[] = [];
  let lastPlusIdx = -1;
  let lastCtxPlusIdx = -1;
  for (let k = 0; k < body.length; k++) {
    const b = body[k]!;
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push(b.text);
      nCtx.push(o.length - 1);
      lastCtxPlusIdx = k;
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push(b.text);
      nCtx.push(null);
      plus.push(b.text);
      lastPlusIdx = k;
      lastCtxPlusIdx = k;
    }
  }
  const afterIsMark = (k: number): boolean => k >= 0 && k + 1 < body.length && body[k + 1]!.kind === 'mark';
  return { a, o, n, nCtx, plus, lastPlusNoNl: afterIsMark(lastPlusIdx), lastCtxPlusNoNl: afterIsMark(lastCtxPlusIdx) };
}

/** One section's header and hunks, from line i; returns the next line index. */
function parseUniSection(lines: string[], i: number, sec: UniSection): number {
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec.oldPath = uniPath(l.slice(4));
      sec.newPath = uniPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (l.startsWith('rename from ')) {
      sec.oldPath = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      sec.newPath = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.isCreate = true;
      i++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next } = parseHunkBody(lines, i + 1);
      sec.hunks.push(buildHunk(parseInt(m[1]!, 10), body));
      i = next;
      continue;
    }
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    i++;
  }
  return i;
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec: UniSection = { oldPath: m[1]!, newPath: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      i = parseUniSection(lines, i + 1, sec);
      sections.push(sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: UniSection = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      i = parseUniSection(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return sections;
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, errPath: string): string {
  const { br, lines: origLines, final: origFinal } = splitFile(before);
  let lines = origLines;
  let final = origFinal;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(lines, h.o, strict);
      if (found === null) throw new Fail('no-match', errPath);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + h.o.length === lines.length;
      lines = replaceLines(lines, best, h.o, h.n, h.nCtx, found.tier);
      if (atEnd) final = !h.lastCtxPlusNoNl;
      d += h.n.length - h.o.length;
    } else {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const atEnd = pos === lines.length;
      lines = [...lines.slice(0, pos), ...h.n, ...lines.slice(pos)];
      if (atEnd) final = !h.lastCtxPlusNoNl;
      d += h.n.length;
    }
  }
  return joinFile(br, lines, final);
}

function unifiedSectionEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP === null && newP === null) return;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = sec.isCreate || oldP === null;
    const isDelete = !isCreate && (sec.isDelete || newP === null);
    if (isCreate) {
      const p = newP!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plusLines: string[] = [];
      let anyPlus = false;
      let finalNoNl = false;
      for (const h of sec.hunks) {
        plusLines.push(...h.plus);
        if (h.plus.length > 0) {
          anyPlus = true;
          finalNoNl = h.lastPlusNoNl;
        }
      }
      tree.now.set(p, anyPlus ? joinFile('\n', plusLines, !finalNoNl) : '');
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const op = oldP!;
    const np = newP!;
    if (op === np) {
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      tree.now.set(op, applyHunks(before, sec.hunks, strict, op));
    } else {
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const result = applyHunks(before, sec.hunks, strict, op);
      tree.now.set(np, result);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => unifiedSectionEdit(sec, strict));
}

/** Section 7: SEARCH/REPLACE blocks. */

function searchReplaceEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinFile('\n', newLines, true));
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const { br, lines: fl, final } = splitFile(before);
    const found = findTier(fl, oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.pos.length > 1) throw new Fail('ambiguous', p);
    const out = replaceLines(fl, found.pos[0]!, oldLines, newLines, newLines.map(() => null), found.tier);
    tree.now.set(p, joinFile(br, out, final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchNo}`);
      path = prevPath;
    }
    let sep = -1;
    let k = i + 1;
    while (k < n) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
      k++;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchNo}`);
    let end = -1;
    k = sep + 1;
    while (k < n) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
      k++;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchNo}`);
    edits.push(searchReplaceEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
    prevEnd = end + 1;
    prevPath = path;
    i = end + 1;
  }
  return edits;
}

/** Section 8: V4A patches. */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');

function v4aAddEdit(p: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, joinFile('\n', fileLines, true));
  };
}

function v4aDeleteEdit(p: string): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
  };
}

function v4aUpdateEdit(p: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const { br, lines, final } = splitFile(before);
    let cur = lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(cur, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', p);
        cursor = found.pos[0]! + 1;
      }
      const { o, n, nCtx } = bodyToON(ch.body);
      if (o.length === 0) {
        const pos = ch.eof ? cur.length : cursor;
        cur = [...cur.slice(0, pos), ...n, ...cur.slice(pos)];
        cursor = pos + n.length;
      } else {
        const found = findTier(cur, o, strict, cursor);
        if (found === null) throw new Fail('no-match', p);
        let pos: number;
        if (ch.eof) {
          const ok = found.pos.filter((q) => q + o.length === cur.length);
          if (ok.length === 0) throw new Fail('no-match', p);
          pos = ok[0]!;
        } else {
          pos = found.pos[0]!;
        }
        cur = replaceLines(cur, pos, o, n, nCtx, found.tier);
        cursor = pos + n.length;
      }
    }
    const result = joinFile(br, cur, final);
    if (moveTo !== null) {
      tree.now.set(moveTo, result);
      tree.now.set(p, null);
      tree.moves.push([p, moveTo]);
    } else {
      tree.now.set(p, result);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = n - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const end = last;
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < end) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const l = lines[i]!;
    if (l.startsWith('*** Add File:')) {
      const p = l.slice('*** Add File:'.length).trim();
      i++;
      const fileLines: string[] = [];
      while (i < end && !isV4aSectionStart(lines[i]!)) {
        const x = lines[i]!;
        if (x === '') {
          fileLines.push('');
          i++;
          continue;
        }
        if (x.startsWith('+')) {
          fileLines.push(x.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(p, fileLines));
    } else if (l.startsWith('*** Delete File:')) {
      const p = l.slice('*** Delete File:'.length).trim();
      edits.push(v4aDeleteEdit(p));
      i++;
    } else if (l.startsWith('*** Update File:')) {
      const updateNo = i + 1;
      const p = l.slice('*** Update File:'.length).trim();
      i++;
      let moveTo: string | null = null;
      let j = i;
      while (j < end && blank(lines[j]!)) j++;
      if (j < end && lines[j]!.startsWith('*** Move to:')) {
        moveTo = lines[j]!.slice('*** Move to:'.length).trim();
        i = j + 1;
      } else {
        i = j;
      }
      const chunks: VChunk[] = [];
      let current: VChunk | null = null;
      while (i < end) {
        const x = lines[i]!;
        if (isV4aSectionStart(x)) break;
        if (x.startsWith('@@')) {
          if (current !== null) chunks.push(current);
          const anchor = x.slice(2).trim();
          current = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          i++;
          continue;
        }
        if (x.trim() === '*** End of File') {
          if (current === null) throw new Exit2(`error: parse ${i + 1}`);
          current.eof = true;
          chunks.push(current);
          current = null;
          i++;
          continue;
        }
        if (x === '' || x.startsWith(' ') || x.startsWith('-') || x.startsWith('+')) {
          if (current === null) {
            if (chunks.length === 0) {
              current = { anchor: null, eof: false, body: [] };
            } else if (x.trim() === '') {
              i++;
              continue;
            } else {
              throw new Exit2(`error: parse ${i + 1}`);
            }
          }
          current.body.push(x);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (current !== null) chunks.push(current);
      if (chunks.length > 0) {
        const lastC = chunks[chunks.length - 1]!;
        while (lastC.body.length > 0 && lastC.body[lastC.body.length - 1]!.trim() === '') lastC.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNo}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.slice();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Set<string>();
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.add(p);
  }
  const rows: { key: string; text: string }[] = [];
  const usedByMove = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      usedByMove.add(oldP);
      usedByMove.add(newP);
    }
  }
  for (const p of changed) {
    if (usedByMove.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const texts = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...changed].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        try {
          if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
        } catch {
          // not present, or not a directory
        }
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
