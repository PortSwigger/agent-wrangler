const phases = new Map([
  ['controls', 'Applying namespace controls…'],
  ['enrolment', 'Connecting the deck to the broker…'],
  ['storage', 'Preparing deck storage…'],
  ['deck', 'Starting the deck…'],
]);

const errors = new Map([
  [401, 'Sign in to the cloud gateway, then retry.'],
  [403, 'Access refused. This account or board is not allowed to connect.'],
  [404, 'The gateway has no pending deck request. Retry to connect.'],
  [409, 'A reserved deck resource is already in use. Contact the gateway administrator.'],
  [503, 'The cloud service is unavailable. Retry when it is reachable.'],
]);

// The gateway authenticates every request. The board supplies only its session
// cookie and follows the runtime's status and ready routes on that same origin.
export async function connectCloudDeck(gateway, progress, {
  fetchImpl = fetch,
  wait = () => new Promise((resolve) => setTimeout(resolve, 1500)),
  signal = AbortSignal.timeout(300000),
} = {}) {
  const options = { credentials: 'include', redirect: 'error', cache: 'no-store', signal };
  let poll = false;
  for (;;) {
    let response;
    try {
      response = poll
        ? await fetchImpl(gateway + '/status', options)
        : await fetchImpl(gateway + '/connect', { ...options, method: 'POST' });
    } catch {
      throw new Error(signal.aborted ? 'The deck is taking longer than expected. Retry to check it again.'
        : 'Could not reach the cloud gateway. Check your connection and sign-in, then retry.');
    }
    if (!response.ok) {
      if (response.status === 403) {
        const refusal = await response.json().catch(() => null);
        if (refusal?.error === 'ineligible') throw new Error('Access refused. Your account is not eligible for a cloud deck.');
        if (refusal?.error === 'origin_refused') throw new Error('Access refused. The gateway does not allow this board’s origin.');
      }
      throw new Error(errors.get(response.status) || `The cloud gateway answered ${response.status}.`);
    }
    const body = await response.json().catch(() => null);
    if (response.status === 200 && body?.state === 'ready' && body.url === '/') return;
    if (response.status !== 202 || body?.state !== 'provisioning' || body.statusUrl !== '/status') {
      throw new Error('The cloud gateway returned an unexpected deck response.');
    }
    progress(phases.get(body.phase) || 'Preparing the cloud deck…');
    poll = true;
    await wait();
  }
}
