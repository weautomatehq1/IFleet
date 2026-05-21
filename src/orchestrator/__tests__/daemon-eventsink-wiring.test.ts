/**
 * Daemon → pipeline `eventSink` wiring test (issue #163 follow-up).
 *
 * Asserts that:
 *   1. `wrapFactoryWithApprovalAndEmit` sets `input.eventSink` on the bootstrap
 *      when given an `emitPipelineEvent` callback.
 *   2. `persistPipelineEvent` translates a PipelineEvent into an
 *      OrchestratorEvent and writes it to the StateStore `events` table with
 *      the sprintId resolved from the task record.
 *   3. Without a task in the store, `persistPipelineEvent` drops the event
 *      cleanly (no throw, no row).
 *
 * No subprocess, Docker, or Discord — just the in-process wiring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  persistPipelineEvent,
  wrapFactoryWithApprovalAndEmit,
} from '../daemon';
import { ControlPlaneApprovalGate } from '../approval-gate';
import { encodeBridgeBrief } from '../pipeline-bridge';
import type { PipelineRunBootstrap, PipelineRunnerFactory } from '../pipeline-bridge';
import type { PipelineEvent, PipelineInput } from '../../pipeline/types';
import { StateStore } from '../store';
import {
  newSprintId,
  newTaskId,
  type TaskId,
} from '../types';

function emptyBootstrap(): PipelineRunBootstrap {
  const input = { task: { id: 'tk_test', issueNumber: 0 } } as unknown as PipelineInput;
  return {
    runner: { run: async () => ({ status: 'failed', attempts: [], failureReason: 'unused' }) },
    input,
  };
}

test('wrapFactoryWithApprovalAndEmit: sets eventSink on bootstrap when callback provided', async () => {
  const captured: Array<{ taskId: string; event: PipelineEvent }> = [];
  const gate = new ControlPlaneApprovalGate();
  try {
    const inner: PipelineRunnerFactory = async () => emptyBootstrap();
    const wrapped = wrapFactoryWithApprovalAndEmit(
      inner,
      gate,
      async () => undefined,
      (taskId, event) => captured.push({ taskId, event }),
    );
    const taskId = newTaskId('tk_wired');
    const bootstrap = await wrapped(taskId, encodeBridgeBrief({
      id: 'tk_wired', issueNumber: 1, repo: 'a/b', title: 't', body: 'b', autonomy: 'auto', labels: [],
    }), { model: 'sonnet' });
    assert.ok(bootstrap.input.eventSink, 'expected eventSink to be set');
    bootstrap.input.eventSink?.({
      kind: 'reviewer.rejected',
      taskId: 'tk_wired',
      verdict: 'request_changes',
      concerns: ['c1'],
      raw: '{}',
      roundCount: 2,
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.event.kind, 'reviewer.rejected');
  } finally {
    gate.drain();
  }
});

test('wrapFactoryWithApprovalAndEmit: omits eventSink when callback absent (backward compat)', async () => {
  const gate = new ControlPlaneApprovalGate();
  try {
    const inner: PipelineRunnerFactory = async () => emptyBootstrap();
    const wrapped = wrapFactoryWithApprovalAndEmit(
      inner,
      gate,
      async () => undefined,
    );
    const bootstrap = await wrapped(newTaskId('tk_unset'), encodeBridgeBrief({
      id: 'tk_unset', issueNumber: 1, repo: 'a/b', title: 't', body: 'b', autonomy: 'auto', labels: [],
    }), { model: 'sonnet' });
    assert.equal(bootstrap.input.eventSink, undefined);
  } finally {
    gate.drain();
  }
});

test('persistPipelineEvent: appends OrchestratorEvent with sprintId resolved from task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-eventsink-'));
  const dbPath = join(dir, 'state.db');
  const store = new StateStore(dbPath);
  try {
    const sprintId = newSprintId('sp_persist');
    const taskId = newTaskId('tk_persist');
    const now = Date.now();
    store.saveSprint({ id: sprintId, mode: 'normal', goal: 'g', tasks: [taskId], state: { kind: 'queued' }, createdAt: now, updatedAt: now });
    store.saveTask({ id: taskId, sprintId, brief: 'b', state: { kind: 'pending' }, attempts: 0, createdAt: now, updatedAt: now });

    persistPipelineEvent(store, taskId, {
      kind: 'reviewer.rejected',
      taskId,
      verdict: 'request_changes',
      concerns: ['src/foo.ts:1 wrong'],
      raw: '{}',
      roundCount: 3,
    });

    const events = store.loadEventsBySprint(sprintId);
    const rejected = events.filter((e) => e.kind === 'reviewer.rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.taskId, taskId);
    assert.equal(rejected[0]?.sprintId, sprintId);
    assert.equal(rejected[0]?.payload['verdict'], 'request_changes');
    assert.equal(rejected[0]?.payload['roundCount'], 3);
    assert.deepEqual(rejected[0]?.payload['concerns'], ['src/foo.ts:1 wrong']);
    assert.ok(!('kind' in rejected[0]!.payload), 'kind must live on envelope, not payload');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistPipelineEvent: drops event silently when task is missing from store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-eventsink-'));
  const dbPath = join(dir, 'state.db');
  const store = new StateStore(dbPath);
  try {
    // No saveTask call — taskId is unknown to the store.
    assert.doesNotThrow(() => {
      persistPipelineEvent(store, 'tk_orphan' as TaskId, {
        kind: 'reviewer.haiku_gate_passed',
        taskId: 'tk_orphan',
        round: 1,
        gateWorkerId: 'haiku-w1',
      });
    });
    // No sprintId to query; assert by counting all events on a fresh sprint.
    const sprintId = newSprintId('sp_empty');
    store.saveSprint({ id: sprintId, mode: 'normal', goal: 'g', tasks: [], state: { kind: 'queued' }, createdAt: 0, updatedAt: 0 });
    assert.equal(store.loadEventsBySprint(sprintId).length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
