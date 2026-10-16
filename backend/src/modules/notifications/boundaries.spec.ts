import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');

// ESLint's flat config is an ES module, so it runs in a separate Node process rather than in Jest.
const RUNNER = `
import { ESLint } from 'eslint';
import path from 'node:path';
const cases = JSON.parse(process.env.BOUNDARY_CASES);
const eslint = new ESLint({ cwd: process.cwd() });
const out = [];
for (const { file, code } of cases) {
  const [result] = await eslint.lintText(code, { filePath: path.resolve(file) });
  out.push(result.messages.filter((m) => m.severity === 2).map((m) => (m.ruleId ?? 'parse') + ': ' + m.message));
}
console.log('RESULT:' + JSON.stringify(out));
`;

/** Lints `code` as if it were the content of an existing file; returns the errors of each case. */
function lint(cases: { file: string; code: string }[]): string[][] {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', RUNNER], {
    cwd: root,
    env: { ...process.env, BOUNDARY_CASES: JSON.stringify(cases) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT:'));
  return JSON.parse((line ?? 'RESULT:[]').slice('RESULT:'.length)) as string[][];
}

const importing = (from: string, target: string) =>
  `import { x } from '${from}/notifications/${target}.js';\nexport const a = x;\n`;

describe('module boundary for notifications (SLICE-09 §4.7)', () => {
  jest.setTimeout(120_000);

  it('lets every module import the public interface and rejects deep imports', () => {
    const modules = [
      ['src/modules/alerts/admin-notice.ts', '..'],
      ['src/modules/appService/transaction.ts', '..'],
      ['src/modules/identity/transaction.ts', '..'],
      ['src/modules/incidents/lifecycle/transition.kernel.ts', '../..'],
    ] as const;

    const results = lint([
      ...modules.map(([file, up]) => ({ file, code: importing(up, 'index') })),
      ...modules.map(([file, up]) => ({ file, code: importing(up, 'record-notification') })),
    ]);

    expect(results.slice(0, 4)).toEqual([[], [], [], []]);
    for (const errors of results.slice(4)) {
      expect(errors.join('\n')).toContain('boundaries/entry-point');
    }
  });

  it('keeps notifications dependent on shared and infra only (never on another module)', () => {
    const dir = __dirname;
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      const imports = [...readFileSync(path.join(dir, file), 'utf8').matchAll(/from '([^']+)'/g)];
      for (const [, target] of imports) {
        expect(target).not.toMatch(/^\.\.\/(?!\.\.\/(shared|infra|generated)\/)/);
      }
    }
  });
});
