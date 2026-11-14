import { DeckError } from './actions.js';

const STATUS_CODE = { 400: 'invalid', 403: 'forbidden', 404: 'not-found', 413: 'invalid', 415: 'invalid' };
const REASON_CODE = {
  'invalid-path': 'invalid',
  'unsupported-type': 'invalid',
  'not-a-file': 'invalid',
  'too-large': 'invalid',
  'not-permitted': 'forbidden',
  'not-found': 'not-found',
  'changed': 'conflict',
};

// Actions with no legacy control type: the reads the board makes over plain
// HTTP today (GET /file and GET /ext-file). Both take their file reader from
// ctx, which server/index.js fills with the same functions those routes use.
export const NATIVE_ACTIONS = [
  {
    action: 'session.file',
    async run({ path }, ctx) {
      const r = await ctx.readMarkdownFile(path);
      if (r.status !== 200) throw new DeckError(STATUS_CODE[r.status] || 'failed', r.message || 'read error');
      return { path: r.path, content: r.content };
    },
  },
  {
    action: 'deck.ext-file',
    async run({ ext, path }, ctx) {
      if (typeof ext !== 'string' || !ext) throw new DeckError('invalid', 'ext must be an extension id');
      const r = await ctx.openExtFile(ext, path);
      if (!r?.ok) {
        const reason = typeof r?.reason === 'string' ? r.reason : 'error';
        throw new DeckError(REASON_CODE[reason] || 'failed', reason);
      }
      return r;
    },
  },
];
