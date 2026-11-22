// Just enough protobuf to read agy's conversation database (agy-db.js). agy
// keeps every step as an encoded message with no published schema, so this
// reads the wire format by field number and nothing else: a message decodes to
// { [field]: [values] }, where a varint is a Number and a length-delimited
// field stays a Buffer until the caller asks for it as a string or a message.

function varint(buf, at) {
  let value = 0;
  let scale = 1;
  let i = at;
  for (; i < buf.length; i += 1) {
    const b = buf[i];
    value += (b & 0x7f) * scale;
    scale *= 128;
    if (b < 0x80) return [value, i + 1];
  }
  throw new RangeError('truncated varint');
}

// One message's fields, or null when `buf` is not a well-formed message (a
// string field that happens to be asked for as a message).
export function decode(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  const out = {};
  let at = 0;
  try {
    while (at < buf.length) {
      const [key, next] = varint(buf, at);
      at = next;
      const field = Math.floor(key / 8);
      const wire = key % 8;
      if (field < 1) return null;
      let value;
      if (wire === 0) [value, at] = varint(buf, at);
      else if (wire === 1) { value = buf.subarray(at, at + 8); at += 8; }
      else if (wire === 5) { value = buf.subarray(at, at + 4); at += 4; }
      else if (wire === 2) {
        const [len, start] = varint(buf, at);
        if (start + len > buf.length) return null;
        value = buf.subarray(start, start + len);
        at = start + len;
      } else return null;
      if (at > buf.length) return null;
      (out[field] ||= []).push(value);
    }
  } catch {
    return null;
  }
  return out;
}

const asMessage = (v) => (Buffer.isBuffer(v) ? decode(v) : (v && typeof v === 'object' ? v : null));

// The message at a path of field numbers (each step takes the first value), or null.
export function msgAt(msg, ...path) {
  let cur = asMessage(msg);
  for (const f of path) {
    if (!cur) return null;
    cur = asMessage(cur[f]?.[0]);
  }
  return cur;
}

// Every value of the last field on a path, each as a message.
export function msgsAt(msg, ...path) {
  const parent = msgAt(msg, ...path.slice(0, -1));
  return (parent?.[path.at(-1)] || []).map(asMessage).filter(Boolean);
}

export function strAt(msg, ...path) {
  const parent = msgAt(msg, ...path.slice(0, -1));
  const v = parent?.[path.at(-1)]?.[0];
  return Buffer.isBuffer(v) ? v.toString('utf8') : null;
}

export function strsAt(msg, ...path) {
  const parent = msgAt(msg, ...path.slice(0, -1));
  return (parent?.[path.at(-1)] || []).filter(Buffer.isBuffer).map((b) => b.toString('utf8'));
}

export function numAt(msg, ...path) {
  const parent = msgAt(msg, ...path.slice(0, -1));
  const v = parent?.[path.at(-1)]?.[0];
  return typeof v === 'number' ? v : null;
}

// A google.protobuf.Timestamp ({1: seconds, 2: nanos}) as epoch ms, or null.
export function timeAt(msg, ...path) {
  const ts = msgAt(msg, ...path);
  const s = numAt(ts, 1);
  if (s == null) return null;
  return s * 1000 + Math.floor((numAt(ts, 2) || 0) / 1e6);
}

// ---- Encoding (tests build fixture databases with it) ---------------------

function encVarint(n) {
  const bytes = [];
  let v = n;
  while (v >= 0x80) { bytes.push((v % 128) | 0x80); v = Math.floor(v / 128); }
  bytes.push(v);
  return Buffer.from(bytes);
}

// { [field]: value | value[] } → Buffer. A number is a varint, a string or a
// Buffer is length-delimited, a plain object is a nested message.
export function encode(fields) {
  const parts = [];
  for (const [k, raw] of Object.entries(fields)) {
    const field = Number(k);
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      if (v == null) continue;
      if (typeof v === 'number') { parts.push(encVarint(field * 8), encVarint(v)); continue; }
      const body = typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.isBuffer(v) ? v : encode(v);
      parts.push(encVarint(field * 8 + 2), encVarint(body.length), body);
    }
  }
  return Buffer.concat(parts);
}

export const timestamp = (ms) => ({ 1: Math.floor(ms / 1000), 2: (ms % 1000) * 1e6 });
