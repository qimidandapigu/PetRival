import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultAppearance } from '../shared/pet.mjs';
import { encodeLook, decodeLook, imagePlacement, pixelsFromRgba } from '../shared/pet-studio.mjs';

test('share code round trips pixels, excludes identity and growth, and accepts surrounding whitespace', () => {
  const pet = { species: 'fox', appearance: defaultAppearance('fox'), name: '私有名字', id: 'owner-id', score: 900, skills: ['skill'] };
  const code = encodeLook(pet), look = decodeLook(`\n${code}\n`);
  assert.deepEqual(look, { species: pet.species, appearance: pet.appearance });
  assert.doesNotMatch(atob(code.slice(9)), /私有名字|owner-id|score|skills/);
  look.appearance.pixels[0] = '#112233'; assert.equal(pet.appearance.pixels[0], null);
});
test('reject corrupt, oversized, executable and authority-bearing look codes', () => {
  const look = { species: 'fox', appearance: defaultAppearance('fox') };
  for (const data of [{ ...look, score: 200 }, { ...look, species: '<script>' }, { ...look, appearance: { ...look.appearance, pixels: ['red'] } }]) {
    assert.throws(() => decodeLook('PETLOOK1.' + btoa(JSON.stringify(data))));
  }
  for (const text of ['PETLOOK2.abc', 'PETLOOK1.abc', 'PETLOOK1.@@@@', 'x'.repeat(16385), null]) assert.throws(() => decodeLook(text));
});
test('landscape/portrait imports retain their aspect ratio and fit inside the frame', () => {
  assert.deepEqual(imagePlacement(640, 320), { x: 0, y: 80, width: 320, height: 160 });
  assert.deepEqual(imagePlacement(320, 640), { x: 80, y: 0, width: 160, height: 320 });
  const crop = imagePlacement(640, 320, 2, 40, -30), small = imagePlacement(640, 320, 2, 40, -30, 16);
  for (const key of Object.keys(crop)) assert.equal(small[key], crop[key] / 20);
  assert.throws(() => imagePlacement(0, 100));
});
test('alpha threshold and colors survive pixel conversion', () => {
  const rgba = new Uint8ClampedArray(1024); rgba.set([18, 171, 205, 255], 0); rgba.set([255, 0, 0, 127], 4);
  const art = pixelsFromRgba(rgba); assert.equal(art.pixels[0], '#12ABCD'); assert.equal(art.pixels[1], null);
});
test('edge background removal preserves enclosed white details and colored silhouette', () => {
  const rgba = new Uint8ClampedArray(1024).fill(255);
  for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) rgba.set([20, 80, 20, 255], (y * 16 + x) * 4);
  rgba.set([255, 255, 255, 255], (8 * 16 + 8) * 4);
  const art = pixelsFromRgba(rgba, true);
  assert.equal(art.pixels[0], null); assert.equal(art.pixels[4 * 16 + 4], '#145014'); assert.equal(art.pixels[8 * 16 + 8], '#FFFFFF');
  assert.equal(pixelsFromRgba(rgba).pixels[0], '#FFFFFF');
});
test('background removal crosses transparent padding around a non-square image', () => {
  const rgba = new Uint8ClampedArray(1024);
  for (let y = 4; y < 12; y++) for (let x = 0; x < 16; x++) rgba.set(x > 5 && x < 10 ? [100, 160, 70, 255] : [255, 255, 255, 255], (y * 16 + x) * 4);
  const art = pixelsFromRgba(rgba, true);
  assert.equal(art.pixels[4 * 16], null); assert.equal(art.pixels[4 * 16 + 6], '#64A046');
  assert.equal(art.pixels.filter(Boolean).length, 32);
});
