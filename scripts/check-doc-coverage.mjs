#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REQUIRED_DOC_PATHS = [
  'docs/agent-capabilities.md',
  'docs/agent-tools.md',
  'docs/board-and-sessions.md',
  'docs/reviews-and-prs.md',
  '.claude/skills/maintain-product-docs/SKILL.md',
];

function skillNames(root) {
  const dir = path.join(root, 'agent-skills/skills');
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name, 'SKILL.md'))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'utf8').match(/^name:\s*([^\s]+)\s*$/m)?.[1])
    .filter(Boolean)
    .sort();
}

function toolNames(root) {
  const dir = path.join(root, 'server/mcp/tools');
  const index = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
  const modules = [...index.matchAll(/from '\.\/([^']+\.js)'/g)].map((match) => match[1]);
  return modules
    .map((file) => fs.readFileSync(path.join(dir, file), 'utf8').match(/\bname:\s*'([^']+)'/)?.[1])
    .filter(Boolean)
    .sort();
}

function markdownFiles(root) {
  const files = [path.join(root, 'README.md')];
  const docs = path.join(root, 'docs');
  for (const entry of fs.readdirSync(docs, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(path.join(docs, entry.name));
  }
  return files;
}

function linkPath(raw) {
  const target = raw.trim();
  if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const value = target.startsWith('<') ? target.slice(1, target.indexOf('>')) : target.split(/\s+["']/)[0];
  try {
    return decodeURIComponent(value.split('#')[0]);
  } catch {
    return value.split('#')[0];
  }
}

export function checkDocCoverage(root = process.cwd()) {
  const errors = [];
  const capabilitiesFile = path.join(root, 'docs/agent-capabilities.md');
  const toolsFile = path.join(root, 'docs/agent-tools.md');

  for (const relative of REQUIRED_DOC_PATHS) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) {
      errors.push(`${relative} is missing`);
      continue;
    }
    const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', '--', relative], {
      cwd: root,
      stdio: 'ignore',
    });
    if (result.status === 0) errors.push(`${relative} is hidden by a git ignore rule`);
  }

  if (fs.existsSync(capabilitiesFile)) {
    const capabilities = fs.readFileSync(capabilitiesFile, 'utf8');
    for (const name of skillNames(root)) {
      if (!capabilities.includes(`\`${name}\``)) {
        errors.push(`docs/agent-capabilities.md does not mention skill \`${name}\``);
      }
    }
  }
  if (fs.existsSync(toolsFile)) {
    const tools = fs.readFileSync(toolsFile, 'utf8');
    for (const name of toolNames(root)) {
      if (!tools.includes(`\`${name}\``)) {
        errors.push(`docs/agent-tools.md does not mention tool \`${name}\``);
      }
    }
  }

  for (const file of markdownFiles(root)) {
    const body = fs.readFileSync(file, 'utf8');
    for (const match of body.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const relative = linkPath(match[1]);
      if (!relative) continue;
      const target = path.resolve(path.dirname(file), relative);
      if (!fs.existsSync(target)) {
        errors.push(`${path.relative(root, file)} links to missing path \`${relative}\``);
      }
    }
  }

  return errors;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const errors = checkDocCoverage();
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log('Documentation coverage checks passed.');
  }
}
