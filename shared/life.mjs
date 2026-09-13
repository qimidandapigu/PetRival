// Small, server-clock-driven village life. No chat text or client-provided stats
// can grant progress: effects occur only when a scheduled activity completes.
export const LIFE_ACTIONS = Object.freeze(['wander', 'rest', 'water', 'feed']);
export const LIFE_LOCATIONS = Object.freeze({
  home: { id: 'home', name: '小屋门前', x: .28, y: .46 },
  garden: { id: 'garden', name: '菜园', x: .66, y: .49 },
  picnic: { id: 'picnic', name: '野餐角', x: .30, y: .73 },
  pond: { id: 'pond', name: '池塘边', x: .78, y: .74 },
  plaza: { id: 'plaza', name: '村间小路', x: .49, y: .60 },
});
const LABELS = { wander: '在村里散步', rest: '在小屋休息', water: '照料菜园', feed: '享用点心' };
const DURATION = { wander: 16000, rest: 20000, water: 18000, feed: 14000 };
const ROUTINE = ['wander', 'water', 'wander', 'rest', 'wander', 'feed'];
const WALK_MS = 3500, SAVE_STEP_MS = 5000, OFFLINE_CAP_MS = 180000, DAY_MS = 720000, WATER_LASTS_MS = 180000;
const clamp = n => Math.max(0, Math.min(100, n));
const point = p => ({ x: p.x, y: p.y });

export function ensureLife(pet, now) {
  if (pet.life?.version === 1) {
    if (Number.isSafeInteger(pet.life.revision) && pet.life.revision >= 0) return false;
    pet.life.revision = 0; return true;
  }
  // Old pets start living now, rather than earning invented offline history.
  pet.life = { version: 1, revision: 0, initializedAt: now, updatedAt: now, activity: 'wander', source: 'routine',
    location: { ...LIFE_LOCATIONS.plaza }, from: point(LIFE_LOCATIONS.home), startedAt: now, endsAt: now + DURATION.wander,
    energy: 82, hunger: 24, mood: 78, crops: { wateredAt: null, growth: 0, harvests: 0 }, routineIndex: 0, wanderIndex: 0, sequence: 0, events: [] };
  return true;
}

export function lifePosition(life, now) {
  const fraction = Math.max(0, Math.min(1, (now - life.startedAt) / (life.walkMs || WALK_MS)));
  const points = [life.from];
  const distance = (a, b) => Math.hypot((a.x - b.x) * 384, (a.y - b.y) * 256);
  if (distance(life.from, life.location) > 75) points.push({ x: 188 / 384, y: 154 / 256 });
  points.push(life.location);
  const distances = points.slice(1).map((point, i) => distance(points[i], point));
  let travel = distances.reduce((sum, length) => sum + length, 0) * fraction;
  for (let i = 0; i < distances.length; i++) {
    if (travel <= distances[i]) {
      const t = travel / (distances[i] || 1);
      return { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t };
    }
    travel -= distances[i];
  }
  return point(life.location);
}

function begin(life, action, now, source) {
  const from = lifePosition(life, now);
  const destination = action === 'rest' ? 'home' : action === 'water' ? 'garden' : action === 'feed' ? 'picnic'
    : ((life.wanderIndex || 0) % 2 ? 'plaza' : 'pond');
  if (action === 'wander') life.wanderIndex = (life.wanderIndex || 0) + 1;
  Object.assign(life, { activity: action, source, from, location: { ...LIFE_LOCATIONS[destination] }, startedAt: now, endsAt: now + DURATION[action] });
}

function elapse(life, until) {
  const elapsed = Math.max(0, until - life.updatedAt), minutes = elapsed / 60000;
  life.energy = clamp(life.energy - minutes * .7);
  life.hunger = clamp(life.hunger + minutes * .9);
  life.mood = clamp(life.mood - minutes * .3);
  if (life.crops.wateredAt !== null) {
    const wateredMs = Math.max(0, Math.min(until, life.crops.wateredAt + WATER_LASTS_MS) - Math.max(life.updatedAt, life.crops.wateredAt));
    life.crops.growth = clamp(life.crops.growth + wateredMs / 3600);
  }
  life.updatedAt = until;
}

