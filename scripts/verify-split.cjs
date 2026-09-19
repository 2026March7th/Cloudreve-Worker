// Verify splitStatements logic against the real migration files:
// no string constant in migrations/ may contain ";" or a "--" sequence,
// otherwise the naive splitter would truncate it (see migrate.mjs header).
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

let failed = false;
for (const file of files) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  // strip block comments, then per-line strip after "--" (same as provision.ts)
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLine = noBlock
    .split('\n')
    .map((l) => {
      const i = l.indexOf('--');
      return i === -1 ? l : l.slice(0, i);
    })
    .join('\n');
  const stmts = noLine.split(';').map((s) => s.trim()).filter(Boolean);

  // 1) any *string literal* containing ; or -- got cut? Compare statement count
  //    against naive expectation: count of ";" outside strings.
  // Simple check: scan original (comment-stripped) text for string literals
  // containing ';' or '--'.
  const literals = [...noBlock.matchAll(/'(?:[^']|'')*'/g)].map((m) => m[0]);
  const bad = literals.filter((l) => l.includes(';') || l.includes('--'));
  if (bad.length > 0) {
    console.log(`FAIL ${file}: string literals contain ; or -- :`, bad);
    failed = true;
  }

  // 2) unbalanced quotes in any statement?
  for (const s of stmts) {
    const count = (s.match(/'/g) || []).length;
    if (count % 2 !== 0) {
      console.log(`FAIL ${file}: odd quote count in statement: ${s.slice(0, 80)}`);
      failed = true;
    }
  }

  console.log(`OK   ${file}: ${stmts.length} statements`);
}

console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
