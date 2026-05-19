import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager } from './helpers';

test('startSprint: taskMode prepends a `mode:` header to each new brief', () => {
  const h = makeManager();
  try {
    const rec = h.manager.startSprint({
      mode: 'normal',
      taskMode: 'ralph',
      goal: 'fix a flaky test',
      newTaskBriefs: ['original brief text'],
    });
    const task = h.env.store.loadTask(rec.tasks[0]!);
    assert.ok(task, 'task persisted');
    assert.ok(
      task.brief.startsWith('mode: ralph\n\n'),
      `expected mode header prefix, got: ${task.brief.slice(0, 40)}`,
    );
    assert.ok(task.brief.endsWith('original brief text'));
  } finally {
    h.env.cleanup();
  }
});

test('startSprint: omitted taskMode leaves brief untouched', () => {
  const h = makeManager();
  try {
    const rec = h.manager.startSprint({
      mode: 'normal',
      goal: 'g',
      newTaskBriefs: ['plain'],
    });
    const task = h.env.store.loadTask(rec.tasks[0]!);
    assert.equal(task?.brief, 'plain');
  } finally {
    h.env.cleanup();
  }
});
