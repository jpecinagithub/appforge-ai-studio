import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractMissingLocalImages, patchImageReferences, repairStateKey } from './recovery.js';

describe('agent recovery helpers', () => {
  it('extracts and deduplicates missing local images with their alt text', () => {
    const diagnostic = [
      'HTTP 404: http://127.0.0.1:36747/images/kits/real-madrid.jpg',
      'Broken images detected:',
      'Camiseta local del Real Madrid: http://127.0.0.1:36747/images/kits/real-madrid.jpg',
      'HTTP 404: http://127.0.0.1:36747/images/kits/real-madrid.jpg',
    ].join('\n');
    expect(extractMissingLocalImages(diagnostic, 'project')).toEqual([{
      alt: 'Camiseta local del Real Madrid',
      requestPath: '/images/kits/real-madrid.jpg',
      publicRelativePath: 'images/kits/real-madrid.jpg',
      acquisitionPath: 'public/images/kits/real-madrid',
      query: 'Camiseta local del Real Madrid football jersey',
    }]);
  });

  it('patches absolute asset paths to the acquired nested-preview URL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-recovery-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'App.tsx'), 'const image = "/images/kits/psg.png";');
    expect(patchImageReferences(dir, '/images/kits/psg.png', './images/kits/psg.jpg')).toEqual(['src/App.tsx']);
    expect(fs.readFileSync(path.join(dir, 'src', 'App.tsx'), 'utf8')).toContain('./images/kits/psg.jpg');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores ephemeral browser ports when measuring repair progress', () => {
    expect(repairStateKey('same', 'HTTP 404: 127.0.0.1:30100/a.jpg'))
      .toBe(repairStateKey('same', 'HTTP 404: 127.0.0.1:39999/a.jpg'));
    expect(repairStateKey('changed', 'same error')).not.toBe(repairStateKey('same', 'same error'));
  });
});
