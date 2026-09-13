export const GAMES = Object.freeze([
  Object.freeze({ id: 'sokoban', name: '推箱子', description: '和宠物一起规划路线，把每个箱子推到目标点。', available: true }),
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
  if (pet.selectedGame !== 'sokoban') pet.selectedGame = 'sokoban';
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
