import { describe, it } from 'vitest';
import { broadcastIFleet } from '../discord-broadcast.js';

describe('broadcastIFleet', () => {
  it('is a no-op when DISCORD_IFLEET_WEBHOOK is unset', () => {
    const prior = process.env['DISCORD_IFLEET_WEBHOOK'];
    delete process.env['DISCORD_IFLEET_WEBHOOK'];
    try {
      // No mock for https.request — we're asserting the function returns
      // synchronously without throwing when the env var is absent. The
      // warn-once side effect is observable in stderr but not in the
      // returned value.
      broadcastIFleet('hello');
    } finally {
      if (prior !== undefined) process.env['DISCORD_IFLEET_WEBHOOK'] = prior;
    }
  });

  it('does not throw when webhook URL is malformed', () => {
    const prior = process.env['DISCORD_IFLEET_WEBHOOK'];
    process.env['DISCORD_IFLEET_WEBHOOK'] = 'not a real url';
    try {
      broadcastIFleet('hello');
    } finally {
      if (prior !== undefined) process.env['DISCORD_IFLEET_WEBHOOK'] = prior;
      else delete process.env['DISCORD_IFLEET_WEBHOOK'];
    }
  });
});
