// core — part of mend, the patch tool SPEC.md v1 specifies. Node 22, standard library only.
import { readFileSync, statSync } from 'node:fs';

export const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

export class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
export class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

export const blank = (s: string): boolean => s.trim() === '';

export function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

export function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one. */
export interface FileState {
  lines: string[];
  eol: string;
  final: boolean;
}

export function parseFileText(text: string): FileState {
  if (text === '') return { lines: [], eol: '\n', final: false };
  const nl = text.indexOf('\n');
  const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(eol);
  const lines = text.split(eol);
  if (final) lines.pop();
  return { lines, eol, final };
}

export function serialize(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.eol) + (f.final ? f.eol : '');
}

export const lead = (s: string): string => {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
};

export const normLine = (s: string, tier: number): string =>
  tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

export function occurrences(hay: string[], needle: string[], tier: number): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  for (let i = 0; i + needle.length <= hay.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (normLine(hay[i + j]!, tier) !== normLine(needle[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

export function findTier(hay: string[], needle: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(hay, needle, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One body entry of a unified hunk or a V4A chunk. */
export interface BodyEntry {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

/** The N lines of an edit, with context lines taken from the file and tier-2 re-indentation. */
export function buildNew(file: FileState, entries: BodyEntry[], start: number, oFirst: string, tier: number): string[] {
  const out: string[] = [];
  const F = lead(file.lines[start]!);
  const P = lead(oFirst);
  let oi = 0;
  for (const e of entries) {
    if (e.kind === ' ') {
      out.push(file.lines[start + oi]!);
      oi += 1;
    } else if (e.kind === '-') {
      oi += 1;
    } else if (e.kind === '+') {
      let t = e.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

export const oldLinesOf = (entries: BodyEntry[]): string[] => entries.filter((e) => e.kind === ' ' || e.kind === '-').map((e) => e.text);

/** True when a `\` line follows the last context or `+` line of a body. */
export function noNewlineAtEnd(entries: BodyEntry[]): boolean {
  let last = -1;
  entries.forEach((e, i) => {
    if (e.kind === ' ' || e.kind === '+') last = i;
  });
  return last >= 0 && entries[last + 1]?.kind === '\\';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
export class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

export interface Edit {
  apply(tree: Tree): void;
  move?: { old: string; new: string };
}

/**
 * The format a patch is in, tried in SPEC.md section 4's order: a `*** Begin Patch`
 * first line is v4a; a first non-blank line opening with `[` or `{` is json; any
 * `<<<<<<< SEARCH` line is search-replace; any `diff --git ` line, or a `--- ` line
 * followed by `+++ `, is unified. Null when none holds, which is `error: format`.
 */
export function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}
