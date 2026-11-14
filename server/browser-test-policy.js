export function browserTestSkipReason(env = process.env) {
  if (env.AW_BROWSER_TESTS === '0') return 'browser tests disabled by AW_BROWSER_TESTS=0';
  if (env.AW_BROWSER_TESTS === '1') return false;
  if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED) {
    return 'browser tests disabled in Codex sandbox (set AW_BROWSER_TESTS=1 to opt in)';
  }
  return false;
}
