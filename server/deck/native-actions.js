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

// Actions with no control handler behind them: the board's file reads. Both
// take their file reader from ctx, which server/index.js fills. An error keeps
// the reader's own `status` or `reason` for the GET /file and GET /ext-file
// adapters (deck/legacy.js), which answer with them as those routes always did.
export const NATIVE_ACTIONS = [
  {
    action: 'session.file',
    async run({ path }, ctx) {
      const r = await ctx.readMarkdownFile(path);
      if (r.status !== 200) throw Object.assign(new DeckError(STATUS_CODE[r.status] || 'failed', r.message || 'read error'), { status: r.status });
      return { path: r.path, content: r.content };
    },
  },
  {
    action: 'deck.ext-file',
    async run({ ext, path }, ctx) {
      if (typeof ext !== 'string' || !ext) throw Object.assign(new DeckError('invalid', 'ext must be an extension id'), { reason: 'not-permitted' });
      const r = await ctx.openExtFile(ext, path);
      if (!r?.ok) {
        const reason = typeof r?.reason === 'string' ? r.reason : 'error';
        throw Object.assign(new DeckError(REASON_CODE[reason] || 'failed', reason), { reason });
      }
      return r;
    },
  },
];
