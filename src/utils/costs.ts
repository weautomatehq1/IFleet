import { promises as fs } from 'fs';
import { join } from 'path';

export interface CostRecord {
  sprintId: string;
  taskId: string;
  role: 'architect' | 'editor' | 'reviewer' | 'doctor';
  model: string;
  provider: 'claude' | 'codex';
  totalCostUsd: number;
  durationMs: number;
  startedAt: string;
  worktreePath?: string;
}

export interface CostSummary {
  sprints: Array<{
    sprintId: string;
    totalCostUsd: number;
    totalDurationMs: number;
    roleBreakdown: Record<string, number>;
    modelBreakdown: Record<string, number>;
  }>;
  grandTotalUsd: number;
}

export async function appendCostRecord(repoRoot: string, record: CostRecord): Promise<void> {
  const omcDir = join(repoRoot, '.omc');
  const costFile = join(omcDir, 'costs.json');

  try {
    await fs.mkdir(omcDir, { recursive: true });
  } catch {
    // Directory might already exist
  }

  const line = JSON.stringify(record) + '\n';
  await fs.appendFile(costFile, line, 'utf-8');
}

export async function readCostLog(repoRoot: string): Promise<CostRecord[]> {
  const costFile = join(repoRoot, '.omc', 'costs.json');

  let content: string;
  try {
    content = await fs.readFile(costFile, 'utf-8');
  } catch {
    return [];
  }
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CostRecord];
      } catch {
        console.warn('[costs] skipping unparseable line in costs.json:', line.slice(0, 120));
        return [];
      }
    });
}

export function summarizeCosts(records: CostRecord[]): CostSummary {
  const sprintMap = new Map<
    string,
    {
      totalCostUsd: number;
      totalDurationMs: number;
      roleBreakdown: Map<string, number>;
      modelBreakdown: Map<string, number>;
    }
  >();

  for (const record of records) {
    let sprint = sprintMap.get(record.sprintId);
    if (!sprint) {
      sprint = {
        totalCostUsd: 0,
        totalDurationMs: 0,
        roleBreakdown: new Map(),
        modelBreakdown: new Map(),
      };
      sprintMap.set(record.sprintId, sprint);
    }

    sprint.totalCostUsd += record.totalCostUsd;
    sprint.totalDurationMs += record.durationMs;

    const currentRole = sprint.roleBreakdown.get(record.role) ?? 0;
    sprint.roleBreakdown.set(record.role, currentRole + record.totalCostUsd);

    const currentModel = sprint.modelBreakdown.get(record.model) ?? 0;
    sprint.modelBreakdown.set(record.model, currentModel + record.totalCostUsd);
  }

  const sprints = Array.from(sprintMap.entries()).map(([sprintId, sprint]) => ({
    sprintId,
    totalCostUsd: sprint.totalCostUsd,
    totalDurationMs: sprint.totalDurationMs,
    roleBreakdown: Object.fromEntries(sprint.roleBreakdown),
    modelBreakdown: Object.fromEntries(sprint.modelBreakdown),
  }));

  const grandTotalUsd = sprints.reduce((sum, sprint) => sum + sprint.totalCostUsd, 0);

  return { sprints, grandTotalUsd };
}
