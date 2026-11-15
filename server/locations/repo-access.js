import { addedReposMail } from './repos.js';
import { log, logWarn } from '../log.js';

// Widening what a location session can reach from GitHub, after dispatch. Only the
// human does it, by adding repos to the card or by allowing a session's request;
// each change is mailed to the session so it knows to clone.

function tell(mailStore, sessionId, body) {
  try {
    mailStore?.append(sessionId, { from: null, fromLabel: 'Agent Wrangler', body });
  } catch (err) {
    logWarn(`[repos] could not mail ${sessionId}: ${err?.message || err}`);
  }
}

function grantMail(sessionManager, sessionId, added, lead) {
  const entry = sessionManager.entryFor(sessionId);
  return addedReposMail(entry.cwd || '~', entry.repos, added, { branch: entry.branch, lead });
}

export async function addRepos({ sessionManager, mailStore }, sessionId, repos) {
  const result = await sessionManager.addLocationRepos(sessionId, repos);
  if (result.added.length) {
    log(`[repos] ${sessionId} can now reach ${result.added.join(', ')}`);
    tell(mailStore, sessionId, grantMail(sessionManager, sessionId, result.added));
  }
  return result;
}

export function requestRepos({ sessionManager }, sessionId, repos, why) {
  return sessionManager.requestLocationRepos(sessionId, repos, why);
}

export async function answerRepoRequest({ sessionManager, mailStore }, sessionId, requestId, allow) {
  const { request, added } = await sessionManager.answerRepoRequest(sessionId, requestId, allow);
  if (added.length) {
    log(`[repos] ${sessionId} can now reach ${added.join(', ')} (requested)`);
    tell(mailStore, sessionId, grantMail(sessionManager, sessionId, added, 'The human allowed your request and added'));
  } else if (allow) {
    tell(mailStore, sessionId, `The human allowed your request for ${request.repos.join(', ')}, which this session already reaches.`);
  } else {
    const one = request.repos.length === 1;
    tell(mailStore, sessionId, `The human declined your request for ${request.repos.join(', ')}. Carry on without ${one ? 'it' : 'them'}, and report anything you could not do because of it.`);
  }
  return { request, added };
}
