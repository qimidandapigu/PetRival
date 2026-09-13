import { PET_SPECIES, validateAppearance } from './pet.mjs';

const PREFIX = 'PETLOOK1.';
export function validateLook(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'appearance,species' || !PET_SPECIES.includes(value.species)) {
    throw new Error('外观码格式不正确，只能包含类型和像素外观');
  }
  return { species: value.species, appearance: validateAppearance(value.appearance) };
}
export function encodeLook(pet) {
  return PREFIX + btoa(JSON.stringify(validateLook({ species: pet.species, appearance: pet.appearance })));
}
export function decodeLook(text) {
  if (typeof text !== 'string' || text.length > 16384) throw new Error('外观码过长');
  const code = text.trim();
  if (!code.startsWith(PREFIX)) throw new Error('请粘贴以 PETLOOK1. 开头的外观码');
  const data = code.slice(PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4) throw new Error('外观码不完整，请重新复制');
  try {
    if (btoa(atob(data)) !== data) throw new Error();
    return validateLook(JSON.parse(atob(data)));
  } catch { throw new Error('外观码损坏或包含不支持的数据，请重新复制'); }
}

// Fit the whole image initially; zoom and pan use the same coordinates in both previews.
export function imagePlacement(width, height, zoom = 1, x = 0, y = 0, size = 320) {
  if (![width, height, zoom, x, y, size].every(Number.isFinite) || width <= 0 || height <= 0 || zoom < 1 || size <= 0) throw new Error('图片尺寸不正确');
  const scale = size / Math.max(width, height) * zoom;
  return { x: (size - width * scale) / 2 + x * size / 200,
    y: (size - height * scale) / 2 + y * size / 200, width: width * scale, height: height * scale };
}

export function pixelsFromRgba(rgba, removeBackground = false) {
  if (rgba.length !== 1024) throw new Error('像素采样尺寸不正确');
  const pixels = Array.from({ length: 256 }, (_, i) => rgba[i * 4 + 3] < 128 ? null : '#' +
    Array.from(rgba.slice(i * 4, i * 4 + 3), n => n.toString(16).padStart(2, '0')).join('').toUpperCase());
  if (removeBackground) {
    // Only erase connected edge pixels close to a corner color; retain enclosed details.
    const opaque = pixels.flatMap((color, i) => color ? [i] : []);
    if (!opaque.length) return { version: 1, size: 16, pixels };
    const left = Math.min(...opaque.map(i => i % 16)), right = Math.max(...opaque.map(i => i % 16));
    const top = Math.min(...opaque.map(i => Math.floor(i / 16))), bottom = Math.max(...opaque.map(i => Math.floor(i / 16)));
    const corners = [top * 16 + left, top * 16 + right, bottom * 16 + left, bottom * 16 + right].filter(i => pixels[i]);
    const colors = corners.map(i => Array.from(rgba.slice(i * 4, i * 4 + 3)));
    const visited = new Set(), queue = [];
    for (let i = 0; i < 16; i++) queue.push(i, 240 + i, i * 16, i * 16 + 15);
    for (let p = 0; p < queue.length; p++) {
      const i = queue[p]; if (visited.has(i)) continue; visited.add(i);
      if (pixels[i] && !colors.some(color => color.every((c, n) => Math.abs(c - rgba[i * 4 + n]) <= 24))) continue;
      pixels[i] = null;
      if (i % 16) queue.push(i - 1); if (i % 16 < 15) queue.push(i + 1);
      if (i >= 16) queue.push(i - 16); if (i < 240) queue.push(i + 16);
    }
  }
  return { version: 1, size: 16, pixels };
}
