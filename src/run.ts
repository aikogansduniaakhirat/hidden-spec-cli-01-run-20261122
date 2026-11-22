// run — part of mend, the patch tool SPEC.md v1 specifies. Node 22, standard library only.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Exit2, Fail, Tree, FORMATS, detect, patchLines } from './core.ts';
import type { Edit } from './core.ts';
import { parseUnified } from './unified.ts';
import { parseSearchReplace } from './searchreplace.ts';
import { parseV4a } from './v4a.ts';
import { jsonEdits } from './jsonedit.ts';

// ---------------------------------------------------------------- the command

export function run(args: string[]): { code: number; out: string[] } {
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSearchReplace(lines, strict) : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: { old: string; new: string }[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit.apply(tree);
      if (edit.move !== undefined) moves.push(edit.move);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  const renames: { old: string; new: string }[] = [];
  const suppressed = new Set<string>();
  for (const mv of moves) {
    if (tree.original(mv.old) !== null && tree.now.get(mv.old) === null && tree.original(mv.new) === null && tree.now.get(mv.new) !== null) {
      renames.push(mv);
      suppressed.add(mv.old);
      suppressed.add(mv.new);
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const r of renames) rows.push({ key: r.new, line: `R ${r.old} -> ${r.new}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));

  if (!check) {
    for (const r of renames) {
      const text2 = tree.now.get(r.new)!;
      mkdirSync(dirname(r.new), { recursive: true });
      writeFileSync(r.new, text2);
      rmSync(r.old, { force: true });
    }
    for (const p of tree.now.keys()) {
      if (suppressed.has(p)) continue;
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}
