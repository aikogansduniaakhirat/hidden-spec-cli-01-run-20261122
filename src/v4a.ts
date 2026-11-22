// v4a — part of mend, the patch tool SPEC.md v1 specifies. Node 22, standard library only.
import { Exit2, Fail, Tree, safe, blank, parseFileText, serialize, normLine, buildNew, oldLinesOf } from './core.ts';
import type { Edit, FileState, BodyEntry } from './core.ts';

// ---------------------------------------------------------------- V4A patches

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyEntry[];
}

function isSecStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

export function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice(14).trim();
      i += 1;
      const body: BodyEntry[] = [];
      while (i < last && !isSecStart(lines[i]!)) {
        const c = lines[i]!;
        if (c === '') {
          body.push({ kind: ' ', text: '' });
          i += 1;
          continue;
        }
        if (c.startsWith('+')) {
          body.push({ kind: '+', text: c.slice(1) });
          i += 1;
          continue;
        }
        if (blank(c)) {
          body.push({ kind: ' ', text: '' });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      const add = body.map((e) => e.text);
      edits.push({
        apply(tree: Tree): void {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, add.length === 0 ? '' : add.join('\n') + '\n');
        },
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice(17).trim();
      i += 1;
      while (i < last && !isSecStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      edits.push({
        apply(tree: Tree): void {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) === null) throw new Fail('missing', p);
          tree.now.set(p, null);
        },
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const updateLine = i + 1;
      const p = l.slice(17).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice(13).trim();
        i += 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      while (i < last && !isSecStart(lines[i]!)) {
        const c = lines[i]!;
        if (c.startsWith('@@')) {
          const anchor = c.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunks.push(cur);
          i += 1;
          continue;
        }
        if (c.trimEnd() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.eof = true;
          i += 1;
          continue;
        }
        if (c === '' || c[0] === ' ' || c[0] === '-' || c[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push({ kind: c === '' ? ' ' : (c[0] as BodyEntry['kind']), text: c === '' ? '' : c.slice(1) });
          i += 1;
          continue;
        }
        if (blank(c)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      const from = p;
      const to = moveTo ?? p;
      edits.push({
        move: moveTo !== null ? { old: from, new: to } : undefined,
        apply(tree: Tree): void {
          if (!safe(from)) throw new Fail('unsafe', from);
          if (moveTo !== null && !safe(to)) throw new Fail('unsafe', to);
          const orig = tree.get(from);
          if (orig === null) throw new Fail('missing', from);
          if (moveTo !== null && tree.get(to) !== null) throw new Fail('exists', to);
          const f = parseFileText(orig);
          let cursor = 0;
          for (const ch of chunks) {
            if (ch.anchor !== null) {
              let found = -1;
              for (const tier of strict ? [0] : [0, 1, 2]) {
                for (let k = cursor; k < f.lines.length; k += 1) {
                  if (normLine(f.lines[k]!, tier) === normLine(ch.anchor, tier)) {
                    found = k;
                    break;
                  }
                }
                if (found >= 0) break;
              }
              if (found < 0) throw new Fail('no-match', from);
              cursor = found + 1;
            }
            const entries = ch.body;
            while (entries.length > 0) {
              const lastE = entries[entries.length - 1]!;
              if (lastE.kind === ' ' && lastE.text === '') entries.pop();
              else break;
            }
            const O = oldLinesOf(entries);
            if (O.length === 0) {
              const at = ch.eof ? f.lines.length : cursor;
              const ins: string[] = [];
              for (const e of entries) if (e.kind === '+') ins.push(e.text);
              f.lines = [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)];
              cursor = at + ins.length;
              continue;
            }
            let best = -1;
            let tierUsed = 0;
            for (const tier of strict ? [0] : [0, 1, 2]) {
              for (let k = cursor; k + O.length <= f.lines.length; k += 1) {
                let ok = true;
                for (let j = 0; j < O.length; j += 1) {
                  if (normLine(f.lines[k + j]!, tier) !== normLine(O[j]!, tier)) {
                    ok = false;
                    break;
                  }
                }
                if (ok && (!ch.eof || k + O.length === f.lines.length)) {
                  best = k;
                  tierUsed = tier;
                  break;
                }
              }
              if (best >= 0) break;
            }
            if (best < 0) throw new Fail('no-match', from);
            const repl = buildNew(f, entries, best, O[0]!, tierUsed);
            f.lines = [...f.lines.slice(0, best), ...repl, ...f.lines.slice(best + O.length)];
            cursor = best + repl.length;
          }
          if (moveTo !== null) tree.now.set(from, null);
          tree.now.set(to, serialize(f));
        },
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}
