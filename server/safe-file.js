import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileTypeOf, FILE_KIND_LIMITS } from '../public/file-types.js';

const MISSING = new Set(['ENOENT', 'ENOTDIR']);
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

// Lexical only, no disk: a stored path must be absolute, NUL-free and already
// normalised (no `..`, no doubled or trailing slash), so what is stored is what
// is later compared against realpath.
export function checkPathShape(p) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return false;
  return path.isAbsolute(p) && path.resolve(p) === p;
}

// Reads one file for the viewer. Never throws: every problem is { ok:false, reason }.
// reason ∈ invalid-path | unsupported-type | not-found | changed | not-a-file | too-large | error.
// The file is opened O_NOFOLLOW, must be a regular file under its kind's size cap,
// its path must still resolve (realpath) to itself, and the path must still name
// the descriptor's inode — so a symlink swapped in for the file or any parent
// since the path was registered is refused.
export async function readSafeFile(p) {
  if (!checkPathShape(p)) return { ok: false, reason: 'invalid-path' };
  const type = fileTypeOf(p);
  if (!type) return { ok: false, reason: 'unsupported-type' };
  let fh;
  try {
    fh = await fsp.open(p, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, reason: 'not-a-file' };
    if (st.size > FILE_KIND_LIMITS[type.kind]) return { ok: false, reason: 'too-large' };
    if (await fsp.realpath(p) !== p) return { ok: false, reason: 'changed' };
    const now = await fsp.stat(p);
    if (now.ino !== st.ino || now.dev !== st.dev) return { ok: false, reason: 'changed' };
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, null);
      if (!bytesRead) break;
      n += bytesRead;
    }
    const bytes = buf.subarray(0, n);
    return {
      ok: true, path: p, kind: type.kind, mime: type.mime, size: n,
      ...(type.kind === 'markdown' ? { text: bytes.toString('utf8') } : { base64: bytes.toString('base64') }),
    };
  } catch (err) {
    if (MISSING.has(err?.code)) return { ok: false, reason: 'not-found' };
    if (err?.code === 'ELOOP') return { ok: false, reason: 'changed' };
    return { ok: false, reason: 'error' };
  } finally {
    await fh?.close();
  }
}
