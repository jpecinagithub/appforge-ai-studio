import { describe, expect, it } from 'vitest';
import { previewUrlFor, publicAppUrlFor } from './client';
import { demoPreviewHtml } from './demo';

describe('demo previews', () => {
  it('provides a functional, self-contained tic-tac-toe preview', () => {
    const html = demoPreviewHtml('demo-tictactoe');
    expect(html).toContain('Tic-Tac-Toe AI');
    expect(html).toContain('function play(i)');
    expect(html).toContain('<script>');
  });

  it('provides an interactive task-board preview and no fake preview for portfolio', () => {
    expect(demoPreviewHtml('demo-tasks')).toContain('Task Board');
    expect(demoPreviewHtml('demo-portfolio')).toBeNull();
  });
});

describe('previewUrlFor', () => {
  it('encodes project ids as a single safe path segment', () => {
    expect(previewUrlFor('project/with spaces?')).toBe('/p/project%2Fwith%20spaces%3F/');
  });

  it('builds an absolute, shareable app URL', () => {
    expect(publicAppUrlFor('my app', 'https://studio.example')).toBe(
      'https://studio.example/p/my%20app/',
    );
  });
});
