# SSH Agent Forwarding for Fleet Workers

## Problem

Fleet worker subprocesses spawned via `claude -p` (non-interactive) do not inherit
the interactive SSH agent socket from the parent shell. Any task that requires SSH
authentication (e.g. `git push` to a remote, VPS deploy via `rsync`/`scp`, or
`ssh user@host`) will fail with "Permission denied (publickey)".

## Root Cause

`SSH_AUTH_SOCK` is set in the user's interactive shell session but is not
automatically forwarded to child processes spawned by the orchestrator. The
orchestrator creates workers via `spawn()`, which inherits the process environment
at startup time — not the live agent socket.

## Solution A — Forward SSH_AUTH_SOCK in worker spawn env (Recommended)

When starting the orchestrator, ensure `SSH_AUTH_SOCK` is propagated to worker
environments. In the orchestrator startup script or PM2 `ecosystem.config.cjs`:

```js
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'ifleet',
    script: './dist/index.js',
    env: {
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? '',
    },
  }],
};
```

Then start it from an interactive shell (not a cron/launchd context) so that
`SSH_AUTH_SOCK` is already set when PM2 captures the env:

```bash
# From an interactive terminal where ssh-agent is running:
eval "$(ssh-agent -s)"     # if not already running
ssh-add ~/.ssh/id_ed25519  # or your key
pm2 start ecosystem.config.cjs
```

PM2 bakes the env at `pm2 start` time, so the socket path is frozen. If the agent
restarts (e.g. after reboot), you must `pm2 restart ifleet` from a shell where the
new `SSH_AUTH_SOCK` is set.

**macOS keychain alternative** — add your key to the macOS keychain so it persists
across reboots without a running agent:

```bash
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
```

Add to `~/.ssh/config`:

```
Host *
  UseKeychain yes
  AddKeysToAgent yes
  IdentityFile ~/.ssh/id_ed25519
```

This makes the key available to any process, including non-interactive ones, without
needing `SSH_AUTH_SOCK` forwarding.

## Solution B — Deploy Key on the Runner Machine (Simpler for CI-like setups)

Provision a dedicated SSH key on the Mac runner that has no passphrase. Add the
public key to GitHub (or the target VPS) as a deploy key scoped to the repos the
fleet needs to push to.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ifleet_deploy -N "" -C "ifleet-deploy@mac-runner"
cat ~/.ssh/ifleet_deploy.pub  # → add to GitHub Deploy Keys or VPS authorized_keys
```

Add to `~/.ssh/config`:

```
Host github.com
  IdentityFile ~/.ssh/ifleet_deploy
  AddKeysToAgent no
```

Because there is no passphrase, no agent is needed — `git push` works in any
subprocess context. This is the most reliable option for overnight/unattended runs.

## Recommended Setup (both solutions together)

1. Use the macOS keychain (`--apple-use-keychain`) for interactive development.
2. Use a passphrase-free deploy key scoped to the fleet's repos for the
   orchestrator's worker processes. Add it to `~/.ssh/config` with `IdentityFile`.

This way interactive `git` use in the terminal works with your regular key, while
fleet workers always have a working identity without needing `SSH_AUTH_SOCK`.

## Verification

After setup, verify that a non-interactive subprocess can push:

```bash
node -e "const { execSync } = require('child_process'); console.log(execSync('ssh -T git@github.com 2>&1').toString())"
# Expected: "Hi weautomatehq1! You've successfully authenticated..."
```

If that prints the expected greeting, fleet deploy tasks will work.
