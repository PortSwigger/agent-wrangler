// The legality rules for a setting DEF's constraint fields and for a VALUE
// measured against them, in one module so the two can never drift: a def that
// validateManifest accepted is exactly a def checkSettingValue knows how to
// apply, and a constraint field nobody enforces cannot be declared at all.
//
// A leaf under server/extensions/**, so it imports nothing — not even a control
// handler (index.test.js's FORBIDDEN_IMPORTS asserts the direction). That is
// why MAX_TEXT_LENGTH lives HERE and ext-setting-set.js re-exports it rather
// than the other way round: the handler importing the leaf is the legal
// direction, and the number has to be one number.
//
// The panel mirrors these onto native inputs (min/max/step/maxLength/pattern
// and a <select>) purely as an affordance. THIS is the enforcement, on the
// server write path, and it REJECTS rather than clamps — a clamp would make the
// row lie about what is stored exactly as a coercion would.

export const MAX_TEXT_LENGTH = 2048;

// A declared `pattern` is compiled with `new RegExp` and run against a human's
// typed value on the server. An extension already runs in-process with full
// access to the machine, so this is not a security boundary and does not
// pretend to be one — it just bounds the cost of a careless or hostile regex to
// something a reader of the manifest could have spotted.
export const MAX_PATTERN_LENGTH = 200;

// The one table both halves read: which constraint field belongs to which def
// type. A field on the wrong type is a def ERROR, not something silently
// ignored — a `min` on a text setting is a manifest author believing in an
// enforcement that would never run.
const FIELD_TYPES = {
  min: 'number', max: 'number', step: 'number',
  maxLength: 'text', pattern: 'text',
  options: 'select',
};

const isFinite_ = (v) => typeof v === 'number' && Number.isFinite(v);

// Returns the REASON only (e.g. `min must be a finite number`); the caller
// prefixes it with `settings.<key>.`, matching the sibling checks in
// validateManifest. Reasons that are not field-prefixed are worded so the
// prefixed sentence still reads.
export function validateSettingDef(def) {
  for (const [field, type] of Object.entries(FIELD_TYPES)) {
    if (def[field] != null && def.type !== type) return `${field} is only valid on a ${type} setting`;
  }
  if (def.type === 'number') {
    for (const field of ['min', 'max', 'step']) {
      if (def[field] != null && !isFinite_(def[field])) return `${field} must be a finite number`;
    }
    if (def.step != null && def.step <= 0) return 'step must be greater than zero';
    if (def.min != null && def.max != null && def.min > def.max) return 'min must not be greater than max';
  }
  if (def.type === 'text') {
    if (def.maxLength != null) {
      if (!Number.isInteger(def.maxLength) || def.maxLength < 1) return 'maxLength must be a positive integer';
      if (def.maxLength > MAX_TEXT_LENGTH) return `maxLength must not exceed ${MAX_TEXT_LENGTH}`;
    }
    if (def.pattern != null) {
      if (typeof def.pattern !== 'string') return 'pattern must be a string';
      if (def.pattern.length > MAX_PATTERN_LENGTH) return `pattern must be at most ${MAX_PATTERN_LENGTH} characters`;
      try { compile(def.pattern); } catch { return 'pattern must be a valid regular expression'; }
    }
  }
  if (def.type === 'select') {
    if (!Array.isArray(def.options) || def.options.length === 0) return 'options must be a non-empty array';
    const seen = new Set();
    for (const [i, o] of def.options.entries()) {
      if (!o || typeof o !== 'object') return `options[${i}] is not an object`;
      if (typeof o.value !== 'string') return `options[${i}].value must be a string`;
      if (seen.has(o.value)) return `options has a duplicate value ${JSON.stringify(o.value)}`;
      seen.add(o.value);
      // `label` is third-party prose, so type-checked only — exactly like
      // help/placeholder. Every consumer renders it via textContent.
      if (typeof o.label !== 'string' || !o.label) return `options[${i}].label must be a non-empty string`;
    }
  }
  return null;
}

// Anchored FULL-STRING, so a declared `pattern` means the same thing here as
// HTML's implicitly-anchored `pattern` attribute the panel mirrors it onto.
// Without this the server would accept a value whose substring matched while
// the browser refused it, which is the worst of both.
function compile(pattern) {
  return new RegExp(`^(?:${pattern})$`);
}

// Returns the rejection reason only, or null. Called with the value AFTER the
// handler's type coercion, so it sees a number, a string or a boolean, never
// raw frame input.
export function checkSettingValue(def, value) {
  // Cleared, not a value. `null` (number) and `''` (text/select) remove the
  // key, and a constraint has nothing to say about an absent setting — a select
  // whose only clearing route is the empty option depends on this.
  if (value === null || value === '') return null;
  if (def.type === 'number') {
    if (def.min != null && value < def.min) return `must be at least ${def.min}`;
    if (def.max != null && value > def.max) return `must be at most ${def.max}`;
    if (def.step != null) {
      const base = def.min != null ? def.min : 0;
      const q = (value - base) / def.step;
      // Float tolerance, not an equality test: a 0.1 step over a base of 0
      // produces quotients no binary float represents exactly, so a literal
      // Number.isInteger would reject values a human typed correctly. Scaled to
      // the quotient's own magnitude so a large value with a small step does
      // not fail on accumulated representation error alone.
      if (Math.abs(Math.round(q) - q) > 1e-9 * Math.max(1, Math.abs(q))) {
        return `must be ${def.min != null ? `${def.min} plus ` : ''}a multiple of ${def.step}`;
      }
    }
    return null;
  }
  if (def.type === 'text') {
    if (def.maxLength != null && value.length > def.maxLength) return `is too long (max ${def.maxLength} characters)`;
    if (def.pattern != null && !compile(def.pattern).test(value)) return `does not match the required format (${def.pattern})`;
    return null;
  }
  if (def.type === 'select') {
    if (!(def.options || []).some((o) => o.value === value)) return `must be one of ${(def.options || []).map((o) => JSON.stringify(o.value)).join(', ')}`;
    return null;
  }
  return null;
}
