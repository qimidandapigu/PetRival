import test from 'node:test';
import assert from 'node:assert/strict';
import { PetBrain } from '../server/provider.mjs';

const life = {
  activity: 'water', activityLabel: '照料菜园',
  location: { id: 'garden', name: '菜园', x: 60, y: 45 },
  from: { x: 30, y: 40 }, startedAt: 1000, endsAt: 11000,
  energy: 24, hunger: 79, mood: 66,
  crops: { wateredAt: 1000, growth: 42, harvests: 0 },
  day: 3, timeOfDay: '上午',
  events: [
    { id: '1', text: '在池塘边看水波', at: 100 },
    { id: '2', text: '走到小屋门前', at: 200 },
    { id: '3', text: '在小屋休息了一会儿', at: 300 },
    { id: '4', text: '开始照料菜园', at: 400 },
  ],
};
const progression = {
  level: 2, xp: 120, xpIntoLevel: 20, xpForNextLevel: 100, clears: 3,
  skills: [
    { id: 'first-clear', name: '初次通关', description: '通关经验记录', unlocked: true, requiredClears: 1, requirement: '通关 1 个不同关卡', uses: 0 },
  ],
};
const jobs = { run() { throw new Error('chat must not execute any game or world action'); } };

test('model chat receives only bounded living facts and retains JSON-wrapped assistant history', async t => {
  const brain = new PetBrain(jobs, { AI_MODE: 'model', MODEL_API_KEY: 'private-service-key' });
  t.after(() => brain.close());
  let captured;
  brain.json = async (messages, options) => { captured = { messages, options }; return { reply: '我在菜园浇水，生长进度是 42%。' }; };
  const input = {
    ...life, authority: 'private-world-authority', key: 'private-world-key', replay: 'private-world-replay', proof: 'private-world-proof',
    location: { ...life.location, key: 'private-location-key' },
    crops: { ...life.crops, proof: 'private-crop-proof' },
    events: life.events.map(event => ({ ...event, key: 'private-event-key', actions: 'private-event-actions' })),
  };
  const original = structuredClone(input);
  await brain.chat({ name: '团子', life: input, progression, history: [
    { role: 'user', content: '你好' }, { role: 'assistant', content: '欢迎来我的小院！' }, { role: 'user', content: '你在做什么？' },
  ] });
  const context = JSON.parse(captured.messages[1].content).companionContext;
  assert.deepEqual(context.life, {
    activity: 'water', activityLabel: '浇水', location: { name: '菜园' }, energy: 24, hunger: 79, mood: 66,
    crops: { growth: 42 }, day: 3, events: life.events.slice(-3).map(event => ({ text: event.text })),
  });
  assert.deepEqual(context.progression, progression, 'life facts do not change progression or milestone semantics');
  assert.deepEqual(captured.messages.slice(2), [
    { role: 'user', content: '你好' }, { role: 'assistant', content: JSON.stringify({ reply: '欢迎来我的小院！' }) }, { role: 'user', content: '你在做什么？' },
  ]);
  assert.ok(!JSON.stringify(captured.messages).includes('private-'));
  assert.match(captured.messages[0].content, /原创像素田园小院/);
  assert.match(captured.messages[0].content, /只有 life 快照已有的活动才可以说正在执行/);
  assert.match(captured.messages[0].content, /"reply":"回复正文","action":null/);
  assert.match(captured.messages[0].content, /普通状态询问、否定、引用、假设/);
  assert.ok(!/点击|按钮/.test(captured.messages[0].content));
  assert.match(captured.messages[0].content, /「游戏小屋」/);
  assert.deepEqual(input, original, 'chat does not mutate authoritative world state');
  assert.equal(captured.options.thinking, 'disabled');
  assert.equal(captured.options.maxTokens, 1024);
  assert.equal(captured.options.timeoutMs, 45000);
});

