// searchreplace — part of mend, the patch tool SPEC.md v1 specifies. Node 22, standard library only.
import { Exit2, Fail, Tree, safe, parseFileText, serialize, lead, findTier } from './core.ts';
import type { Edit } from './core.ts';

// ---------------------------------------------------------------- SEARCH/REPLACE

export function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let floor = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let p: string | null = null;
    for (let k = i - 1; k >= floor; k -= 1) {
      const c = lines[k]!;
      if (c.trim() === '') continue;
      if (c.trim().startsWith('```')) continue;
      p = c.trim();
      break;
    }
    if (p === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
      p = prevPath;
    }
    let sep = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${i + 1}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const path = p;
    if (oldLines.length === 0) {
      edits.push({
        apply(tree: Tree): void {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) !== null) throw new Fail('exists', path);
          tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        },
      });
    } else {
      edits.push({
        apply(tree: Tree): void {
          if (!safe(path)) throw new Fail('unsafe', path);
          const orig = tree.get(path);
          if (orig === null) throw new Fail('missing', path);
          const f = parseFileText(orig);
          const found = findTier(f.lines, oldLines, strict);
          if (found === null) throw new Fail('no-match', path);
          if (found.occ.length > 1) throw new Fail('ambiguous', path);
          const at = found.occ[0]!;
          const F = lead(f.lines[at]!);
          const P = lead(oldLines[0]!);
          const repl = newLines.map((t) => (found.tier === 2 && t.trim() !== '' && t.startsWith(P) ? F + t.slice(P.length) : t));
          f.lines = [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + oldLines.length)];
          tree.now.set(path, serialize(f));
        },
      });
    }
    prevPath = p;
    floor = end + 1;
    i = end + 1;
  }
  return edits;
}
