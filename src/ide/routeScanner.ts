import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import fg from 'fast-glob';
import type { WorkspaceRoute } from './protocol.js';

const SOURCE_GLOBS = ['**/*.{ts,tsx,js,jsx,mjs,cjs}'];
const IGNORED_DIRECTORIES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
];

const CHAINED_ROUTE_RE =
  /\b(?:app|router|fastify)\.route\(\s*(['"`])([^'"`]+)\1\s*\)\s*\.(get|post|put|patch|delete|options|head)\s*\(/gi;
const DIRECT_ROUTE_RE =
  /\b(app|router|fastify)\.(get|post|put|patch|delete|options|head)\s*\(\s*(['"`])([^'"`]+)\3/gi;
const NEXT_METHOD_RE =
  /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g;
const NEXT_PAGES_HANDLER_RE = /export\s+default\s+(?:async\s+)?(?:function|\()/g;

export interface RouteScanResult {
  sourceFiles: number;
  routes: WorkspaceRoute[];
}

/**
 * Extract a conservative API inventory from common Node web frameworks. This
 * does not attempt to execute untrusted project code; it only parses text.
 * Framework-specific parsers can be added later without changing callers.
 */
export async function scanWorkspaceRoutes(workspaceRoot: string): Promise<RouteScanResult> {
  const root = resolve(workspaceRoot);
  const files = await fg(SOURCE_GLOBS, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    ignore: IGNORED_DIRECTORIES,
  });
  const routes: WorkspaceRoute[] = [];

  for (const file of files) {
    let source = '';
    try {
      source = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const relativeFile = relative(root, file).split(sep).join('/');
    routes.push(...scanDirectRoutes(source, relativeFile));
    routes.push(...scanChainedRoutes(source, relativeFile));
    routes.push(...scanNextAppRoutes(source, relativeFile));
    routes.push(...scanNextPagesRoutes(source, relativeFile));
  }

  return {
    sourceFiles: files.length,
    routes: dedupeRoutes(routes),
  };
}

function scanDirectRoutes(source: string, file: string): WorkspaceRoute[] {
  const out: WorkspaceRoute[] = [];
  DIRECT_ROUTE_RE.lastIndex = 0;
  for (const match of source.matchAll(DIRECT_ROUTE_RE)) {
    const target = match[1];
    const method = match[2];
    const path = match[4];
    if (!target || !method || !path || match.index === undefined) continue;
    out.push({
      method: method.toUpperCase(),
      path: normalizeRoutePath(path),
      file,
      line: lineAt(source, match.index),
      framework: target.toLowerCase() === 'fastify' ? 'fastify' : 'express',
    });
  }
  return out;
}

function scanChainedRoutes(source: string, file: string): WorkspaceRoute[] {
  const out: WorkspaceRoute[] = [];
  CHAINED_ROUTE_RE.lastIndex = 0;
  for (const match of source.matchAll(CHAINED_ROUTE_RE)) {
    const path = match[2];
    const method = match[3];
    if (!path || !method || match.index === undefined) continue;
    out.push({
      method: method.toUpperCase(),
      path: normalizeRoutePath(path),
      file,
      line: lineAt(source, match.index),
      framework: 'express',
    });
  }
  return out;
}

function scanNextAppRoutes(source: string, file: string): WorkspaceRoute[] {
  const routePath = nextAppPath(file);
  if (!routePath) return [];
  const out: WorkspaceRoute[] = [];
  NEXT_METHOD_RE.lastIndex = 0;
  for (const match of source.matchAll(NEXT_METHOD_RE)) {
    const method = match[1];
    if (!method || match.index === undefined) continue;
    out.push({
      method,
      path: routePath,
      file,
      line: lineAt(source, match.index),
      framework: 'next-app',
    });
  }
  return out;
}

function scanNextPagesRoutes(source: string, file: string): WorkspaceRoute[] {
  const routePath = nextPagesPath(file);
  if (!routePath) return [];
  const match = NEXT_PAGES_HANDLER_RE.exec(source);
  if (!match || match.index === undefined) return [];
  return [
    {
      method: 'ANY',
      path: routePath,
      file,
      line: lineAt(source, match.index),
      framework: 'next-pages',
    },
  ];
}

function nextAppPath(file: string): string | null {
  const normalized = file.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)(?:src\/)?app\/(.+)\/route\.(?:ts|tsx|js|jsx|mjs|cjs)$/);
  return match?.[1] ? normalizeRoutePath(match[1]) : null;
}

function nextPagesPath(file: string): string | null {
  const normalized = file.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)(?:src\/)?pages\/api\/(.+)\.(?:ts|tsx|js|jsx|mjs|cjs)$/);
  return match?.[1] ? normalizeRoutePath(`api/${match[1].replace(/\/index$/, '')}`) : null;
}

function normalizeRoutePath(path: string): string {
  const dynamic = path
    .replace(/\[\[\.\.\.([^\]]+)\]\]/g, '*$1')
    .replace(/\[\.\.\.([^\]]+)\]/g, '*$1')
    .replace(/\[([^\]]+)\]/g, ':$1');
  const prefixed = dynamic.startsWith('/') ? dynamic : `/${dynamic}`;
  return prefixed.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function dedupeRoutes(routes: WorkspaceRoute[]): WorkspaceRoute[] {
  const seen = new Set<string>();
  const unique = routes.filter((route) => {
    const key = `${route.method}\u0000${route.path}\u0000${route.file}\u0000${route.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
}

export const _private = { nextAppPath, nextPagesPath, normalizeRoutePath };
