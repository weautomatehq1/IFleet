import { describe, it, expect } from 'vitest';
import { parseArgs, helpText, formatEventLine } from '../tail-cli.js';
import type { Event } from '../types.js';

describe('parseArgs', () => {
  it('parses a positional sprintId', () => {
    expect(parseArgs(['sprint-1'])).toMatchObject({ sprintId: 'sprint-1', json: false, help: false });
  });

  it('parses --json and --from flags', () => {
    const args = parseArgs(['s', '--json', '--from', '1234']);
    expect(args.json).toBe(true);
    expect(args.fromTs).toBe(1234);
    expect(args.sprintId).toBe('s');
  });

  it('parses --help and -h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('throws on unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });

  it('throws on --from without value', () => {
    expect(() => parseArgs(['s', '--from'])).toThrow(/--from requires/);
  });

  it('throws on --from with non-numeric value', () => {
    expect(() => parseArgs(['s', '--from', 'abc'])).toThrow(/must be a number/);
  });

  it('parses --root path override', () => {
    expect(parseArgs(['s', '--root', '/tmp/x']).rootDir).toBe('/tmp/x');
  });
});

describe('helpText', () => {
  it('mentions sprintId and the --json/--from options', () => {
    const text = helpText();
    expect(text).toMatch(/sprintId/);
    expect(text).toMatch(/--json/);
    expect(text).toMatch(/--from/);
  });
});

describe('formatEventLine', () => {
  it('renders a plain (no-color) line containing kind and ids', () => {
    const event: Event = {
      ts: 0,
      sprintId: 's',
      taskId: 't1',
      workerId: 'w1',
      kind: 'task.done',
      payload: { ok: true },
    };
    const line = formatEventLine(event, false);
    expect(line).toMatch(/task.done/);
    expect(line).toMatch(/task=t1/);
    expect(line).toMatch(/worker=w1/);
    expect(line).not.toMatch(/\[/);
  });

  it('includes ANSI color codes when useColor=true', () => {
    const event: Event = { ts: 0, sprintId: 's', kind: 'task.done', payload: {} };
    const line = formatEventLine(event, true);
    expect(line).toMatch(/\[/);
  });
});
