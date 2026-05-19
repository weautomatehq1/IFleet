import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server.js';
import { createMockOctokit } from './fixtures/mock-octokit.js';

const DEFAULT_REPO = 'weautomatehq1/IFleet';

async function connectClient(octokitMock: ReturnType<typeof createMockOctokit>) {
  const server = createMcpServer({
    octokit: octokitMock.client,
    defaultRepo: DEFAULT_REPO,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe('createMcpServer', () => {
  it('lists the four registered tools over an in-memory transport', async () => {
    const mock = createMockOctokit();
    const { server, client } = await connectClient(mock);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      assert.deepEqual(names, ['cancelSprint', 'getSprint', 'listActive', 'submitSprint']);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('invokes submitSprint end-to-end and returns a JSON payload', async () => {
    const mock = createMockOctokit();
    const { server, client } = await connectClient(mock);
    try {
      const res = await client.callTool({
        name: 'submitSprint',
        arguments: { brief: 'wire mcp' },
      });
      const content = res.content as Array<{ type: string; text: string }>;
      assert.equal(content[0]!.type, 'text');
      const payload = JSON.parse(content[0]!.text) as {
        id: string;
        issueNumber: number;
        repo: string;
      };
      assert.equal(payload.repo, DEFAULT_REPO);
      assert.equal(payload.issueNumber, 1);
      assert.equal(payload.id, `${DEFAULT_REPO}#1`);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
