import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import ts from 'typescript';

const SEMANTIC_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.mts', '.py', '.ts', '.tsx']);

export interface SemanticMergeCandidateInput {
  id: string;
  files: Record<string, string | null>;
}

export interface SemanticMergeInput {
  baseFiles: Record<string, string | null>;
  candidates: SemanticMergeCandidateInput[];
}

export interface SemanticMergeAppliedUnit {
  path: string;
  unit: string;
  candidateId: string;
  strategy: 'whole-file' | 'ast-add' | 'ast-update' | 'ast-delete';
}

export interface SemanticMergeConflict {
  path: string;
  unit: string;
  candidateIds: string[];
  reason: string;
}

export interface SemanticMergePlan {
  engine: 'hawk-semantic-v2';
  primaryCandidateId: string;
  candidateIds: string[];
  filesAnalyzed: number;
  astFilesAnalyzed: number;
  automaticallyMergedUnits: SemanticMergeAppliedUnit[];
  conflicts: SemanticMergeConflict[];
}

export interface SemanticMergeResult {
  files: Record<string, string | null>;
  plan: SemanticMergePlan;
}

interface SemanticUnit {
  key: string;
  kind: string;
  start: number;
  end: number;
  text: string;
  indent: string;
  hash: string;
  order: number;
  containerKey?: string;
}

interface SemanticContainer {
  key: string;
  kind: string;
  start: number;
  end: number;
  insertionPoint: number;
  indent: string;
  text: string;
  headerHash: string;
  order: number;
}

interface ParsedSource {
  source: string;
  units: Map<string, SemanticUnit>;
  containers: Map<string, SemanticContainer>;
}

interface TextOperation {
  start: number;
  end: number;
  text: string;
  unit: string;
  strategy: SemanticMergeAppliedUnit['strategy'];
  order: number;
}

/**
 * Deterministically combines compatible candidate edits before an LLM sees
 * the merge. TypeScript/JavaScript changes are compared through the compiler
 * AST; Python changes use indentation-aware declaration boundaries. Edits in
 * separate symbols can coexist even when they touch the same file. Ambiguous
 * edits are retained as explicit semantic conflicts instead of being guessed
 * through patch concatenation.
 */
export function buildSemanticMerge(input: SemanticMergeInput): SemanticMergeResult {
  if (input.candidates.length < 2) {
    throw new Error('Semantic merge requires at least two candidates.');
  }
  const files: Record<string, string | null> = { ...input.baseFiles };
  const owners = new Map<string, Set<string>>();
  const plan: SemanticMergePlan = {
    engine: 'hawk-semantic-v2',
    primaryCandidateId: input.candidates[0]?.id ?? '',
    candidateIds: input.candidates.map((candidate) => candidate.id),
    filesAnalyzed: Object.keys(input.baseFiles).length,
    astFilesAnalyzed: 0,
    automaticallyMergedUnits: [],
    conflicts: [],
  };

  for (const candidate of input.candidates) {
    for (const [path, incoming] of Object.entries(candidate.files)) {
      const base = input.baseFiles[path] ?? null;
      const current = files[path] ?? null;
      if (incoming === base || incoming === current) {
        if (incoming === current && incoming !== base) addOwner(owners, path, candidate.id);
        continue;
      }
      if (current === base) {
        files[path] = incoming;
        addOwner(owners, path, candidate.id);
        plan.automaticallyMergedUnits.push({
          path,
          unit: 'file',
          candidateId: candidate.id,
          strategy: 'whole-file',
        });
        continue;
      }
      if (
        typeof base === 'string' &&
        typeof current === 'string' &&
        typeof incoming === 'string' &&
        SEMANTIC_EXTENSIONS.has(extname(path).toLowerCase())
      ) {
        plan.astFilesAnalyzed += 1;
        const merged = mergeAstFile(path, base, current, incoming, candidate.id, [
          ...(owners.get(path) ?? []),
        ]);
        files[path] = merged.content;
        for (const applied of merged.applied) {
          plan.automaticallyMergedUnits.push({
            path,
            candidateId: candidate.id,
            unit: applied.unit,
            strategy: applied.strategy,
          });
        }
        plan.conflicts.push(...merged.conflicts);
        if (merged.applied.length > 0) addOwner(owners, path, candidate.id);
        continue;
      }
      plan.conflicts.push({
        path,
        unit: 'file',
        candidateIds: unique([...(owners.get(path) ?? []), candidate.id]),
        reason:
          'Both candidates changed this unsupported, deleted, or newly-created file differently; manual resolution is required.',
      });
    }
  }

  plan.filesAnalyzed = new Set([
    ...Object.keys(input.baseFiles),
    ...input.candidates.flatMap((candidate) => Object.keys(candidate.files)),
  ]).size;
  return { files, plan };
}

