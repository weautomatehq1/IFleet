/**
 * Tree-sitter TypeScript parser → {@link ParsedFile}. M3.W1 covers TS only;
 * Python + Go land at M3.W5 per docs/elevation/upgrades/03-knowledge-graph.md.
 *
 * Chunking decision (ADR-0003): one node per symbol, NOT per line. We extract:
 *   - `class`, `interface`, `function`, `method`, `type`, `const`, `enum`
 *   - `file` node so file-level imports/exports have a parent to link to
 *
 * Edges emitted:
 *   - `imports`     — file → file (best-effort, module specifier rather than resolved path)
 *   - `extends`     — class → class
 *   - `implements`  — class → interface
 *   - `contains`    — file → top-level symbol, class → method, etc.
 *
 * `calls` and `uses_type` are intentionally deferred. RepoGraph's authors note
 * that resolving call targets requires a symbol table (out of scope for W1).
 * We can layer those in M3.W3 alongside the architect integration.
 */

import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import type { CodeEdge, CodeNode, CodeNodeKind, ParsedFile } from './types.js';
import { nodeKey } from './types.js';

const tsLang = (TypeScript as { typescript: unknown; tsx: unknown }).typescript;
const tsxLang = (TypeScript as { typescript: unknown; tsx: unknown }).tsx;

function newParser(forTsx: boolean): Parser {
  const p = new Parser();
  // tree-sitter@0.21 types setLanguage as `(language?: any) => void`, so no cast needed.
  p.setLanguage(forTsx ? tsxLang : tsLang);
  return p;
}

interface ParseOpts {
  repoId: string;
  path: string;
  source: string;
  sha: string;
}

export function parseTypeScriptFile(opts: ParseOpts): ParsedFile {
  const { repoId, path, source, sha } = opts;
  const isTsx = path.endsWith('.tsx');
  const parser = newParser(isTsx);
  let tree: Parser.Tree;
  try {
    tree = parser.parse(source);
  } catch (err) {
    return {
      path,
      nodes: [],
      edges: [],
      parseError: err instanceof Error ? err.message : String(err),
    };
  }

  const fileNode: CodeNode = {
    repoId,
    path,
    kind: 'file',
    name: path,
    sha,
  };
  const nodes: CodeNode[] = [fileNode];
  const edges: CodeEdge[] = [];
  const fileKey = nodeKey(fileNode);

  const containerStack: Array<{ key: string; kind: CodeNodeKind }> = [];

  function pushNode(node: CodeNode): void {
    nodes.push(node);
    const container = containerStack[containerStack.length - 1];
    edges.push({
      srcKey: container ? container.key : fileKey,
      dstKey: nodeKey(node),
      kind: 'contains',
    });
  }

  function getName(n: Parser.SyntaxNode): string | undefined {
    const name = n.childForFieldName('name');
    return name?.text;
  }

  function lineRange(n: Parser.SyntaxNode): { startLine: number; endLine: number } {
    return {
      startLine: n.startPosition.row + 1,
      endLine: n.endPosition.row + 1,
    };
  }

  function signature(n: Parser.SyntaxNode): string {
    // Take the first line as the signature; tree-sitter gives positions in 0-indexed rows.
    const firstLine = source.slice(n.startIndex, n.startIndex + Math.min(240, n.endIndex - n.startIndex));
    return firstLine.split('\n')[0]?.trim() ?? '';
  }

  function walk(node: Parser.SyntaxNode): void {
    const t = node.type;

    let pushedContainer: { key: string; kind: CodeNodeKind } | undefined;

    switch (t) {
      case 'import_statement': {
        const src = node.childForFieldName('source')?.text;
        if (src) {
          // Module specifier is included verbatim — resolution to a concrete file
          // happens in M3.W4 cross-repo work.
          const moduleSpec = src.replace(/^['"]|['"]$/g, '');
          const importedFileKey = `${moduleSpec}::file::${moduleSpec}`;
          edges.push({ srcKey: fileKey, dstKey: importedFileKey, kind: 'imports' });
        }
        break;
      }
      case 'class_declaration': {
        const name = getName(node);
        if (name) {
          const cn: CodeNode = {
            repoId,
            path,
            kind: 'class',
            name,
            sha,
            signature: signature(node),
            ...lineRange(node),
          };
          pushNode(cn);
          pushedContainer = { key: nodeKey(cn), kind: 'class' };
          const heritage = node.children.filter(c => c.type === 'class_heritage');
          for (const h of heritage) {
            for (const clause of h.children) {
              if (clause.type === 'extends_clause') {
                const ext = clause.children.find(c => c.type === 'identifier' || c.type === 'type_identifier');
                if (ext) {
                  edges.push({
                    srcKey: nodeKey(cn),
                    dstKey: `${path}::class::${ext.text}`,
                    kind: 'extends',
                  });
                }
              } else if (clause.type === 'implements_clause') {
                for (const id of clause.children) {
                  if (id.type === 'type_identifier' || id.type === 'identifier') {
                    edges.push({
                      srcKey: nodeKey(cn),
                      dstKey: `${path}::interface::${id.text}`,
                      kind: 'implements',
                    });
                  }
                }
              }
            }
          }
        }
        break;
      }
      case 'interface_declaration': {
        const name = getName(node);
        if (name) {
          const cn: CodeNode = {
            repoId,
            path,
            kind: 'interface',
            name,
            sha,
            signature: signature(node),
            ...lineRange(node),
          };
          pushNode(cn);
          pushedContainer = { key: nodeKey(cn), kind: 'interface' };
        }
        break;
      }
      case 'type_alias_declaration': {
        const name = getName(node);
        if (name) {
          pushNode({
            repoId,
            path,
            kind: 'type',
            name,
            sha,
            signature: signature(node),
            ...lineRange(node),
          });
        }
        break;
      }
      case 'enum_declaration': {
        const name = getName(node);
        if (name) {
          pushNode({
            repoId,
            path,
            kind: 'enum',
            name,
            sha,
            signature: signature(node),
            ...lineRange(node),
          });
        }
        break;
      }
      case 'function_declaration': {
        const name = getName(node);
        if (name) {
          pushNode({
            repoId,
            path,
            kind: 'function',
            name,
            sha,
            signature: signature(node),
            ...lineRange(node),
          });
        }
        break;
      }
      case 'method_definition': {
        const name = getName(node);
        if (name) {
          pushNode({
            repoId,
            path,
            kind: 'method',
            name,
            sha,
            signature: signature(node),
            ...lineRange(node),
          });
        }
        break;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        // Surface top-level consts only (declared at file scope or inside namespace).
        const declarator = node.children.find(c => c.type === 'variable_declarator');
        if (declarator && containerStack.length === 0) {
          const name = declarator.childForFieldName('name');
          if (name && name.type === 'identifier') {
            pushNode({
              repoId,
              path,
              kind: 'const',
              name: name.text,
              sha,
              signature: signature(node),
              ...lineRange(node),
            });
          }
        }
        break;
      }
    }

    if (pushedContainer) containerStack.push(pushedContainer);
    for (const child of node.children) walk(child);
    if (pushedContainer) containerStack.pop();
  }

  walk(tree.rootNode);
  return { path, nodes, edges };
}