function complete(life, at) {
  let text;
  if (life.activity === 'water') {
    life.energy = clamp(life.energy - 4); life.mood = clamp(life.mood + 3);
    if (life.crops.growth >= 100) {
      life.crops.harvests++; life.crops.growth = 0; text = '收获了菜园里的蔬菜，又给新芽浇了水。';
    } else text = '给菜园浇好了水，等小苗慢慢长大。';
    life.crops.wateredAt = at;
  } else if (life.activity === 'rest') {
    life.energy = clamp(life.energy + 22); life.mood = clamp(life.mood + 2); text = '在小屋休息了一会儿，精神好多了。';
  } else if (life.activity === 'feed') {
    life.hunger = clamp(life.hunger - 30); life.energy = clamp(life.energy + 4); life.mood = clamp(life.mood + 4); text = '在野餐角吃完了点心，心满意足。';
  } else {
    life.energy = clamp(life.energy - 2); life.mood = clamp(life.mood + 5); text = `在${life.location.name}走了一圈，看看风景。`;
  }
  life.sequence++;
  life.events.push({ id: `life-${life.sequence}`, text, at });
  life.events = life.events.slice(-8);
}

export function advanceLife(pet, now) {
  const initialized = ensureLife(pet, now), life = pet.life;
  if (now <= life.updatedAt || (now - life.updatedAt < SAVE_STEP_MS && now < life.endsAt)) return initialized;
  // Catch up a bounded amount after a long shutdown. Schedule rebasing prevents
  // thousands of fabricated harvests and keeps the next live action in motion.
  const until = Math.min(now, life.updatedAt + OFFLINE_CAP_MS);
  while (life.endsAt <= until) {
    const completedAt = life.endsAt;
    elapse(life, completedAt); complete(life, completedAt);
    life.routineIndex = (life.routineIndex + 1) % ROUTINE.length;
    const next = life.energy < 30 ? 'rest' : life.hunger > 65 ? 'feed' : ROUTINE[life.routineIndex];
    begin(life, next, completedAt, 'routine');
  }
  elapse(life, until);
  if (until < now) {
    const skipped = now - until;
    life.startedAt += skipped; life.endsAt += skipped; life.updatedAt = now;
    // Water does not last indefinitely just because offline catch-up is capped.
    if (life.crops.wateredAt !== null && now - life.crops.wateredAt > WATER_LASTS_MS) life.crops.wateredAt = null;
  }
  life.revision++;
  return true;
}

export function requestLifeAction(pet, action, now, source = 'manual') {
  if (!LIFE_ACTIONS.includes(action)) throw new Error('请选择散步、休息、浇水或喂食');
  if (!['manual', 'conversation'].includes(source)) throw new Error('生活行动来源无效');
  const changed = advanceLife(pet, now), life = pet.life;
  // Repeated decisions cannot finish, multiply, or continually restart an activity.
  if (life.activity === action && life.source === source) return changed;
  elapse(life, Math.max(now, life.updatedAt));
  begin(life, action, Math.max(now, life.updatedAt), source);
  life.revision++;
  return true;
}

export function lifeView(pet, now) {
  const life = pet.life;
  if (!life) return null;
  const elapsed = Math.max(0, now - life.initializedAt), phase = elapsed % DAY_MS / DAY_MS;
  const timeOfDay = phase < .22 ? 'morning' : phase < .62 ? 'day' : phase < .80 ? 'evening' : 'night';
  return { revision: life.revision ?? 0, updatedAt: life.updatedAt, activity: life.activity, activityLabel: LABELS[life.activity], source: life.source,
    location: { ...life.location }, from: point(life.from), startedAt: life.startedAt, endsAt: life.endsAt, walkMs: WALK_MS,
    energy: Math.round(life.energy), hunger: Math.round(life.hunger), mood: Math.round(life.mood),
    crops: { wateredAt: life.crops.wateredAt, growth: Math.floor(life.crops.growth), harvests: life.crops.harvests },
    day: Math.floor(elapsed / DAY_MS) + 1, timeOfDay, events: life.events.map(event => ({ id: event.id, text: event.text, at: event.at })) };
}
