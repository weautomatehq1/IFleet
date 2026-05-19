#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const REPOS = [
  'weautomatehq1/IFleet',
  'weautomatehq1/factory',
  'weautomatehq1/spec-template',
];

async function main(): Promise<void> {
  mkdirSync('.ifleet/eval/raw', { recursive: true });

  for (const repo of REPOS) {
    console.log(`Dumping issues from ${repo}...`);
    const { stdout } = await exec('gh', [
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'closed',
      '--limit',
      '200',
      '--json',
      'number,title,body,closedAt,labels,url',
    ]);

    const filename = repo.replace('/', '_');
    writeFileSync(`.ifleet/eval/raw/${filename}.json`, stdout);
    console.log(`  → ${filename}.json`);
  }

  console.log('\nDone. Issues dumped to .ifleet/eval/raw/');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