function mergeAstFile(
  path: string,
  baseText: string,
  currentText: string,
  incomingText: string,
  candidateId: string,
  currentOwners: string[],
): {
  content: string;
  applied: Array<Pick<SemanticMergeAppliedUnit, 'unit' | 'strategy'>>;
  conflicts: SemanticMergeConflict[];
} {
  const base = parseSource(path, baseText);
  const current = parseSource(path, currentText);
  const incoming = parseSource(path, incomingText);
  const operations: TextOperation[] = [];
  const applied: Array<Pick<SemanticMergeAppliedUnit, 'unit' | 'strategy'>> = [];
  const conflicts: SemanticMergeConflict[] = [];
  const blockedContainers = new Set<string>();

  for (const key of orderedKeys(base.containers, incoming.containers)) {
    const before = base.containers.get(key);
    const now = current.containers.get(key);
    const next = incoming.containers.get(key);
    if (sameContainer(before, next)) continue;
    if (!before && next) {
      if (!now) {
        operations.push({
          start: currentText.length,
          end: currentText.length,
          text: `${ensureGap(currentText)}${next.text}\n`,
          unit: key,
          strategy: 'ast-add',
          order: next.order,
        });
        blockedContainers.add(key);
      } else if (now.headerHash !== next.headerHash || hash(now.text) !== hash(next.text)) {
        conflicts.push(
          conflict(path, key, currentOwners, candidateId, 'container added differently'),
        );
        blockedContainers.add(key);
      }
      continue;
    }
    if (before && !next) {
      if (now && sameContainer(before, now)) {
        operations.push({
          start: lineStart(currentText, now.start),
          end: lineEnd(currentText, now.end),
          text: '',
          unit: key,
          strategy: 'ast-delete',
          order: before.order,
        });
      } else if (now) {
        conflicts.push(
          conflict(
            path,
            key,
            currentOwners,
            candidateId,
            'removed by one candidate but modified by another',
          ),
        );
      }
      blockedContainers.add(key);
      continue;
    }
    if (before && now && next && before.headerHash !== next.headerHash) {
      if (before.headerHash !== now.headerHash && now.headerHash !== next.headerHash) {
        conflicts.push(
          conflict(
            path,
            `${key}/header`,
            currentOwners,
            candidateId,
            'container signatures diverge',
          ),
        );
      } else {
        // Header-only transplants are intentionally conservative because
        // replacing a whole class would erase independently merged members.
        conflicts.push(
          conflict(
            path,
            `${key}/header`,
            currentOwners,
            candidateId,
            'container signature changed and needs explicit semantic review',
          ),
        );
      }
    }
  }

  for (const key of orderedKeys(base.units, incoming.units)) {
    const before = base.units.get(key);
    const now = current.units.get(key);
    const next = incoming.units.get(key);
    const containerKey = before?.containerKey ?? next?.containerKey;
    if (containerKey && blockedContainers.has(containerKey)) continue;
    if (sameUnit(before, next)) continue;
    if (!before && next) {
      if (!now) {
        const insertion = insertionFor(current, next, currentText);
        operations.push({
          start: insertion.position,
          end: insertion.position,
          text: insertion.text,
          unit: key,
          strategy: 'ast-add',
          order: next.order,
        });
      } else if (now.hash !== next.hash) {
        conflicts.push(conflict(path, key, currentOwners, candidateId, 'symbol added differently'));
      }
      continue;
    }
    if (before && !next) {
      if (now && now.hash === before.hash) {
        operations.push({
          start: lineStart(currentText, now.start),
          end: lineEnd(currentText, now.end),
          text: '',
          unit: key,
          strategy: 'ast-delete',
          order: before.order,
        });
      } else if (now) {
        conflicts.push(
          conflict(
            path,
            key,
            currentOwners,
            candidateId,
            'symbol removed by one candidate and modified by another',
          ),
        );
      }
      continue;
    }
    if (before && now && next) {
      if (now.hash === next.hash) continue;
      if (now.hash === before.hash) {
        operations.push({
          start: now.start,
          end: now.end,
          text: next.text,
          unit: key,
          strategy: 'ast-update',
          order: next.order,
        });
      } else {
        conflicts.push(
          conflict(
            path,
            key,
            currentOwners,
            candidateId,
            'the same semantic symbol has divergent implementations',
          ),
        );
      }
    } else if (before && !now && next) {
      conflicts.push(
        conflict(
          path,
          key,
          currentOwners,
          candidateId,
          'symbol removed in the current merge but modified by this candidate',
        ),
      );
    }
  }

  const nonOverlapping = rejectOverlappingOperations(
    path,
    operations,
    conflicts,
    currentOwners,
    candidateId,
  );
  let content = currentText;
  for (const operation of nonOverlapping.sort(
    (left, right) => right.start - left.start || right.order - left.order,
  )) {
    content = `${content.slice(0, operation.start)}${operation.text}${content.slice(operation.end)}`;
    applied.push({ unit: operation.unit, strategy: operation.strategy });
  }
  if (parseSource(path, content).source.length !== content.length) {
    throw new Error(`Semantic merge produced an invalid source boundary for ${path}.`);
  }
  return { content, applied, conflicts };
}

