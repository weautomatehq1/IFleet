import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendCostRecord, readCostLog, summarizeCosts, CostRecord } from '../costs.js';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('costs', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'costs-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true });
  });

  describe('appendCostRecord', () => {
    it('creates .omc/costs.json if missing', async () => {
      const record: CostRecord = {
        sprintId: 'sprint_1',
        taskId: 'task_1',
        role: 'architect',
        model: 'claude-opus-4-7',
        provider: 'claude',
        totalCostUsd: 0.15,
        durationMs: 30000,
        startedAt: '2026-05-13T15:00:00Z',
      };

      await appendCostRecord(testDir, record);

      const records = await readCostLog(testDir);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject(record);
    });

    it('appends to existing file without overwriting', async () => {
      const record1: CostRecord = {
        sprintId: 'sprint_1',
        taskId: 'task_1',
        role: 'architect',
        model: 'claude-opus-4-7',
        provider: 'claude',
        totalCostUsd: 0.15,
        durationMs: 30000,
        startedAt: '2026-05-13T15:00:00Z',
      };

      const record2: CostRecord = {
        sprintId: 'sprint_1',
        taskId: 'task_2',
        role: 'editor',
        model: 'claude-sonnet-4-6',
        provider: 'claude',
        totalCostUsd: 0.08,
        durationMs: 15000,
        startedAt: '2026-05-13T15:05:00Z',
      };

      await appendCostRecord(testDir, record1);
      await appendCostRecord(testDir, record2);

      const records = await readCostLog(testDir);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject(record1);
      expect(records[1]).toMatchObject(record2);
    });
  });

  describe('readCostLog', () => {
    it('returns empty array if file is missing', async () => {
      const records = await readCostLog(testDir);
      expect(records).toEqual([]);
    });

    it('returns all records from existing file', async () => {
      const record1: CostRecord = {
        sprintId: 'sprint_1',
        taskId: 'task_1',
        role: 'architect',
        model: 'claude-opus-4-7',
        provider: 'claude',
        totalCostUsd: 0.15,
        durationMs: 30000,
        startedAt: '2026-05-13T15:00:00Z',
      };

      const record2: CostRecord = {
        sprintId: 'sprint_2',
        taskId: 'task_3',
        role: 'reviewer',
        model: 'claude-haiku-4-5',
        provider: 'claude',
        totalCostUsd: 0.02,
        durationMs: 5000,
        startedAt: '2026-05-13T16:00:00Z',
      };

      await appendCostRecord(testDir, record1);
      await appendCostRecord(testDir, record2);

      const records = await readCostLog(testDir);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject(record1);
      expect(records[1]).toMatchObject(record2);
    });
  });

  describe('summarizeCosts', () => {
    it('groups by sprintId and sums costs', () => {
      const records: CostRecord[] = [
        {
          sprintId: 'sprint_1',
          taskId: 'task_1',
          role: 'architect',
          model: 'claude-opus-4-7',
          provider: 'claude',
          totalCostUsd: 0.15,
          durationMs: 30000,
          startedAt: '2026-05-13T15:00:00Z',
        },
        {
          sprintId: 'sprint_1',
          taskId: 'task_2',
          role: 'editor',
          model: 'claude-sonnet-4-6',
          provider: 'claude',
          totalCostUsd: 0.08,
          durationMs: 15000,
          startedAt: '2026-05-13T15:05:00Z',
        },
        {
          sprintId: 'sprint_2',
          taskId: 'task_3',
          role: 'reviewer',
          model: 'claude-haiku-4-5',
          provider: 'claude',
          totalCostUsd: 0.02,
          durationMs: 5000,
          startedAt: '2026-05-13T16:00:00Z',
        },
      ];

      const summary = summarizeCosts(records);

      expect(summary.grandTotalUsd).toBeCloseTo(0.25, 5);
      expect(summary.sprints).toHaveLength(2);

      const sprint1 = summary.sprints.find((s) => s.sprintId === 'sprint_1');
      expect(sprint1).toBeDefined();
      expect(sprint1!.totalCostUsd).toBeCloseTo(0.23, 5);
      expect(sprint1!.totalDurationMs).toBe(45000);
      expect(sprint1!.roleBreakdown).toEqual({ architect: 0.15, editor: 0.08 });
      expect(sprint1!.modelBreakdown).toEqual({
        'claude-opus-4-7': 0.15,
        'claude-sonnet-4-6': 0.08,
      });

      const sprint2 = summary.sprints.find((s) => s.sprintId === 'sprint_2');
      expect(sprint2).toBeDefined();
      expect(sprint2!.totalCostUsd).toBeCloseTo(0.02, 5);
      expect(sprint2!.totalDurationMs).toBe(5000);
      expect(sprint2!.roleBreakdown).toEqual({ reviewer: 0.02 });
      expect(sprint2!.modelBreakdown).toEqual({ 'claude-haiku-4-5': 0.02 });
    });

    it('handles empty records array', () => {
      const summary = summarizeCosts([]);
      expect(summary.sprints).toEqual([]);
      expect(summary.grandTotalUsd).toBe(0);
    });

    it('accumulates role and model breakdowns correctly', () => {
      const records: CostRecord[] = [
        {
          sprintId: 'sprint_1',
          taskId: 'task_1',
          role: 'architect',
          model: 'claude-opus-4-7',
          provider: 'claude',
          totalCostUsd: 0.10,
          durationMs: 20000,
          startedAt: '2026-05-13T15:00:00Z',
        },
        {
          sprintId: 'sprint_1',
          taskId: 'task_2',
          role: 'architect',
          model: 'claude-opus-4-7',
          provider: 'claude',
          totalCostUsd: 0.12,
          durationMs: 25000,
          startedAt: '2026-05-13T15:05:00Z',
        },
      ];

      const summary = summarizeCosts(records);
      expect(summary.sprints).toHaveLength(1);
      const sprint = summary.sprints[0]!;

      expect(sprint.roleBreakdown).toEqual({ architect: 0.22 });
      expect(sprint.modelBreakdown).toEqual({ 'claude-opus-4-7': 0.22 });
    });
  });
});
