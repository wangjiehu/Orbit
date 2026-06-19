import { describe, it, expect } from 'vitest';
import { DiffView } from './DiffView.js';

describe('DiffView unified diff and hunk merging tests', () => {
  it('should render only additions if before is null', () => {
    const output = DiffView.render('test.txt', null, 'line1\nline2');
    expect(output).toContain('+ line1');
    expect(output).toContain('+ line2');
  });

  it('should report no changes if content is identical', () => {
    const output = DiffView.render('test.txt', 'line1\nline2', 'line1\nline2');
    expect(output).toContain('No changes.');
  });

  it('should render distinct hunks if gap is large', () => {
    const before = [
      'line1', 'line2', 'line3', 'line4', 'line5',
      'line6', 'line7', 'line8', 'line9', 'line10',
      'line11', 'line12', 'line13', 'line14', 'line15'
    ].join('\n');

    const after = [
      'line1', 'line2', 'lineX', 'line4', 'line5',
      'line6', 'line7', 'line8', 'line9', 'line10',
      'line11', 'line12', 'lineY', 'line14', 'line15'
    ].join('\n');

    const output = DiffView.render('test.txt', before, after);
    // Gap between index 2 (lineX) and index 12 (lineY) is 12 - 2 - 1 = 9 lines.
    // 9 > 6, so they should remain as two separate hunks with their own headers.
    const headers = output.split('\n').filter(l => l.includes('@@'));
    expect(headers.length).toBe(2);
    expect(output).toContain('lineX');
    expect(output).toContain('lineY');
  });

  it('should merge hunks if gap is 6 lines or less', () => {
    const before = [
      'line1', 'line2', 'line3', 'line4', 'line5',
      'line6', 'line7', 'line8', 'line9', 'line10'
    ].join('\n');

    const after = [
      'line1', 'line2', 'lineX', 'line4', 'line5',
      'line6', 'lineY', 'line8', 'line9', 'line10'
    ].join('\n');

    const output = DiffView.render('test.txt', before, after);
    // Gap between index 2 (lineX) and index 6 (lineY) is 6 - 2 - 1 = 3 lines.
    // 3 <= 6, so they should be merged into a single hunk.
    const headers = output.split('\n').filter(l => l.includes('@@'));
    expect(headers.length).toBe(1);
    expect(output).toContain('lineX');
    expect(output).toContain('lineY');

    // Unchanged lines within the merge gap should be rendered as unchanged (preceded by spaces, not +/-)
    expect(output).toContain('  line4');
    expect(output).toContain('  line5');
    expect(output).toContain('  line6');
    expect(output).not.toContain('- line4');
    expect(output).not.toContain('+ line4');
  });
});