function parseSource(path: string, source: string): ParsedSource {
  if (extname(path).toLowerCase() === '.py') return parsePythonSource(source);
  return parseTypeScriptSource(path, source);
}

function parseTypeScriptSource(path: string, source: string): ParsedSource {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const units = new Map<string, SemanticUnit>();
  const containers = new Map<string, SemanticContainer>();
  const occurrences = new Map<string, number>();
  let order = 0;

  for (const statement of sourceFile.statements) {
    const container = containerIdentity(statement, sourceFile);
    if (container) {
      const key = uniqueKey(`container:${container.kind}:${container.name}`, occurrences);
      const lastToken = statement.getLastToken(sourceFile);
      const insertionPoint = lastToken
        ? lineStart(source, lastToken.getStart(sourceFile))
        : statement.end;
      const firstMember = container.members[0];
      const headerEnd =
        firstMember?.getStart(sourceFile) ?? lastToken?.getStart(sourceFile) ?? statement.end;
      containers.set(key, {
        key,
        kind: container.kind,
        start: statement.getStart(sourceFile),
        end: statement.end,
        insertionPoint,
        indent: indentationAt(source, statement.getStart(sourceFile)),
        text: statement.getText(sourceFile),
        headerHash: hash(
          statement
            .getText(sourceFile)
            .slice(0, Math.max(0, headerEnd - statement.getStart(sourceFile))),
        ),
        order: order++,
      });
      const memberOccurrences = new Map<string, number>();
      for (const member of container.members) {
        const memberBase = `member:${container.kind}:${container.name}:${memberKind(member)}:${nodeName(member, sourceFile)}`;
        const memberKey = `${key}/${uniqueKey(memberBase, memberOccurrences)}`;
        units.set(
          memberKey,
          makeUnit(memberKey, memberKind(member), member, sourceFile, source, order++, key),
        );
      }
      continue;
    }
    const identity = statementIdentity(statement, sourceFile);
    const key = uniqueKey(identity, occurrences);
    units.set(
      key,
      makeUnit(key, identity.split(':')[0] ?? 'statement', statement, sourceFile, source, order++),
    );
  }
  return { source, units, containers };
}

function parsePythonSource(source: string): ParsedSource {
  const lines = pythonLines(source);
  const units = new Map<string, SemanticUnit>();
  const containers = new Map<string, SemanticContainer>();
  const occurrences = new Map<string, number>();
  let order = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.indent.length > 0 || !line.trimmed || line.trimmed.startsWith('#')) continue;
    const classMatch = /^class\s+([A-Za-z_]\w*)\b/.exec(line.trimmed);
    const functionMatch = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\b/.exec(line.trimmed);
    if (classMatch) {
      const endIndex = pythonBlockEnd(lines, index);
      const end = lines[endIndex]?.end ?? source.length;
      const key = uniqueKey(`container:class:${classMatch[1]}`, occurrences);
      const blockText = source.slice(line.start, end);
      containers.set(key, {
        key,
        kind: 'class',
        start: line.start,
        end,
        insertionPoint: end,
        indent: '',
        text: blockText,
        headerHash: hash(line.trimmed),
        order: order++,
      });
      const memberOccurrences = new Map<string, number>();
      for (let memberIndex = index + 1; memberIndex <= endIndex; memberIndex += 1) {
        const member = lines[memberIndex];
        if (!member || member.indent.length === 0) continue;
        const memberMatch = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\b/.exec(member.trimmed);
        if (!memberMatch) continue;
        const memberEndIndex = pythonBlockEnd(lines, memberIndex);
        const memberEnd = Math.min(end, lines[memberEndIndex]?.end ?? end);
        const memberKey = `${key}/${uniqueKey(`member:class:${classMatch[1]}:method:${memberMatch[1]}`, memberOccurrences)}`;
        const raw = source.slice(member.start, memberEnd);
        units.set(memberKey, {
          key: memberKey,
          kind: 'method',
          start: member.start + member.indent.length,
          end: memberEnd,
          text: raw.startsWith(member.indent) ? raw.slice(member.indent.length) : raw,
          indent: member.indent,
          hash: hash(raw),
          order: order++,
          containerKey: key,
        });
        memberIndex = Math.max(memberIndex, memberEndIndex);
      }
      index = Math.max(index, endIndex);
      continue;
    }
    if (functionMatch) {
      const endIndex = pythonBlockEnd(lines, index);
      const end = lines[endIndex]?.end ?? source.length;
      const key = uniqueKey(`function:${functionMatch[1]}`, occurrences);
      const text = source.slice(line.start, end);
      units.set(key, {
        key,
        kind: 'function',
        start: line.start,
        end,
        text,
        indent: '',
        hash: hash(text),
        order: order++,
      });
      index = Math.max(index, endIndex);
      continue;
    }
    const importMatch = /^(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/.exec(line.trimmed);
    if (importMatch) {
      const key = uniqueKey(`import:${importMatch[1] ?? importMatch[2]}`, occurrences);
      units.set(key, {
        key,
        kind: 'import',
        start: line.start,
        end: line.end,
        text: source.slice(line.start, line.end).trimEnd(),
        indent: '',
        hash: hash(source.slice(line.start, line.end)),
        order: order++,
      });
    }
  }
  return { source, units, containers };
}