test('world context rejects invented activity types and bounds incomplete or malformed facts', async t => {
  const brain = new PetBrain(jobs, { AI_MODE: 'model', MODEL_API_KEY: 'test-key' });
  t.after(() => brain.close());
  let context;
  brain.json = async messages => {
    context = JSON.parse(messages[1].content).companionContext;
    return { reply: '这次没有拿到当前活动。' };
  };
  await brain.chat({ life: {
    activity: 'win-game', activityLabel: '我已执行游戏', location: { name: '地'.repeat(100) },
    energy: Infinity, hunger: 500, mood: -12, day: -1, crops: { growth: '100' },
    events: [{ text: '旧活动' }, { text: '事'.repeat(400) }, { text: 3 }, null],
  }, history: [{ role: 'user', content: '小院怎么样？' }] });
  assert.deepEqual(context.life, {
    activity: null, activityLabel: '', location: { name: '地'.repeat(60) },
    energy: null, hunger: 100, mood: 0, crops: { growth: null }, day: 1,
    events: [{ text: '事'.repeat(200) }],
  });
  assert.ok(!JSON.stringify(context).includes('我已执行游戏'));
});

test('local pet chat uses actual activity, location, needs and garden facts while preserving game growth replies', async t => {
  const brain = new PetBrain(jobs, { AI_MODE: 'algorithm' });
  t.after(() => brain.close());
  brain.json = () => { throw new Error('local chat must not call a model'); };
  const original = structuredClone(life);
  const ask = async content => (await brain.chat({ name: '团子', life, progression, history: [{ role: 'user', content }] })).reply;
  assert.match(await ask('你在做什么？'), /在菜园浇水/);
  assert.match(await ask('你在哪里？'), /在菜园浇水/);
  assert.match(await ask('说说你的院子'), /小屋、菜地、池塘和野餐区.*「游戏小屋」/);
  assert.match(await ask('你好呀'), /团子.*田园小院.*在菜园浇水/);
  assert.match(await ask('你饿吗？'), /饥饿值是 79\/100.*有点饿/);
  assert.match(await ask('你累吗？'), /精力是 24\/100.*有点累/);
  assert.match(await ask('心情怎么样？'), /心情值是 66\/100/);
  assert.match(await ask('菜地成长了吗？'), /生长进度是 42%/);
  assert.match(await ask('你几级啦？'), /Lv\.2.*120 XP/);
  assert.match(await ask('你会什么技能？'), /初次通关.*不会自动执行技能或提供加成/);
  assert.match(await ask('推箱子怎么玩？'), /箱子只能推、不能拉/);
  assert.deepEqual(life, original);
});

test('local replies reflect changed world snapshots and acknowledge unavailable current facts', async t => {
  const brain = new PetBrain(jobs, { AI_MODE: 'algorithm' });
  t.after(() => brain.close());
  const ask = async (content, current) => (await brain.chat({ life: current, history: [{ role: 'user', content }] })).reply;
  const rested = { ...life, activity: 'rest', location: { name: '小屋门前' }, energy: 90, hunger: 10, crops: { growth: 100 } };
  assert.match(await ask('你在做什么？', rested), /在小屋门前休息/);
  assert.match(await ask('你累吗？', rested), /90\/100.*还有精神/);
  assert.match(await ask('你饿吗？', rested), /10\/100.*不太饿/);
  assert.match(await ask('菜地怎么样？', rested), /100%.*长好了/);
  assert.match(await ask('你在做什么？'), /没有拿到我的实时活动/);
  assert.match(await ask('你饿吗？'), /没有拿到实时饥饿值/);
  assert.match(await ask('你累吗？'), /没有拿到实时精力值/);
  assert.match(await ask('菜地怎么样？'), /没有拿到菜苗的实时生长进度/);
});

