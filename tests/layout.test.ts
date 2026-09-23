import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { categories, normalizeCategories, type CategoryDef } from '../src/data/tools';
import { sanitizeTree } from '../src/workspace/model';

beforeAll(() => {
  categories.value = normalizeCategories(JSON.parse(readFileSync('tools.json', 'utf8')) as CategoryDef[]);
});

describe('sanitizeTree', () => {
  it('entfernt unbekannte und doppelte IDs und leere Zweige', () => {
    const tree = sanitizeTree({
      row: [{ tabs: ['company-calc', 'gibt-es-nicht'] }, { column: [{ tabs: ['company-calc'] }, { tabs: ['widget:market'] }] }],
    });
    expect(tree).toEqual({ row: [{ tabs: ['company-calc'] }, { tabs: ['widget:market'] }] });
  });
  it('lehnt Unsinn ab', () => {
    expect(sanitizeTree(null)).toBeNull();
    expect(sanitizeTree({ tabs: [] })).toBeNull();
    expect(sanitizeTree({ row: 'x' })).toBeNull();
  });
});