interface PythonLine {
  start: number;
  end: number;
  indent: string;
  trimmed: string;
}

function pythonLines(source: string): PythonLine[] {
  const output: PythonLine[] = [];
  let start = 0;
  for (const raw of source.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!raw && start >= source.length) break;
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    const indent = /^\s*/.exec(line)?.[0] ?? '';
    output.push({
      start,
      end: start + raw.length,
      indent,
      trimmed: line.trim(),
    });
    start += raw.length;
  }
  return output;
}

function pythonBlockEnd(lines: PythonLine[], startIndex: number): number {
  const base = lines[startIndex]?.indent.length ?? 0;
  let last = startIndex;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) break;
    if (!line.trimmed || line.trimmed.startsWith('#')) {
      last = index;
      continue;
    }
    if (line.indent.length <= base) break;
    last = index;
  }
  return last;
}

function containerIdentity(
  node: ts.Statement,
  sourceFile: ts.SourceFile,
): { kind: string; name: string; members: ts.NodeArray<ts.Node> } | undefined {
  if (ts.isClassDeclaration(node)) {
    return { kind: 'class', name: node.name?.text ?? '<default>', members: node.members };
  }
  if (ts.isInterfaceDeclaration(node)) {
    return { kind: 'interface', name: node.name.text, members: node.members };
  }
  if (ts.isEnumDeclaration(node)) {
    return { kind: 'enum', name: node.name.text, members: node.members };
  }
  if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
    return {
      kind: 'module',
      name: node.name.getText(sourceFile),
      members: node.body.statements,
    };
  }
  return undefined;
}

function statementIdentity(node: ts.Statement, sourceFile: ts.SourceFile): string {
  if (ts.isImportDeclaration(node)) {
    return `import:${node.moduleSpecifier.getText(sourceFile)}:${node.importClause?.getText(sourceFile) ?? 'side-effect'}`;
  }
  if (ts.isImportEqualsDeclaration(node)) return `import-equals:${node.name.text}`;
  if (ts.isFunctionDeclaration(node)) return `function:${node.name?.text ?? '<default>'}`;
  if (ts.isTypeAliasDeclaration(node)) return `type:${node.name.text}`;
  if (ts.isVariableStatement(node)) {
    return `variable:${node.declarationList.declarations.map((item) => item.name.getText(sourceFile)).join(',')}`;
  }
  if (ts.isExportDeclaration(node)) {
    return `export:${node.moduleSpecifier?.getText(sourceFile) ?? node.exportClause?.getText(sourceFile) ?? '*'}`;
  }
  if (ts.isExportAssignment(node))
    return `export-assignment:${node.isExportEquals ? '=' : 'default'}`;
  return `statement:${ts.SyntaxKind[node.kind]}`;
}

function makeUnit(
  key: string,
  kind: string,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  source: string,
  order: number,
  containerKey?: string,
): SemanticUnit {
  const start = node.getStart(sourceFile);
  const text = node.getText(sourceFile);
  return {
    key,
    kind,
    start,
    end: node.end,
    text,
    indent: indentationAt(source, start),
    hash: hash(text),
    order,
    ...(containerKey ? { containerKey } : {}),
  };
}

