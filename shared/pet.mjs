// Cosmetic data only. Never carry ownership, scores, credentials, or executable art.
export const PET_SPECIES = Object.freeze(['xiaotangyuan', 'sprout', 'fox', 'ghost']);
export const SPECIES_LABELS = Object.freeze({ xiaotangyuan: '小精灵', sprout: '芽芽灵', fox: '火花狐', ghost: '云朵兽' });
export const PET_FILE_LIMIT = 65536;
const HEX = /^#[0-9a-f]{6}$/i;
const PAL = { O: '#66594D', W: '#FFFAE9', C: '#EEE1BC', S: '#DBC998', E: '#354B3F', P: '#F2A79D', R: '#D87068', G: '#719659', L: '#ACCA7D', D: '#52754C', F: '#E0A365', A: '#BF7B4A', B: '#A2B9CE', H: '#D5E3E9', I: '#7E96B1' };
const PATTERNS = {
  xiaotangyuan: [
    '................', '.........GG.....', '.......GLG......', '......GGG.......',
    '.....OOOOOO.....', '...OOWWWWWCOO...', '..OWWWWWWWWCCO..', '..OWWWWWWWWWCO..',
    '.OWWWEWWWWEWCCO.', '.OWWWWWWWWWWCCO.', '.OWPPWWWWWWPPCO.', '..OWWWWEEWWCSO..',
    '..OCWWWWWWWCSO..', '...OOCCCCCSOO...', '.....OOOOOO.....', '....OO....OO....'
  ],
  sprout: [
    '................', '..DD.....DDD....', '..DLLD..DLLD....', '...DLLDDLLD.....',
    '....DDGDDD......', '...DDLLLLLDD....', '..DLLLLLLLLGD...', '.DLLLLLLLLLLGD..',
    '.DLLLELLLELLGD..', '.DLLLELLLELLGD..', '.DLPPLLLLLPPGD..', '..DLLLLLLLLGD...',
    '..DGLLDDLLGGD...', '...DDGGGGGDD....', '....DD...DD.....', '................'
  ],
  fox: [
    '................', '..OO.......OO...', '..OFO.....OFO...', '..OFFO...OFFO...',
    '..OFAOOOOOAFO...', '..OFFFAAAFFFO...', '.OFFFAFFFFAFFO..', '.OFFFEFFFEFFAO..',
    '.OFFFEFFFEFFAO..', '.OFPWWWWWWWWPFO.', '..OFWWWEWWWFO...', '..OFFWWWWWFAO...',
    '...OFFWAFFAO....', '....OAAAAAO.....', '....OO...OO.....', '................'
  ],
  ghost: [
    '................', '.......HH.......', '.....HHBBH......', '....HBBBBBH.....',
    '...HBBBBBBBH....', '..HBBBBBBBBBH...', '..HBBBBBBBBBI...', '.HBBBBBBBBBBBI..',
    '.HBBBEBBBEBBBI..', '.HBBBEBBBEBBBI..', '.HBBPPBBBPPBBI..', '..IBBBEEBBBBI...',
    '..IBBBBBBBBBI...', '..IBBIBBIBBBI...', '...II.II.III....', '................'
  ]
};
// Pad tiny hand-drawn patterns to a fixed frame before rendering.
export function defaultAppearance(species = 'xiaotangyuan') {
  const rows = PATTERNS[species] || PATTERNS.xiaotangyuan;
  return { version: 1, size: 16, pixels: rows.flatMap(row => [...row.padEnd(16, '.').slice(0, 16)].map(c => PAL[c] || null)) };
}
function objectWithKeys(raw, keys, message) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Object.keys(raw).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(raw, k))) throw new Error(message);
}
export function validateAppearance(raw) {
  objectWithKeys(raw, ['version', 'size', 'pixels'], '像素外观格式不正确');
  if (raw.version !== 1 || raw.size !== 16 || !Array.isArray(raw.pixels) || raw.pixels.length !== 256) throw new Error('外观必须是 16 × 16 像素');
  // Array.from also validates sparse array entries, which map would silently skip.
  const pixels = Array.from(raw.pixels, color => {
    if (color === null) return null;
    if (typeof color !== 'string' || !HEX.test(color)) throw new Error('像素只能是透明或六位十六进制颜色');
    return color.toUpperCase();
  });
  return { version: 1, size: 16, pixels };
}
function cosmetic(pet) {
  if (typeof pet.name !== 'string' || !pet.name.trim() || [...pet.name.trim()].length > 16 || /[\u0000-\u001f\u007f]/.test(pet.name)) throw new Error('名字需要 1 至 16 个字，不能含控制字符');
  if (!PET_SPECIES.includes(pet.species)) throw new Error('不支持的宠物类型');
  return { name: pet.name.trim(), species: pet.species, appearance: validateAppearance(pet.appearance ?? defaultAppearance(pet.species)) };
}
export function exportPet(pet) {
  return { format: 'petrival-pet', version: 1, ...cosmetic(pet) };
}
export function parsePetFile(input) {
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > PET_FILE_LIMIT) throw new Error('宠物文件不能超过 64 KB');
    try { input = JSON.parse(input); } catch { throw new Error('不是有效的宠物 JSON 文件'); }
  }
  objectWithKeys(input, ['format', 'version', 'name', 'species', 'appearance'], '只能导入 PetRival 外观文件，不能携带账号或积分数据');
  if (input.format !== 'petrival-pet' || input.version !== 1) throw new Error('不支持的宠物文件版本');
  return cosmetic(input);
}
export function petMarkup(pet, extraClass = '') {
  if (typeof pet === 'string') pet = { species: pet };
  const species = PET_SPECIES.includes(pet?.species) ? pet.species : 'xiaotangyuan';
  let appearance;
  try { appearance = validateAppearance(pet?.appearance ?? defaultAppearance(species)); }
  catch { appearance = defaultAppearance(species); }
  const classes = String(extraClass).split(/\s+/).filter(c => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(c)).join(' ');
  const rects = appearance.pixels.map((color, index) => color ? `<rect x="${index % 16}" y="${Math.floor(index / 16)}" width="1" height="1" fill="${color}"/>` : '').join('');
  return `<svg class="pixel-pet ${species}${classes ? ` ${classes}` : ''}" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${rects}</svg>`;
}

// Display compatibility only; stored names and species IDs remain unchanged.
export function petDisplayName(name) { return name === '小汤圆' ? '小精灵' : name; }
