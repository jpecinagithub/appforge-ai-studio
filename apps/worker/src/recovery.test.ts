import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractMissingLocalImages, imageQueryVariants, isUsableRasterAsset, patchImageReferences, repairStateKey } from './recovery.js';

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

  it('normalizes accumulated relative prefixes without corrupting the path again', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-recovery-prefix-'));
    fs.mkdirSync(path.join(dir, 'src'));
    const app = path.join(dir, 'src', 'App.tsx');
    fs.writeFileSync(app, '["././images/kits/bayern.jpg", "./.././images/kits/bayern.jpg"]');
    expect(patchImageReferences(dir, '/images/kits/bayern.jpg', './images/kits/bayern.jpg')).toEqual(['src/App.tsx']);
    expect(fs.readFileSync(app, 'utf8')).toBe('["./images/kits/bayern.jpg", "./images/kits/bayern.jpg"]');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back from localized descriptions to a concise asset query', () => {
    const issue = extractMissingLocalImages([
      'HTTP 404: http://127.0.0.1:36747/images/kits/bayern.jpg',
      'Camiseta local del Bayern de Múnich: http://127.0.0.1:36747/images/kits/bayern.jpg',
    ].join('\n'), 'project')[0];
    expect(imageQueryVariants(issue)).toContain('Bayern Munich jersey');
    expect(imageQueryVariants(issue)).toContain('bayern football jersey');
  });

  it('ignores ephemeral browser ports when measuring repair progress', () => {
    expect(repairStateKey('same', 'HTTP 404: 127.0.0.1:30100/a.jpg'))
      .toBe(repairStateKey('same', 'HTTP 404: 127.0.0.1:39999/a.jpg'));
    expect(repairStateKey('changed', 'same error')).not.toBe(repairStateKey('same', 'same error'));
  });

  it('rejects text disguised as a JPEG and accepts a JPEG signature', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-image-signature-'));
    const fake = path.join(dir, 'fake.jpg');
    const real = path.join(dir, 'real.jpg');
    fs.writeFileSync(fake, '<svg></svg>');
    fs.writeFileSync(real, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
    expect(isUsableRasterAsset(fake)).toBe(false);
    expect(isUsableRasterAsset(real)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
