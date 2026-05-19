import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { submitSprint } from '../../mcp/tools/submit-sprint.ts';
import { createMockOctokit } from '../../mcp/__tests__/fixtures/mock-octokit.ts';
import { detectExplicitMode } from '../modes.ts';
import { SPRINT_MODES } from '../modes.ts';

describe('classifier ← MCP submitSprint integration', () => {
  it('resolves the correct SprintMode for every mode the MCP can emit', async () => {
    for (const mode of SPRINT_MODES) {
      const { client, state } = createMockOctokit();
      await submitSprint(
        { octokit: client, defaultRepo: 'weautomatehq1/IFleet' },
        { brief: 'integration: pick up the mode', mode },
      );
      const call = state.calls.find((c) => c.tool === 'createIssue')!;
      const args = call.args as { labels: string[]; body: string };
      const resolved = detectExplicitMode({ labels: args.labels, body: args.body });
      assert.equal(resolved, mode, `expected detectExplicitMode to see ${mode}`);
    }
  });

  it('resolves to undefined when MCP omits the mode (no label emitted)', async () => {
    const { client, state } = createMockOctokit();
    await submitSprint(
      { octokit: client, defaultRepo: 'weautomatehq1/IFleet' },
      { brief: 'plain brief with no explicit mode' },
    );
    const call = state.calls.find((c) => c.tool === 'createIssue')!;
    const args = call.args as { labels: string[]; body: string };
    const resolved = detectExplicitMode({ labels: args.labels, body: args.body });
    assert.equal(resolved, undefined);
  });
});
