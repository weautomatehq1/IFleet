import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordOutbox } from '../discord-outbox.js';

function makeDb(): Database.Database {
  return new Database(':memory:');
}

describe('DiscordOutbox', () => {
  let db: Database.Database;
  let outbox: DiscordOutbox;

  beforeEach(() => {
    db = makeDb();
    outbox = new DiscordOutbox(db);
  });

  afterEach(() => {
    db.close();
  });

  // ---------------------------------------------------------------------------
  // enqueue
  // ---------------------------------------------------------------------------

  describe('enqueue', () => {
    it('inserts a row in pending state with zero attempts', () => {
      const id = outbox.enqueue('broadcast', '{"content":"hello"}');
      expect(id).toBeGreaterThan(0);
      const row = db.prepare('SELECT * FROM discord_outbox WHERE id = ?').get(id) as {
        state: string;
        attempts: number;
        channel: string;
        payload: string;
      };
      expect(row.state).toBe('pending');
      expect(row.attempts).toBe(0);
      expect(row.channel).toBe('broadcast');
      expect(row.payload).toBe('{"content":"hello"}');
    });

    it('returns distinct ids for successive inserts', () => {
      const id1 = outbox.enqueue('broadcast', '{"n":1}');
      const id2 = outbox.enqueue('broadcast', '{"n":2}');
      expect(id2).toBeGreaterThan(id1);
    });

    it('throws on invalid JSON payload', () => {
      expect(() => outbox.enqueue('broadcast', 'not-json')).toThrow('not valid JSON');
    });
  });

  // ---------------------------------------------------------------------------
  // drainOnce — happy path
  // ---------------------------------------------------------------------------

  describe('drainOnce — sender succeeds', () => {
    it('marks the row sent and returns sent=1', async () => {
      const id = outbox.enqueue('broadcast', '{"content":"hello"}');
      const sender = vi.fn().mockResolvedValue(undefined);

      const result = await outbox.drainOnce({ send: sender });

      expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
      expect(sender).toHaveBeenCalledOnce();
      expect(sender).toHaveBeenCalledWith('broadcast', '{"content":"hello"}');

      const row = db.prepare('SELECT state, sent_at, last_attempt_at FROM discord_outbox WHERE id = ?').get(id) as {
        state: string;
        sent_at: number | null;
        last_attempt_at: number | null;
      };
      expect(row.state).toBe('sent');
      expect(row.sent_at).not.toBeNull();
      expect(row.last_attempt_at).not.toBeNull();
    });

    it('does not re-drain an already-sent row', async () => {
      outbox.enqueue('broadcast', '{"content":"msg"}');
      const sender = vi.fn().mockResolvedValue(undefined);
      await outbox.drainOnce({ send: sender });
      const result2 = await outbox.drainOnce({ send: sender });
      expect(result2).toEqual({ sent: 0, retried: 0, failed: 0 });
      expect(sender).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // drainOnce — transient failure / retry
  // ---------------------------------------------------------------------------

  describe('drainOnce — sender throws', () => {
    it('keeps row pending with attempts+1 and records last_error', async () => {
      const id = outbox.enqueue('broadcast', '{"content":"msg"}');
      const sender = vi.fn().mockRejectedValue(new Error('network error'));

      const result = await outbox.drainOnce({ send: sender, maxAttempts: 5 });

      expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });

      const row = db.prepare('SELECT state, attempts, last_error FROM discord_outbox WHERE id = ?').get(id) as {
        state: string;
        attempts: number;
        last_error: string | null;
      };
      expect(row.state).toBe('pending');
      expect(row.attempts).toBe(1);
      expect(row.last_error).toContain('network error');
    });

    it('dead-letters the row after maxAttempts total failures', async () => {
      const id = outbox.enqueue('broadcast', '{"content":"msg"}');
      const sender = vi.fn().mockRejectedValue(new Error('timeout'));

      for (let i = 0; i < 5; i++) {
        await outbox.drainOnce({ send: sender, maxAttempts: 5 });
      }

      const row = db.prepare('SELECT state, attempts FROM discord_outbox WHERE id = ?').get(id) as {
        state: string;
        attempts: number;
      };
      expect(row.state).toBe('failed');
      expect(row.attempts).toBe(5);
    });

    it('returns failed=1 on the drain that exhausts maxAttempts', async () => {
      outbox.enqueue('broadcast', '{"content":"msg"}');
      const sender = vi.fn().mockRejectedValue(new Error('err'));

      let lastResult = { sent: 0, retried: 0, failed: 0 };
      for (let i = 0; i < 5; i++) {
        lastResult = await outbox.drainOnce({ send: sender, maxAttempts: 5 });
      }
      expect(lastResult.failed).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // drainOnce — batch limit
  // ---------------------------------------------------------------------------

  describe('drainOnce — batch', () => {
    it('processes at most `batch` rows per call', async () => {
      for (let i = 0; i < 5; i++) outbox.enqueue('broadcast', `{"n":${i}}`);
      const sender = vi.fn().mockResolvedValue(undefined);
      const result = await outbox.drainOnce({ send: sender, batch: 3 });
      expect(result.sent).toBe(3);
      expect(sender).toHaveBeenCalledTimes(3);
    });
  });

  // ---------------------------------------------------------------------------
  // deadLetterEntries
  // ---------------------------------------------------------------------------

  describe('deadLetterEntries', () => {
    it('returns failed rows with full metadata', async () => {
      outbox.enqueue('broadcast', '{"content":"dead"}');
      const sender = vi.fn().mockRejectedValue(new Error('permanent'));

      for (let i = 0; i < 5; i++) {
        await outbox.drainOnce({ send: sender, maxAttempts: 5 });
      }

      const entries = outbox.deadLetterEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.state).toBe('failed');
      expect(entries[0]!.attempts).toBe(5);
      expect(entries[0]!.channel).toBe('broadcast');
      expect(entries[0]!.lastError).toContain('permanent');
    });

    it('returns empty array when there are no failed rows', () => {
      expect(outbox.deadLetterEntries()).toEqual([]);
    });

    it('does not include sent or pending rows', async () => {
      outbox.enqueue('broadcast', '{"content":"pending"}');
      const sender = vi.fn().mockResolvedValue(undefined);
      await outbox.drainOnce({ send: sender });
      expect(outbox.deadLetterEntries()).toEqual([]);
    });
  });
});
