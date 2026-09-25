import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkDocCoverage } from './check-doc-coverage.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-doc-coverage-'));
  fs.mkdirSync(path.join(root, 'agent-skills/skills/example'), { recursive: true });
  fs.mkdirSync(path.join(root, 'server/mcp/tools'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agent-skills/skills/example/SKILL.md'), '---\nname: example\ndescription: Use when testing.\n---\n');
  fs.writeFileSync(path.join(root, 'server/mcp/tools/index.js'), "import { exampleTool } from './example.js';\nexport const TOOLS = [exampleTool];\n");
  fs.writeFileSync(path.join(root, 'server/mcp/tools/example.js'), "export const exampleTool = { name: 'example_tool' };\n");
  fs.writeFileSync(path.join(root, 'README.md'), '[Capabilities](docs/agent-capabilities.md)\n');
  fs.writeFileSync(path.join(root, 'docs/agent-capabilities.md'), '# Capabilities\n');
  fs.writeFileSync(path.join(root, 'docs/agent-tools.md'), '# Tools\n');
  fs.writeFileSync(path.join(root, 'docs/board-and-sessions.md'), '# Board and sessions\n');
  fs.writeFileSync(path.join(root, 'docs/reviews-and-prs.md'), '# Reviews and pull requests\n');
  fs.mkdirSync(path.join(root, '.claude/skills/maintain-product-docs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/skills/maintain-product-docs/SKILL.md'), '# Maintain docs\n');
  return root;
}

test('reports undocumented built-in skills and MCP tools', () => {
  const root = fixture();
  assert.deepEqual(checkDocCoverage(root), [
    'docs/agent-capabilities.md does not mention skill `example`',
    'docs/agent-tools.md does not mention tool `example_tool`',
  ]);
});

test('accepts documented skills, tools, and valid relative links', () => {
  const root = fixture();
  fs.appendFileSync(path.join(root, 'docs/agent-capabilities.md'), '\n`example`\n');
  fs.appendFileSync(path.join(root, 'docs/agent-tools.md'), '\n`example_tool`\n');
  assert.deepEqual(checkDocCoverage(root), []);
});

test('reports broken relative Markdown links', () => {
  const root = fixture();
  fs.appendFileSync(path.join(root, 'docs/agent-capabilities.md'), '\n`example`\n[Missing](missing.md)\n');
  fs.appendFileSync(path.join(root, 'docs/agent-tools.md'), '\n`example_tool`\n');
  assert.deepEqual(checkDocCoverage(root), [
    'docs/agent-capabilities.md links to missing path `missing.md`',
  ]);
});

test('reports required documentation files hidden by git ignore rules', () => {
  const root = fixture();
  fs.appendFileSync(path.join(root, 'docs/agent-capabilities.md'), '\n`example`\n');
  fs.appendFileSync(path.join(root, 'docs/agent-tools.md'), '\n`example_tool`\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'docs/*\n.claude/\n');
  execFileSync('git', ['init', '-q'], { cwd: root });

  assert.deepEqual(checkDocCoverage(root), [
    'docs/agent-capabilities.md is hidden by a git ignore rule',
    'docs/agent-tools.md is hidden by a git ignore rule',
    'docs/board-and-sessions.md is hidden by a git ignore rule',
    'docs/reviews-and-prs.md is hidden by a git ignore rule',
    '.claude/skills/maintain-product-docs/SKILL.md is hidden by a git ignore rule',
  ]);
});

test('reports every missing required documentation path', async (t) => {
  const required = [
    'docs/agent-capabilities.md',
    'docs/agent-tools.md',
    'docs/board-and-sessions.md',
    'docs/reviews-and-prs.md',
    '.claude/skills/maintain-product-docs/SKILL.md',
  ];

  for (const relative of required) {
    await t.test(relative, () => {
      const root = fixture();
      fs.rmSync(path.join(root, relative));
      assert.ok(checkDocCoverage(root).includes(`${relative} is missing`));
    });
  }
});
