import { describe, expect, it } from 'vitest';
import { buildSemanticMerge } from './semanticMerge.js';

describe('buildSemanticMerge', () => {
  it('transplants disjoint class-member edits from separate candidates', () => {
    const base = [
      'export class Policy {',
      '  authorize(role: string): boolean {',
      "    return role === 'admin';",
      '  }',
      '}',
      '',
    ].join('\n');
    const candidateA = base.replace("role === 'admin'", "role === 'admin' || role === 'owner'");
    const candidateB = base.replace(
      '\n}',
      ['', '  audit(role: string): string {', '    return `checked:${role}`;', '  }', '}'].join(
        '\n',
      ),
    );

    const result = buildSemanticMerge({
      baseFiles: { 'policy.ts': base },
      candidates: [
        { id: 'candidate-a', files: { 'policy.ts': candidateA } },
        { id: 'candidate-b', files: { 'policy.ts': candidateB } },
      ],
    });

    expect(result.files['policy.ts']).toContain("role === 'admin' || role === 'owner'");
    expect(result.files['policy.ts']).toContain('audit(role: string)');
    expect(result.plan.astFilesAnalyzed).toBe(1);
    expect(result.plan.conflicts).toEqual([]);
    expect(result.plan.automaticallyMergedUnits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ candidateId: 'candidate-b', strategy: 'ast-add' }),
      ]),
    );
  });

  it('keeps the primary implementation and reports divergent edits to the same symbol', () => {
    const base = 'export function score(value: number) {\n  return value;\n}\n';
    const candidateA = base.replace('return value;', 'return value * 2;');
    const candidateB = base.replace('return value;', 'return value + 10;');

    const result = buildSemanticMerge({
      baseFiles: { 'score.ts': base },
      candidates: [
        { id: 'primary', files: { 'score.ts': candidateA } },
        { id: 'secondary', files: { 'score.ts': candidateB } },
      ],
    });

    expect(result.files['score.ts']).toBe(candidateA);
    expect(result.plan.conflicts).toEqual([
      expect.objectContaining({
        path: 'score.ts',
        unit: 'function:score',
        candidateIds: ['primary', 'secondary'],
      }),
    ]);
  });

  it('combines independent files without model synthesis', () => {
    const result = buildSemanticMerge({
      baseFiles: {
        'a.ts': 'export const a = 1;\n',
        'b.ts': 'export const b = 1;\n',
      },
      candidates: [
        { id: 'a-lane', files: { 'a.ts': 'export const a = 2;\n' } },
        { id: 'b-lane', files: { 'b.ts': 'export const b = 2;\n' } },
      ],
    });

    expect(result.files).toEqual({
      'a.ts': 'export const a = 2;\n',
      'b.ts': 'export const b = 2;\n',
    });
    expect(result.plan.conflicts).toHaveLength(0);
    expect(result.plan.automaticallyMergedUnits).toHaveLength(2);
  });

  it('reports incompatible non-AST file edits instead of concatenating patches', () => {
    const result = buildSemanticMerge({
      baseFiles: { 'config.yaml': 'mode: safe\n' },
      candidates: [
        { id: 'one', files: { 'config.yaml': 'mode: strict\n' } },
        { id: 'two', files: { 'config.yaml': 'mode: fast\n' } },
      ],
    });

    expect(result.files['config.yaml']).toBe('mode: strict\n');
    expect(result.plan.conflicts).toEqual([
      expect.objectContaining({ path: 'config.yaml', unit: 'file' }),
    ]);
  });
});
