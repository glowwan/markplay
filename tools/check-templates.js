'use strict';
const fs = require('fs');

const files = [
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
];
const allowed = new Set(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes', 'upload']);

let problems = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const lines = text.split(/\r?\n/);
  const types = [];
  const ids = [];
  let tabLines = 0;
  let trailing = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = /^\s*-\s+type:\s*(\S+)\s*$/.exec(line);
    if (m) {
      types.push(m[1]);
      if (!allowed.has(m[1])) {
        console.log(`  ${f}:${i + 1} 非法 type: ${m[1]}`);
        problems++;
      }
    }
    m = /^\s*id:\s*(\S+)\s*$/.exec(line);
    if (m) ids.push(m[1]);
    if (/^\t/.test(line)) tabLines++;
    if (/[ \t]+$/.test(line)) trailing++;
  }

  console.log(f);
  console.log('  types :', types.join(', ') || '(未识别)');
  console.log('  ids   :', ids.join(', '));
  console.log('  tab 缩进行:', tabLines, '| 行尾空白:', trailing);
  if (types.length === 0) { console.log('  ⚠ 没解析到任何 type'); problems++; }
  if (tabLines || trailing) problems++;
}

console.log(problems === 0 ? 'STRUCTURE OK' : `PROBLEMS: ${problems}`);
process.exit(problems === 0 ? 0 : 1);
