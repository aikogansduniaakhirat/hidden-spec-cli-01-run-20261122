// main.ts: mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`. The formats, the three matching tiers
// and the all-or-nothing write live in ./src; this file is the command and the
// trial hand-over the kit's runner needs.
import { writeSync } from 'node:fs';
import { run } from './src/run.ts';

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