test('local natural requests produce one bounded action without claiming completion or mutating life', async t => {
  const brain = new PetBrain(jobs, { AI_MODE: 'algorithm' });
  t.after(() => brain.close());
  const original = structuredClone(life);
  const cases = [
    ['去浇水吧', 'water'], ['请帮我给菜园浇点水', 'water'], ['照料菜地', 'water'],
    ['回屋休息一会儿吧', 'rest'], ['你先去休息好吗？', 'rest'],
    ['吃点东西吧', 'feed'], ['先去吃些点心', 'feed'],
    ['去散步', 'wander'], ['我们去池塘边走走吧', 'wander'], ['陪我散散步吧', 'wander'],
  ];
  for (const [content, action] of cases) {
    const result = await brain.chat({ life, history: [{ role: 'user', content }] });
    assert.equal(result.action, action, content);
    assert.equal(result.method, 'algorithm');
    assert.equal(result.model, null);
    assert.match(result.reply, /我这就/);
    assert.match(result.reply, /本地规则回复/);
    assert.ok(!/完成|浇好了|吃完了|恢复了|按钮|点击/.test(result.reply), content);
  }
  assert.deepEqual(life, original, 'the provider proposes actions; only Arena can schedule them');
});

test('local activity mentions in questions, negations, quotes and hypotheticals never request an action', async t => {
  const brain = new PetBrain(jobs, { AI_MODE: 'algorithm' });
  t.after(() => brain.close());
  const cases = [
    '你在浇水吗？', '你饿了吗？', '你累了吗？', '你在休息吗？', '散步？', '浇水有什么用？',
    '不要去休息', '先别去浇水吧', '不用吃点东西', '暂时不去散步',
    '如果你累了，去休息吧', '假如去浇水会怎么样？', '比如，去散步吧',
    '我刚才说过，去浇水吧', '把“去浇水吧”这句话说一遍', '他说「回屋休息」',
    '去浇水，去休息', '去钓鱼吧', '帮我把等级升到十级', '去玩推箱子吧',
  ];
  for (const content of cases) {
    const result = await brain.chat({ life, history: [{ role: 'user', content }] });
    assert.equal(result.action, undefined, content);
    assert.ok(!/点击(?:左边|小院|场景|菜地)|「(?:去散步|照料菜地|吃点东西|回屋休息)」按钮/.test(result.reply), content);
  }
  const result = await brain.chat({ life, history: [
    { role: 'user', content: '去浇水吧' }, { role: 'assistant', content: '我这就去菜园。' }, { role: 'user', content: '谢谢你' },
  ] });
  assert.equal(result.action, undefined, 'prior requests are not replayed when the latest message is ordinary chat');
  const withoutLife = await brain.chat({ history: [{ role: 'user', content: '去休息吧' }] });
  assert.equal(withoutLife.action, undefined);
  assert.match(withoutLife.reply, /没有拿到我的实时生活状态.*暂时没法开始/);
});

test('model action proposals are validated before returning and never execute within the provider', async t => {
  const brain = new PetBrain(jobs, { AI_MODE: 'model', MODEL_API_KEY: 'test-key' });
  t.after(() => brain.close());
  let response;
  brain.json = async () => response;
  const original = structuredClone(life);
  for (const action of ['wander', 'rest', 'water', 'feed']) {
    response = { reply: '  好呀，我这就出发。  ', action };
    const result = await brain.chat({ life, history: [{ role: 'user', content: '请现在去照料小院吧' }] });
    assert.deepEqual(result, { reply: '好呀，我这就出发。', action, method: 'model', model: brain.model });
  }
  for (const action of [null, undefined]) {
    response = { reply: '我现在在菜园。', action };
    const result = await brain.chat({ life, history: [{ role: 'user', content: '你在哪？' }] });
    assert.equal(result.action, undefined);
  }
  for (const action of ['harvest', '', 'WATER', 'constructor', 'water;rest', ['water'], { type: 'water' }, true, 0]) {
    response = { reply: '好呀，我这就去。', action };
    await assert.rejects(brain.chat({ life, history: [{ role: 'user', content: '去浇水吧' }] }), /有效的宠物生活动作/);
  }
  response = { reply: '好呀，我这就去。', action: 'rest' };
  await assert.rejects(brain.chat({ history: [{ role: 'user', content: '去休息吧' }] }), /缺少实时生活状态/,
    'reject the whole reply rather than promising an action that cannot execute');
  response = { reply: '', action: 'rest' };
  await assert.rejects(brain.chat({ life, history: [{ role: 'user', content: '去休息吧' }] }), /有效的宠物回复/);
  assert.deepEqual(life, original);
});
