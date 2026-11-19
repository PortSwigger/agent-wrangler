import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addRepos, answerRepoRequest } from './repo-access.js';
import { addedReposMail, reposToAdd } from './repos.js';

function fakes(entry) {
  const mail = [];
  const sessionManager = {
    entryFor: () => entry,
    addLocationRepos: async (_sid, repos) => {
      const added = reposToAdd(entry.repos, repos);
      entry.repos = [...entry.repos, ...added];
      return { added, repos: [...entry.repos] };
    },
    answerRepoRequest: async (sid, id, allow) => {
      const request = entry.repoRequests.find((r) => r.id === id);
      entry.repoRequests = entry.repoRequests.filter((r) => r !== request);
      return { request, added: allow ? (await sessionManager.addLocationRepos(sid, request.repos)).added : [] };
    },
  };
  const mailStore = { append: (to, m) => { mail.push({ to, ...m }); return { id: 'm1' }; } };
  return { sessionManager, mailStore, mail };
}

test('adding repos mails the session where to clone each one, from Agent Wrangler, and nothing when nothing was added', async () => {
  const entry = { cwd: '/home/agent/sessions/1', repos: ['acme/widgets'], branch: 'job-1-api' };
  const f = fakes(entry);
  assert.deepEqual((await addRepos(f, 'S1', ['acme/gadgets'])).added, ['acme/gadgets']);
  assert.equal(f.mail.length, 1);
  assert.deepEqual([f.mail[0].to, f.mail[0].from, f.mail[0].fromLabel], ['S1', null, 'Agent Wrangler']);
  assert.match(f.mail[0].body, /^The human added acme\/gadgets to this session/);
  assert.match(f.mail[0].body, /git clone --filter=blob:none https:\/\/github.com\/acme\/gadgets.git \/home\/agent\/sessions\/1\/gadgets/);
  assert.match(f.mail[0].body, /git switch -c job-1-api/);
  assert.doesNotMatch(f.mail[0].body, /widgets\.git/, 'only the new repo is named');
  await addRepos(f, 'S1', ['acme/gadgets']);
  assert.equal(f.mail.length, 1);
});

test('a full mailbox does not undo the grant', async () => {
  const entry = { cwd: '/w', repos: [] };
  const f = fakes(entry);
  f.mailStore.append = () => { throw new Error('backed up'); };
  assert.deepEqual((await addRepos(f, 'S1', ['acme/a'])).added, ['acme/a']);
  assert.deepEqual(entry.repos, ['acme/a']);
});

test('the session hears the answer to its request either way', async () => {
  const entry = { cwd: '/w', repos: [], repoRequests: [{ id: 'rr_1', repos: ['acme/a'], why: 'x' }, { id: 'rr_2', repos: ['acme/b', 'acme/c'], why: 'y' }] };
  const f = fakes(entry);
  await answerRepoRequest(f, 'S1', 'rr_1', true);
  assert.match(f.mail[0].body, /^The human allowed your request and added acme\/a to this session/);
  assert.match(f.mail[0].body, /acme\/a.git \/w\/a/);
  await answerRepoRequest(f, 'S1', 'rr_2', false);
  assert.equal(f.mail[1].body, 'The human declined your request for acme/b, acme/c. Carry on without them, and report anything you could not do because of it.');
});

test('the clone dir in the mail is the one the dispatch brief would give, and a name clash is refused before anything moves', () => {
  assert.match(addedReposMail('/w', ['acme/a', 'other/b'], ['other/b']), /other\/b.git \/w\/b$/);
  assert.doesNotMatch(addedReposMail('/w', ['acme/a'], ['acme/a']), /push/, 'no branch, no push line');
  assert.throws(() => reposToAdd(['acme/a'], ['other/A']), /already has a repo named "A" \(acme\/a\)/);
  assert.deepEqual(reposToAdd(['acme/a'], ['ACME/A', 'acme/b', 'acme/b']), ['acme/b']);
});
