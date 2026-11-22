// jsonedit — part of mend, the patch tool SPEC.md v1 specifies. Node 22, standard library only.
import { Exit2, Fail, Tree, safe, blank, patchLines } from './core.ts';
import type { Edit } from './core.ts';

// ---------------------------------------------------------------- JSON edits

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
    return {
      apply(tree: Tree): void {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, text);
      },
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return {
      apply(tree: Tree): void {
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
      },
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return {
      apply(tree: Tree): void {
        const before = exists(tree);
        const nl = before.indexOf('\n');
        const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
        const lines = before === '' ? [] : before.split(br);
        const final = before !== '' && before.endsWith(br);
        if (final) lines.pop();
        if (line < 0 || line > lines.length) throw new Fail('no-match', p);
        lines.splice(line, 0, ...add);
        tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
      },
    };
  }
  return null;
}

export function jsonEdits(text: string, lines: string[]): Edit[] {
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
