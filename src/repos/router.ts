import { readFileSync } from 'node:fs';
import type { ChannelRoute, ChannelRouter } from '../contracts/channel-router.js';

type ModelTier = ChannelRoute['defaultModel'];

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODEL_TIERS: ReadonlySet<ModelTier> = new Set(['opus', 'sonnet', 'haiku']);

interface ChannelsFile {
  version: number;
  channels: RawChannel[];
}

interface RawChannel {
  channelId: string;
  name?: string;
  repo: string;
  defaultBranch: string;
  defaultModel: ModelTier;
  allowedUserIds: string[];
  codeowners: string[];
}

export interface FileChannelRouterOptions {
  /** Where canonical clones live. Defaults to env `IFLEET_REPOS_DIR` or `/opt/ifleet/repos`. */
  reposDir?: string;
}

export class FileChannelRouter implements ChannelRouter {
  private readonly byId: Map<string, ChannelRoute>;
  private readonly ordered: ChannelRoute[];

  constructor(routes: ChannelRoute[]) {
    this.ordered = [...routes];
    this.byId = new Map(routes.map((r) => [r.channelId, r]));
  }

  static fromFile(path: string, opts: FileChannelRouterOptions = {}): FileChannelRouter {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = parseChannelsFile(raw);
    const reposDir = opts.reposDir ?? process.env['IFLEET_REPOS_DIR'] ?? '/opt/ifleet/repos';
    const routes = parsed.channels.map((c) => toRoute(c, reposDir));
    assertUniqueChannelIds(routes);
    return new FileChannelRouter(routes);
  }

  resolve(channelId: string): ChannelRoute | null {
    return this.byId.get(channelId) ?? null;
  }

  list(): ChannelRoute[] {
    return [...this.ordered];
  }
}

function toRoute(c: RawChannel, reposDir: string): ChannelRoute {
  // REPO_RE validated upstream in parseChannel — split always yields two elements.
  const [owner, name] = c.repo.split('/', 2) as [string, string];
  const workDir = `${reposDir}/${owner}-${name}`;
  return {
    channelId: c.channelId,
    repo: c.repo,
    workDir,
    defaultBranch: c.defaultBranch,
    defaultModel: c.defaultModel,
    allowedUserIds: [...c.allowedUserIds],
    codeowners: [...c.codeowners],
  };
}

function parseChannelsFile(raw: unknown): ChannelsFile {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('channels.json: root must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj['version'] !== 1) {
    throw new Error(`channels.json: unsupported version ${String(obj['version'])} (expected 1)`);
  }
  if (!Array.isArray(obj['channels'])) {
    throw new Error('channels.json: "channels" must be an array');
  }
  const channels = obj['channels'].map((c, i) => parseChannel(c, i));
  return { version: 1, channels };
}

function parseChannel(raw: unknown, index: number): RawChannel {
  const where = `channels[${index}]`;
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${where}: must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const channelId = expectString(r, 'channelId', where);
  if (!/^\d{5,32}$/.test(channelId)) {
    throw new Error(`${where}.channelId: must be a numeric Discord snowflake`);
  }
  const repo = expectString(r, 'repo', where);
  if (!REPO_RE.test(repo)) {
    throw new Error(`${where}.repo: must match "owner/name" (got ${JSON.stringify(repo)})`);
  }
  const defaultBranch = expectString(r, 'defaultBranch', where);
  const defaultModel = expectString(r, 'defaultModel', where);
  if (!MODEL_TIERS.has(defaultModel as ModelTier)) {
    throw new Error(`${where}.defaultModel: must be opus|sonnet|haiku (got ${defaultModel})`);
  }
  const allowedUserIds = expectStringArray(r, 'allowedUserIds', where);
  if (allowedUserIds.length === 0) {
    throw new Error(`${where}.allowedUserIds: must be non-empty`);
  }
  const codeowners = expectStringArray(r, 'codeowners', where);
  const name = typeof r['name'] === 'string' ? r['name'] : undefined;
  return {
    channelId,
    name,
    repo,
    defaultBranch,
    defaultModel: defaultModel as ModelTier,
    allowedUserIds,
    codeowners,
  };
}

function expectString(r: Record<string, unknown>, key: string, where: string): string {
  const v = r[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${where}.${key}: must be a non-empty string`);
  }
  return v;
}

function expectStringArray(r: Record<string, unknown>, key: string, where: string): string[] {
  const v = r[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new Error(`${where}.${key}: must be a string array`);
  }
  return [...v];
}

function assertUniqueChannelIds(routes: ChannelRoute[]): void {
  const seen = new Set<string>();
  for (const r of routes) {
    if (seen.has(r.channelId)) {
      throw new Error(`channels.json: duplicate channelId ${r.channelId}`);
    }
    seen.add(r.channelId);
  }
}
