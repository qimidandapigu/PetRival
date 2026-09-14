import { petDisplayName } from '../shared/pet.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PET_SPECIES, defaultAppearance, validateAppearance, petMarkup, exportPet, parsePetFile } from '../shared/pet.mjs';

test('all legacy species and XiaoTangYuan have detached valid 16px pixel art', () => {
  for (const species of PET_SPECIES) {
    const art = defaultAppearance(species); assert.equal(art.pixels.length, 256); assert.deepEqual(validateAppearance(art), art);
    assert.ok(art.pixels.filter(Boolean).length > 60);
    art.pixels.fill('#000000'); assert.notDeepEqual(defaultAppearance(species), art);
    assert.match(petMarkup({ species }), /<svg/);
  }
});
test('cosmetic JSON round trip keeps edits and excludes server authority', () => {
  const appearance = defaultAppearance('xiaotangyuan'); appearance.pixels[0] = '#ABC123';
  const pet = { id: 'private-id', owner: 'private-owner', score: 999, name: '小汤圆', species: 'xiaotangyuan', appearance };
  const file = exportPet(pet); const loaded = parsePetFile(JSON.stringify(file));
  assert.deepEqual(Object.keys(file), ['format', 'version', 'name', 'species', 'appearance']);
  assert.equal(loaded.appearance.pixels[0], '#ABC123'); assert.equal(loaded.name, '小汤圆');
  loaded.appearance.pixels[0] = null; assert.equal(pet.appearance.pixels[0], '#ABC123');
});
test('imports reject authority fields, oversized files and unsupported schema', () => {
  const file = exportPet({ name: '小汤圆', species: 'xiaotangyuan' });
  for (const key of ['id', 'owner', 'score', 'apiKey', '__proto__']) {
    assert.throws(() => parsePetFile(JSON.stringify({ ...file, [key]: 'untrusted' })));
  }
  assert.throws(() => parsePetFile(' '.repeat(65537)));
  assert.throws(() => parsePetFile({ ...file, version: 2 }));
  assert.throws(() => parsePetFile({ ...file, species: '<svg>' }));
  assert.throws(() => parsePetFile({ ...file, name: 'x'.repeat(17) }));
  assert.throws(() => parsePetFile({ ...file, name: 'a\nb' }));
  assert.throws(() => parsePetFile({ ...file, appearance: { ...file.appearance, script: 'bad' } }));
});
test('pixels reject executable colors, sparse arrays and arbitrary structures', () => {
  for (const bad of ['red', '#FFF', 'url(https://example.test)', '"><script>', {}, undefined, 42]) {
    const art = defaultAppearance(); art.pixels[0] = bad; assert.throws(() => validateAppearance(art));
  }
  assert.throws(() => validateAppearance({ version: 1, size: 16, pixels: new Array(256) }));
  const art = defaultAppearance(); art.pixels[0] = '#abcdef'; assert.equal(validateAppearance(art).pixels[0], '#ABCDEF');
});
test('pet SVG drops hostile attributes and recovers invalid stored artwork', () => {
  const svg = petMarkup({ species: 'xiaotangyuan', name: '<script>bad</script>', appearance: { pixels: [] } }, 'tiny "><script> alert(1)');
  assert.match(svg, /class="pixel-pet xiaotangyuan tiny"/); assert.ok(svg.includes('<rect'));
  assert.ok(!svg.includes('<script')); assert.ok(!svg.includes('alert(')); assert.ok(!svg.includes('style='));
});

test("legacy pet names and narrative display use the new name", () => {
  assert.equal(petDisplayName("小汤圆在等你，小汤圆想跳跃"), "小精灵在等你，小精灵想跳跃");
  assert.equal(petDisplayName("蓝莓"), "蓝莓");
  assert.equal(petDisplayName(undefined), undefined);
});
