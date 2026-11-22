// unified — part of mend, the patch tool SPEC.md v1 specifies. Node 22, standard library only.
import { Exit2, Fail, Tree, safe, parseFileText, serialize, lead, findTier, buildNew, oldLinesOf, noNewlineAtEnd } from './core.ts';
import type { Edit, FileState, BodyEntry } from './core.ts';

// ---------------------------------------------------------------- unified diffs

interface Hunk {
  a: number;
  body: BodyEntry[];
}

interface Sec {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  diffA: string | null;
  diffB: string | null;
  newMode: boolean;
  delMode: boolean;
  hunks: Hunk[];
  headerDone: boolean;
}

const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** The path a `--- ` or `+++ ` line names; null for `/dev/null`. */
function pairPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  if (p === '/dev/null') return null;
  return stripAB(p);
}

export function parseUnified(lines: string[], strict: boolean): Edit[] {
  const secs: Sec[] = [];
  let cur: Sec | null = null;
  let hunk: Hunk | null = null;
  const trimBody = (h: Hunk): void => {
    while (h.body.length > 0) {
      const e = h.body[h.body.length - 1]!;
      if (e.kind === ' ' && e.text === '') h.body.pop();
      else break;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const nxt = lines[i + 1] ?? '';
    if (l.startsWith('diff --git ')) {
      if (hunk !== null) {
        trimBody(hunk);
        hunk = null;
      }
      // `trim().split(/\s+/)` yields no empty tokens, so two tokens are both non-empty.
      const toks = l.slice(11).trim().split(/\s+/);
      if (toks.length !== 2) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        oldPath: null,
        newPath: null,
        hasPair: false,
        renameFrom: null,
        renameTo: null,
        diffA: stripAB(toks[0]!),
        diffB: stripAB(toks[1]!),
        newMode: false,
        delMode: false,
        hunks: [],
        headerDone: false,
      };
      secs.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && nxt.startsWith('+++ ')) {
      if (hunk !== null) {
        trimBody(hunk);
        hunk = null;
      }
      if (cur === null || cur.headerDone) {
        cur = {
          oldPath: null,
          newPath: null,
          hasPair: false,
          renameFrom: null,
          renameTo: null,
          diffA: null,
          diffB: null,
          newMode: false,
          delMode: false,
          hunks: [],
          headerDone: false,
        };
        secs.push(cur);
      }
      cur.oldPath = pairPath(l);
      cur.newPath = pairPath(nxt);
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (hunk !== null) {
        trimBody(hunk);
        hunk = null;
      }
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: parseInt(m[1]!, 10), body: [] };
      cur.hunks.push(hunk);
      cur.headerDone = true;
      i += 1;
      continue;
    }
    if (hunk !== null) {
      if (l === '') {
        hunk.body.push({ kind: ' ', text: '' });
        i += 1;
        continue;
      }
      const c = l[0]!;
      if (c === ' ' || c === '-' || c === '+' || c === '\\') {
        hunk.body.push({ kind: c as BodyEntry['kind'], text: l.slice(1) });
        i += 1;
        continue;
      }
      trimBody(hunk);
      hunk = null;
      i += 1;
      continue;
    }
    if (!cur.headerDone) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.newMode = true;
      else if (l.startsWith('deleted file mode')) cur.delMode = true;
      else if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    i += 1;
  }
  if (hunk !== null) trimBody(hunk);

  const edits: Edit[] = [];
  for (const s of secs) {
    let oldP: string | null;
    let newP: string | null;
    if (s.hasPair) {
      oldP = s.oldPath;
      newP = s.newPath;
    } else if (s.renameFrom !== null || s.renameTo !== null) {
      oldP = s.renameFrom;
      newP = s.renameTo;
    } else {
      oldP = s.diffA;
      newP = s.diffB;
    }
    const creation = s.newMode || oldP === null;
    const deletion = s.delMode || newP === null;
    if (creation) {
      const p = newP!;
      const flat: BodyEntry[] = [];
      for (const h of s.hunks) flat.push(...h.body);
      const plus = flat.filter((e) => e.kind === '+').map((e) => e.text);
      const noNl = noNewlineAtEnd(flat);
      edits.push({
        apply(tree: Tree): void {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
        },
      });
      continue;
    }
    if (deletion) {
      const p = oldP!;
      edits.push({
        apply(tree: Tree): void {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) === null) throw new Fail('missing', p);
          tree.now.set(p, null);
        },
      });
      continue;
    }
    const from = oldP!;
    const to = newP!;
    const isMove = from !== to;
    const hunks = s.hunks;
    edits.push({
      move: isMove ? { old: from, new: to } : undefined,
      apply(tree: Tree): void {
        if (!safe(from)) throw new Fail('unsafe', from);
        if (isMove && !safe(to)) throw new Fail('unsafe', to);
        const orig = tree.get(from);
        if (orig === null) throw new Fail('missing', from);
        if (isMove && tree.get(to) !== null) throw new Fail('exists', to);
        const f = parseFileText(orig);
        applyHunks(f, hunks, from, strict);
        if (isMove) tree.now.set(from, null);
        tree.now.set(to, serialize(f));
      },
    });
  }
  return edits;
}

function applyHunks(f: FileState, hunks: Hunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    const entries = h.body;
    const O = oldLinesOf(entries);
    const noNl = noNewlineAtEnd(entries);
    if (O.length === 0) {
      const at = Math.min(h.a + d, f.lines.length);
      const ins: string[] = [];
      for (const e of entries) if (e.kind === '+') ins.push(e.text);
      const atEnd = at === f.lines.length;
      f.lines = [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)];
      if (atEnd) f.final = !noNl;
      d += ins.length - O.length;
      continue;
    }
    const found = findTier(f.lines, O, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const o of found.occ) if (Math.abs(o - target) < Math.abs(best - target)) best = o;
    const atEnd = best + O.length === f.lines.length;
    const repl = buildNew(f, entries, best, O[0]!, found.tier);
    f.lines = [...f.lines.slice(0, best), ...repl, ...f.lines.slice(best + O.length)];
    if (atEnd) f.final = !noNl;
    d += repl.length - O.length;
  }
}