function memberKind(node: ts.Node): string {
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method';
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return 'property';
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isGetAccessorDeclaration(node)) return 'getter';
  if (ts.isSetAccessorDeclaration(node)) return 'setter';
  if (ts.isCallSignatureDeclaration(node)) return 'call-signature';
  if (ts.isIndexSignatureDeclaration(node)) return 'index-signature';
  if (ts.isEnumMember(node)) return 'enum-member';
  return ts.SyntaxKind[node.kind].toLowerCase();
}

function nodeName(node: ts.Node, sourceFile: ts.SourceFile): string {
  const named = node as ts.Node & { name?: ts.Node };
  return named.name?.getText(sourceFile) ?? '<anonymous>';
}

function insertionFor(
  current: ParsedSource,
  incoming: SemanticUnit,
  currentText: string,
): { position: number; text: string } {
  if (incoming.containerKey) {
    const container = current.containers.get(incoming.containerKey);
    if (container) {
      return {
        position: container.insertionPoint,
        text: `${incoming.indent}${incoming.text}\n`,
      };
    }
  }
  if (incoming.kind === 'import') {
    const imports = [...current.units.values()].filter((unit) => unit.kind === 'import');
    const position = imports.length > 0 ? Math.max(...imports.map((unit) => unit.end)) : 0;
    return { position, text: `${position > 0 ? '\n' : ''}${incoming.text}` };
  }
  return { position: currentText.length, text: `${ensureGap(currentText)}${incoming.text}\n` };
}

function rejectOverlappingOperations(
  path: string,
  operations: TextOperation[],
  conflicts: SemanticMergeConflict[],
  currentOwners: string[],
  candidateId: string,
): TextOperation[] {
  const accepted: TextOperation[] = [];
  for (const operation of operations.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )) {
    const overlap = accepted.find(
      (candidate) =>
        operation.start < candidate.end &&
        operation.end > candidate.start &&
        operation.start !== operation.end &&
        candidate.start !== candidate.end,
    );
    if (overlap) {
      conflicts.push(
        conflict(
          path,
          operation.unit,
          currentOwners,
          candidateId,
          `semantic edit overlaps ${overlap.unit}; explicit resolution is required`,
        ),
      );
      continue;
    }
    accepted.push(operation);
  }
  return accepted;
}

function orderedKeys<T extends { order: number }>(
  left: Map<string, T>,
  right: Map<string, T>,
): string[] {
  return unique([...left.keys(), ...right.keys()]).sort(
    (a, b) =>
      (right.get(a)?.order ?? left.get(a)?.order ?? 0) -
      (right.get(b)?.order ?? left.get(b)?.order ?? 0),
  );
}

function sameUnit(left: SemanticUnit | undefined, right: SemanticUnit | undefined): boolean {
  return (!left && !right) || Boolean(left && right && left.hash === right.hash);
}

function sameContainer(
  left: SemanticContainer | undefined,
  right: SemanticContainer | undefined,
): boolean {
  return (
    (!left && !right) ||
    Boolean(
      left && right && left.headerHash === right.headerHash && hash(left.text) === hash(right.text),
    )
  );
}

function conflict(
  path: string,
  unit: string,
  currentOwners: string[],
  candidateId: string,
  reason: string,
): SemanticMergeConflict {
  return {
    path,
    unit,
    candidateIds: unique([...currentOwners, candidateId]),
    reason,
  };
}

function uniqueKey(base: string, occurrences: Map<string, number>): string {
  const count = occurrences.get(base) ?? 0;
  occurrences.set(base, count + 1);
  return count === 0 ? base : `${base}#${count + 1}`;
}

function addOwner(owners: Map<string, Set<string>>, path: string, id: string): void {
  const values = owners.get(path) ?? new Set<string>();
  values.add(id);
  owners.set(path, values);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function hash(value: string): string {
  return createHash('sha256').update(value.replaceAll('\r\n', '\n')).digest('hex');
}

function indentationAt(source: string, offset: number): string {
  const start = lineStart(source, offset);
  const prefix = source.slice(start, offset);
  return /^\s*$/.test(prefix) ? prefix : '';
}

function lineStart(source: string, offset: number): number {
  const index = source.lastIndexOf('\n', Math.max(0, offset - 1));
  return index < 0 ? 0 : index + 1;
}

function lineEnd(source: string, offset: number): number {
  const index = source.indexOf('\n', offset);
  return index < 0 ? source.length : index + 1;
}

function ensureGap(source: string): string {
  if (!source) return '';
  return source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
}

function scriptKind(path: string): ts.ScriptKind {
  switch (extname(path).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}
