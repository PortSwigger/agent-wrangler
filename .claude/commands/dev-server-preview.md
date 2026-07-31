Launch an isolated agent-wrangler dev instance so I can check the current changes myself in a browser.

Use the run-dev skill to start it (own data dir, port, and tmux socket — must never touch the live board). Once it's up, tell me the URL and stop there.

Do not navigate, click through, or otherwise test the app yourself — this is for me to check by hand. Don't tear the instance down or mention teardown steps; run-dev's idle auto-stop handles that on its own.
