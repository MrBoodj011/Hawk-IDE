// Skill discovery precedence. Injectable cwd/home keep it deterministic.

import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { skillSearchDirs } from './discovery.js';

describe('skillSearchDirs', () => {
  it('orders builtin → project → managed → personal → configured (lowest to highest precedence)', () => {
    const project = resolve('/proj');
    const home = '/home';
    const dirs = skillSearchDirs(['/cfg/skills'], project, home);
    expect(dirs).toEqual([
      resolve(project, 'skills'),
      resolve(project, '.hawk', 'skills'),
      join(home, '.hawk', 'builtin-skills'),
      join(home, '.hawk', 'skills'),
      resolve('/cfg/skills'),
    ]);
  });

  it('includes project-local, managed, and personal skill dirs', () => {
    const project = resolve('/proj');
    const home = '/home';
    const dirs = skillSearchDirs([], project, home);
    expect(dirs).toContain(resolve(project, '.hawk', 'skills'));
    expect(dirs).toContain(join(home, '.hawk', 'builtin-skills'));
    expect(dirs).toContain(join(home, '.hawk', 'skills'));
  });

  it('appends configured dirs last so they win on collision', () => {
    const dirs = skillSearchDirs(['/a', '/b'], resolve('/proj'), '/home');
    expect(dirs.slice(-2)).toEqual([resolve('/a'), resolve('/b')]);
  });
});
