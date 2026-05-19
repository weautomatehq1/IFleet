// Two adapter registration patterns:
//
// 1. Orchestrator-level adapters (e.g. 'claude-cli.ts'):
//    Explicit side-effect import triggers `registerAdapter(...)` at load time.
//
// 2. Pipeline-level adapters (e.g. 'pipeline-registry.ts'):
//    Self-registers via `registerPipelineAdapter(...)` at module bottom; the
//    re-export below triggers module load and activates the registration.
//
// Adding a new orchestrator adapter = drop a file + add `import './file.ts'` above.
// Adding a new pipeline adapter = drop a file + add its exports to this index.
import './claude-cli.ts';

export {
  ADAPTER_ENV_VAR,
  DEFAULT_ADAPTER_NAME,
  __resetAdapterRegistry,
  getActiveAdapter,
  hasAdapter,
  listAdapters,
  registerAdapter,
  resolveAdapter,
  type AdapterFactory,
} from './registry.ts';

export {
  CLAUDE_CLI_ADAPTER_NAME,
  createClaudeCliAdapter,
  type ClaudeCliAdapterOptions,
} from './claude-cli.ts';

export {
  __resetPipelineAdapterRegistry,
  createClaudeCliPipelineAdapter,
  getActivePipelineAdapter,
  hasPipelineAdapter,
  listPipelineAdapters,
  registerPipelineAdapter,
  resolvePipelineAdapter,
  type ClaudeCliPipelineOptions,
  type PipelineAdapterFactory,
} from './pipeline-registry.ts';
