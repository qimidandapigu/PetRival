// Fixed-step authoritative fighting rules, shared with tests and presentation.
export const BOXING = Object.freeze({ tickMs: 50, limitMs: 45000, width: 800, hp: 30, humanOpponentMultiplier: 5, commandTicks: 10 });
export const ACTIONS = Object.freeze(['idle', 'advance', 'retreat', 'jab', 'heavy', 'guard', 'throw']);
const LEGACY_ATTACKS = Object.freeze({ jab: { startup: 2, active: 1, recovery: 5, range: 114, damage: 8 }, heavy: { startup: 5, active: 2, recovery: 9, range: 140, damage: 16 } });
export const ATTACKS = Object.freeze({ jab: { startup: 2, active: 1, recovery: 5, range: 114, damage: 3 }, heavy: { startup: 7, active: 1, recovery: 14, range: 125, damage: 6 }, throw: { startup: 6, active: 1, recovery: 13, range: 102, damage: 4 } });
const specs = bout => bout.rulesVersion === 2 ? ATTACKS : LEGACY_ATTACKS;
const recovering = (f, table) => !!f.attack && f.attack.age >= table[f.attack.kind].startup + table[f.attack.kind].active;
function signal(bout, fighter, message) { bout.fighters[fighter].cue = { message, until: bout.frame + 20 }; }
function remember(bout, event) { bout.history ||= []; bout.history.push({ frame: bout.frame, ...event }); bout.history = bout.history.slice(-16); }
export function newBout(multiplier = 1) {
  return { rulesVersion: 2, history: [], frame: 0, status: 'running', winner: null, endMs: null, events: [], fighters: [1, multiplier].map((scale, i) => ({ x: i ? 610 : 190, hp: BOXING.hp * scale, maxHp: BOXING.hp * scale, power: scale, action: 'idle', attack: null, stun: 0, flash: 0, facing: i ? -1 : 1 })) };
}
export function finishBout(bout, winner, reason = 'ko') {
  if (bout.status !== 'running') return;
  bout.status = 'done'; bout.winner = winner; bout.reason = reason; bout.endMs = bout.frame * BOXING.tickMs;
}
export function stepBout(bout, inputs) {
  if (bout.status !== 'running') return bout;
  bout.frame++; bout.events = []; const hits = [], table = specs(bout), modern = bout.rulesVersion === 2;
  for (let i = 0; i < 2; i++) {
    const f = bout.fighters[i], opponent = bout.fighters[1 - i];
    f.facing = opponent.x >= f.x ? 1 : -1; f.flash = Math.max(0, f.flash - 1);
    if (f.stun > 0) { f.stun--; f.action = 'hurt'; continue; }
    const input = ACTIONS.includes(inputs[i]) ? inputs[i] : 'idle';
    if (!f.attack) {
      if (table[input]) { f.attack = { kind: input, age: 0, tried: false }; if (modern) remember(bout, { type: 'start', from: i, kind: input }); }
      else {
        f.action = input;
        const direction = input === 'advance' ? f.facing : input === 'retreat' ? -f.facing : 0;
        const next = Math.max(55, Math.min(745, f.x + direction * 11));
        f.x = i === 0 ? Math.min(next, opponent.x - 82) : Math.max(next, opponent.x + 82);
      }
    }
    if (f.attack) {
      const attack = f.attack, spec = table[attack.kind]; f.action = attack.kind; attack.age++;
      if (!attack.tried && attack.age >= spec.startup && attack.age < spec.startup + spec.active) {
        attack.tried = true;
        if (Math.abs(opponent.x - f.x) <= spec.range) hits.push({ from: i, damage: spec.damage * f.power, kind: attack.kind });
        else { bout.events.push({ type: 'miss', from: i, kind: attack.kind }); if (modern) signal(bout, i, '打空了 · 收招中'); }
      }
      if (attack.age >= spec.startup + spec.active + spec.recovery) f.attack = null;
    }
  }
  // Resolve simultaneous hits from the same frame together; neither side gets iteration priority.
  const resolved = hits.map(hit => ({ ...hit, counter: modern && recovering(bout.fighters[1 - hit.from], table), blocked: hit.kind !== 'throw' && bout.fighters[1 - hit.from].action === 'guard' && !bout.fighters[1 - hit.from].attack && !bout.fighters[1 - hit.from].stun }));
  for (const hit of resolved) {
    const target = bout.fighters[1 - hit.from]; const damage = modern ? hit.blocked ? 0 : hit.damage + (hit.counter ? 2 * bout.fighters[hit.from].power : 0) : Math.ceil(hit.damage * (hit.blocked ? 0.2 : 1));
    target.hp = Math.max(0, target.hp - damage); target.flash = 4;
    target.x = Math.max(55, Math.min(745, target.x + (hit.from === 0 ? 1 : -1) * (hit.blocked ? modern ? 4 : 8 : 20)));
    if (modern && hit.blocked) { target.stun = hit.kind === 'heavy' ? 3 : 2; signal(bout, 1-hit.from, hit.kind === 'heavy' ? '挡住重拳 · 反击机会' : '防御成功'); }
    if (!hit.blocked) { target.stun = hit.kind === 'heavy' ? 4 : 2; target.attack = null; target.action = 'hurt'; }
    const type = hit.blocked ? 'block' : hit.kind === 'throw' ? 'guardbreak' : hit.counter ? 'counter' : 'hit';
    bout.events.push({ type, from: hit.from, damage, kind: hit.kind });
    if (modern && !hit.blocked) signal(bout, hit.from, hit.kind === 'throw' ? '抱摔命中 · 无视防御' : hit.counter ? '反击成功！' : '命中');
  }
  if (modern) for (const event of bout.events) remember(bout, event);
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
  const visible = f => ({ hp: f.hp, maxHp: f.maxHp, power: f.power, action: f.action, attackAge: f.attack?.age ?? null, stunned: f.stun > 0, recovering: recovering(f, specs(bout)), recoveryMs: recovering(f, specs(bout)) ? (specs(bout)[f.attack.kind].startup + specs(bout)[f.attack.kind].active + specs(bout)[f.attack.kind].recovery - f.attack.age)*BOXING.tickMs : 0 });
  return { rulesVersion: bout.rulesVersion || 1, recent: (bout.history || []).slice(-10).map(e => ({ ...e, from: e.from === fighter ? 'self' : 'opponent' })), secondsLeft: Math.max(0, (BOXING.limitMs - bout.frame * BOXING.tickMs) / 1000), distance: Math.round(Math.abs(self.x - rival.x)), self: visible(self), opponent: visible(rival) };
}

