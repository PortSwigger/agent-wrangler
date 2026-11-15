export function browserTestSkipReason(env = process.env) {
  if (env.AW_BROWSER_TESTS === '0') return 'browser tests disabled by AW_BROWSER_TESTS=0';
  if (env.AW_BROWSER_TESTS === '1' || /^(true|1)$/i.test(env.CI || '')) return false;
  if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED) {
    return 'browser tests disabled in Codex sandbox (run AW_BROWSER_TESTS=1 npm test to opt in)';
  }
  return 'browser tests disabled locally (run AW_BROWSER_TESTS=1 npm test to opt in)';
}
