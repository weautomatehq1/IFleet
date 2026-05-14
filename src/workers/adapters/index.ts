// Import every adapter module so each one's `registerAdapter(...)` runs at
// load time. Adding a new backend = drop a file in this folder + add it here.
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