export function boxingInstructions(observation) {
  const rules = observation.rulesVersion === 2
    ? 'Jab range114 damage3 startup0.1s recovery0.25s. Heavy range125 damage6 startup0.35s recovery0.7s. Throw range102 damage4 startup0.3s recovery0.65s; ignores guard but can be interrupted by jab or avoided by retreat. Guard stops all strike damage. Attacking a recovering opponent adds2 damage. All damage scales with power. Attacks cannot cancel into guard or movement. Block a heavy then jab during recovery; throw habitual guards; jab interrupts slow moves; bait whiffs with retreat. Use recent visible events to adapt; no action is always best.'
    : 'Legacy bout: jab range114 damage8 startup0.1s total0.4s; heavy range140 damage16 startup0.25s total0.8s. Guard reduces damage to20%. Do not use throw in legacy bouts.';
  return 'Control a pixel boxing fighter. Return JSON {"actions":["advance","jab","retreat"]}, 1 to3 actions each0.5s. Allowed idle,advance,retreat,jab,heavy,guard,throw. Idle does not block. Walk220/sec; fighters cannot cross. '+rules+' Only visible state and past events are available, never future inputs. Timeout compares remaining HP percentage.';
}
export function boxingBotAction(bout, fighter) {
  const o = fighterObservation(bout, fighter);
  if (o.rulesVersion !== 2) { const phase = Math.floor(bout.frame/12)%6; return o.distance>110?'advance':phase===0?'guard':phase===1?'retreat':phase===4?'heavy':'jab'; }
  if (o.opponent.recovering) return o.distance>112?'advance':o.opponent.recoveryMs>600?'heavy':'jab';
  if (o.opponent.action==='throw' && !o.opponent.stunned) return o.distance<=114?'jab':'retreat';
  if (o.opponent.action==='heavy' && !o.opponent.stunned && o.distance<=125) return 'guard';
  if (o.distance>110) return 'advance';
  if (o.opponent.action==='guard') return o.distance>100?'advance':'throw';
  const phase=(Math.floor(bout.frame/16)+fighter)%4;
  return phase===0?'guard':phase===1?'retreat':phase===2?'jab':'heavy';
}
