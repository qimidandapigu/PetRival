// Fixed-step authoritative fighting rules, shared with tests and presentation.
export const BOXING = Object.freeze({ tickMs: 50, limitMs: 45000, width: 800, hp: 30, humanOpponentMultiplier: 5, commandTicks: 10 });
export const ACTIONS = Object.freeze(['idle', 'advance', 'retreat', 'jab', 'heavy', 'guard']);
export const ATTACKS = Object.freeze({ jab: { startup: 2, active: 1, recovery: 5, range: 114, damage: 8 }, heavy: { startup: 5, active: 2, recovery: 9, range: 140, damage: 16 } });
export function newBout(multiplier = 1) {
  return { frame: 0, status: 'running', winner: null, endMs: null, events: [], fighters: [1, multiplier].map((scale, i) => ({ x: i ? 610 : 190, hp: BOXING.hp * scale, maxHp: BOXING.hp * scale, power: scale, action: 'idle', attack: null, stun: 0, flash: 0, facing: i ? -1 : 1 })) };
}
export function finishBout(bout, winner, reason = 'ko') {
  if (bout.status !== 'running') return;
  bout.status = 'done'; bout.winner = winner; bout.reason = reason; bout.endMs = bout.frame * BOXING.tickMs;
}
export function stepBout(bout, inputs) {
  if (bout.status !== 'running') return bout;
  bout.frame++; bout.events = []; const hits = [];
  for (let i = 0; i < 2; i++) {
    const f = bout.fighters[i], opponent = bout.fighters[1 - i];
    f.facing = opponent.x >= f.x ? 1 : -1; f.flash = Math.max(0, f.flash - 1);
    if (f.stun > 0) { f.stun--; f.action = 'hurt'; continue; }
    const input = ACTIONS.includes(inputs[i]) ? inputs[i] : 'idle';
    if (!f.attack) {
      if (ATTACKS[input]) f.attack = { kind: input, age: 0, tried: false };
      else {
        f.action = input;
        const direction = input === 'advance' ? f.facing : input === 'retreat' ? -f.facing : 0;
        const next = Math.max(55, Math.min(745, f.x + direction * 11));
        f.x = i === 0 ? Math.min(next, opponent.x - 82) : Math.max(next, opponent.x + 82);
      }
    }
    if (f.attack) {
      const attack = f.attack, spec = ATTACKS[attack.kind]; f.action = attack.kind; attack.age++;
      if (!attack.tried && attack.age >= spec.startup && attack.age < spec.startup + spec.active) {
        attack.tried = true;
        if (Math.abs(opponent.x - f.x) <= spec.range) hits.push({ from: i, damage: spec.damage * f.power, kind: attack.kind });
        else bout.events.push({ type: 'miss', from: i });
      }
      if (attack.age >= spec.startup + spec.active + spec.recovery) f.attack = null;
    }
  }
  // Resolve simultaneous hits from the same frame together; neither side gets iteration priority.
  const resolved = hits.map(hit => ({ ...hit, blocked: bout.fighters[1 - hit.from].action === 'guard' && !bout.fighters[1 - hit.from].attack && !bout.fighters[1 - hit.from].stun }));
  for (const hit of resolved) {
    const target = bout.fighters[1 - hit.from]; const damage = Math.ceil(hit.damage * (hit.blocked ? 0.2 : 1));
    target.hp = Math.max(0, target.hp - damage); target.flash = 4;
    target.x = Math.max(55, Math.min(745, target.x + (hit.from === 0 ? 1 : -1) * (hit.blocked ? 8 : 20)));
    if (!hit.blocked) { target.stun = hit.kind === 'heavy' ? 4 : 2; target.attack = null; target.action = 'hurt'; }
    bout.events.push({ type: hit.blocked ? 'block' : 'hit', from: hit.from, damage });
  }
  if (bout.fighters.some(f => f.hp === 0)) finishBout(bout, bout.fighters[0].hp === bout.fighters[1].hp ? null : bout.fighters[0].hp > 0 ? 0 : 1);
  else if (bout.frame * BOXING.tickMs >= BOXING.limitMs) {
    // Relative HP makes the intentionally stronger human opponent beatable on time.
    const difference = bout.fighters[0].hp / bout.fighters[0].maxHp - bout.fighters[1].hp / bout.fighters[1].maxHp;
    finishBout(bout, Math.abs(difference) < 1e-9 ? null : difference > 0 ? 0 : 1, 'time');
  }
  return bout;
}
export function boxingScore(bout, fighter) { return { score: bout.winner === null ? 0 : bout.winner === fighter ? 100 : -20, rankMs: bout.winner === fighter ? bout.endMs : BOXING.limitMs }; }
export function fighterObservation(bout, fighter) {
  const self = bout.fighters[fighter], rival = bout.fighters[1 - fighter];
  const visible = f => ({ hp: f.hp, maxHp: f.maxHp, power: f.power, action: f.action, attackAge: f.attack?.age ?? null, stunned: f.stun > 0 });
  return { secondsLeft: Math.max(0, (BOXING.limitMs - bout.frame * BOXING.tickMs) / 1000), distance: Math.round(Math.abs(self.x - rival.x)), self: visible(self), opponent: visible(rival) };
}
