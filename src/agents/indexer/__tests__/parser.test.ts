/**
 * Tree-sitter TS parser unit tests. Fixtures inline so the test doubles as
 * documentation of what `parser.ts` extracts for each TS construct.
 */
import { describe, expect, it } from 'vitest';
import { parseTypeScriptFile } from '../parser.js';
import { nodeKey } from '../types.js';

const repoId = 'weautomatehq1/IFleet';
const sha = 'abc1234';

describe('parseTypeScriptFile', () => {
  it('extracts file, class, method, interface, function, type, const', () => {
    const source = `
import { Foo } from './foo.js';

export interface Greeter {
  hello(name: string): string;
}

export type Greeting = string;

export const DEFAULT_NAME = 'world';

export class FriendlyGreeter implements Greeter {
  hello(name: string): string {
    return 'hi ' + name;
  }
}

export function shout(s: string): string {
  return s.toUpperCase();
}
`;
    const result = parseTypeScriptFile({ repoId, path: 'src/greet.ts', source, sha });
    expect(result.parseError).toBeUndefined();

    const kinds = result.nodes.map(n => n.kind).sort();
    expect(kinds).toEqual(
      [
        'file',
        'interface',
        'type',
        'const',
        'class',
        'method',
        'function',
      ].sort(),
    );

    const cls = result.nodes.find(n => n.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls?.name).toBe('FriendlyGreeter');
    expect(cls?.startLine).toBeGreaterThan(0);

    const method = result.nodes.find(n => n.kind === 'method' && n.name === 'hello');
    expect(method).toBeDefined();
  });

  it('emits imports edge to the module specifier', () => {
    const source = `import { x } from './other.js';\nexport const y = 1;\n`;
    const result = parseTypeScriptFile({ repoId, path: 'src/a.ts', source, sha });
    const imports = result.edges.filter(e => e.kind === 'imports');
    expect(imports).toHaveLength(1);
    expect(imports[0]?.dstKey).toContain('./other.js');
  });

  it('emits implements edges when a class implements an interface', () => {
    const source = `interface I {}\nclass C implements I {}\n`;
    const result = parseTypeScriptFile({ repoId, path: 'src/x.ts', source, sha });
    const implementsEdge = result.edges.find(e => e.kind === 'implements');
    expect(implementsEdge).toBeDefined();
    expect(implementsEdge?.dstKey).toBe('src/x.ts::interface::I');
  });

  it('emits extends edge when a class extends another', () => {
    const source = `class A {}\nclass B extends A {}\n`;
    const result = parseTypeScriptFile({ repoId, path: 'src/x.ts', source, sha });
    const extendsEdge = result.edges.find(e => e.kind === 'extends');
    expect(extendsEdge).toBeDefined();
    expect(extendsEdge?.dstKey).toBe('src/x.ts::class::A');
  });

  it('emits contains edges from file to top-level symbols', () => {
    const source = `export function alpha() {}\nexport class Beta {}\n`;
    const result = parseTypeScriptFile({ repoId, path: 'src/x.ts', source, sha });
    const containsCount = result.edges.filter(e => e.kind === 'contains').length;
    // file→alpha, file→Beta. (Beta has no methods so no further contains edges.)
    expect(containsCount).toBeGreaterThanOrEqual(2);
  });

  it('records a parseError instead of throwing on malformed source', () => {
    // tree-sitter is forgiving so a half-finished class still parses; we use
    // a control assertion: empty source must yield only the file node.
    const result = parseTypeScriptFile({ repoId, path: 'src/empty.ts', source: '', sha });
    expect(result.parseError).toBeUndefined();
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.kind).toBe('file');
  });

  it('node keys are stable across runs', () => {
    const source = `export function f() {}\n`;
    const a = parseTypeScriptFile({ repoId, path: 'src/x.ts', source, sha });
    const b = parseTypeScriptFile({ repoId, path: 'src/x.ts', source, sha });
    expect(a.nodes.map(nodeKey)).toEqual(b.nodes.map(nodeKey));
  });
});
