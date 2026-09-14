export const GAMES = Object.freeze([
  Object.freeze({ id: 'sokoban', name: '推箱子', description: '和宠物一起规划路线，把每个箱子推到目标点。', available: true }),
  Object.freeze({ id: 'boxing', name: '打拳', description: '宠物对打，真人同时迎战；拳台积分单独排名。', available: true }),
]);

export const XP_PER_CLEAR = 40;
export const XP_PER_LEVEL = 100;
const MILESTONES = [
  { id: 'first-route', name: '初识路线', requiredClears: 1, description: '成长记录：宠物已实际完成第一张推箱子关卡。' },
  { id: 'route-explorer', name: '路线探索', requiredClears: 3, description: '成长记录：宠物已实际完成 3 张不同的推箱子关卡。' },
  { id: 'box-partner', name: '推箱伙伴', requiredClears: 5, description: '成长记录：宠物已实际完成 5 张不同的推箱子关卡。' },
];

export function ensureGrowth(pet) {
  if (!pet.growth || !Array.isArray(pet.growth.clearedLevels)) pet.growth = { clearedLevels: [] };
  if (!GAMES.some(game => game.id === pet.selectedGame)) pet.selectedGame = 'sokoban';
  return pet.growth;
}

// Call only after the server has replayed the pet's executed actions and verified a successful run.
// The starting puzzle's generation proof and human play never count as pet experience.
export function recordVerifiedClear(pet, boardHash, completedAt) {
  const growth = ensureGrowth(pet);
  if (growth.clearedLevels.some(record => record.hash === boardHash)) return false;
  growth.clearedLevels.push({ hash: boardHash, completedAt });
  return true;
}

export function progressionView(pet) {
  const records = ensureGrowth(pet).clearedLevels;
  const clears = records.length, xp = clears * XP_PER_CLEAR;
  return {
    level: Math.floor(xp / XP_PER_LEVEL) + 1, xp, xpIntoLevel: xp % XP_PER_LEVEL,
    xpForNextLevel: XP_PER_LEVEL, clears,
    skills: MILESTONES.map(skill => ({
      ...skill, unlocked: clears >= skill.requiredClears,
      requirement: `宠物通过 ${skill.requiredClears} 张不同关卡（由游戏引擎验证）`,
      uses: 0,
      ...(clears >= skill.requiredClears ? { learnedAt: records[skill.requiredClears - 1].completedAt } : {}),
    })),
  };
}

export function puzzleMasteryView(pet) {
  const clears = ensureGrowth(pet).clearedLevels.length;
  const tier = clears >= 10 ? 3 : clears >= 3 ? 2 : 1;
  return { level: tier, maxSize: tier + 7, maxBoxes: tier + 1, clears,
    nextAt: tier === 1 ? 3 : tier === 2 ? 10 : null,
    selected: pet.puzzleSettings || { size: 8, boxes: 2, difficulty: 'normal' } };
}
export function puzzleSettings(pet, requested) {
  const ability = puzzleMasteryView(pet), previous = pet.puzzleSettings || { size: 8, boxes: 2, difficulty: 'normal' };
  const settings = requested === undefined ? previous : { ...previous, ...requested };
  if (!settings || !Number.isInteger(settings.size) || settings.size < 8 || settings.size > ability.maxSize ||
      !Number.isInteger(settings.boxes) || settings.boxes < 2 || settings.boxes > ability.maxBoxes || !['normal','hard'].includes(settings.difficulty)) {
    throw new Error('尚未解锁这个出题规格，或难度设置不合法');
  }
  return { size: settings.size, boxes: settings.boxes, difficulty: settings.difficulty };
}
