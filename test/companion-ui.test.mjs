import { petDisplayName } from '../shared/pet.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function companion({ post = async request => ({ messages: [{ role: 'user', content: request.message }, { role: 'assistant', content: '你好呀！', method: 'algorithm' }] }), get = async () => ({ messages: [] }) } = {}) {
  // Run the production module. This small DOM boundary models focus, input state,
  // events and root replacement, so a redraw would really discard a typed draft.
  const elements = new Map(), requests = [], sceneFrames = [];
  let localNow = 10000;
  let document;
  class Element {
    constructor(id = '', tagName = 'DIV') {
      this.id = id; this.tagName = tagName; this.value = ''; this.textContent = ''; this.hidden = false;
      this.children = []; this.parent = null; this.dataset = {}; this.listeners = new Map(); this.attributes = new Map();
      this.scrollTop = 0; this.scrollHeight = 400; this.clientHeight = 200; this.markup = ''; this.isDisabled = false;
    }
    set innerHTML(html) {
      this.markup = html;
      if (this.id !== 'companion-hub') return;
      for (const [id, node] of elements) if (node !== this && this.contains(node)) elements.delete(id);
      this.children = [];
      for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/gi)) {
        const element = new Element(match[2], match[1].toUpperCase());
        element.parent = this; this.children.push(element); elements.set(element.id, element);
      }
      const chat = elements.get('pet-chat');
      for (const node of this.children) if (node.id.startsWith('chat-')) node.parent = chat;
      this.lifeActions = [...html.matchAll(/data-life-action="([^"]+)"/g)].map(match => { const button = new Element('', 'BUTTON'); button.dataset.lifeAction = match[1]; button.parent = this; return button; });
      this.prompts = [...html.matchAll(/data-prompt="([^"]+)"/g)].map(match => {
        const button = new Element('', 'BUTTON'); button.dataset.prompt = match[1]; button.parent = chat; return button;
      });
    }
    get innerHTML() { return this.markup; }
    set disabled(value) {
      this.isDisabled = value;
      if (value && document.activeElement === this) document.activeElement = document.body;
    }
    get disabled() { return this.isDisabled; }
    querySelector(selector) { const found = elements.get(selector.slice(1)); return found && this.contains(found) ? found : null; }
    querySelectorAll(selector) { return selector === '[data-prompt]' ? this.prompts || [] : selector === '[data-life-action]' ? this.lifeActions || [] : []; }
    contains(node) { for (let current = node; current; current = current.parent) if (current === this) return true; return false; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    addEventListener(type, listener) { const listeners = this.listeners.get(type) || []; listeners.push(listener); this.listeners.set(type, listeners); }
    dispatch(type, properties = {}) {
      const event = { currentTarget: this, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties };
      for (const listener of this.listeners.get(type) || []) listener(event);
      return event;
    }
    replaceChildren(...children) { this.children = children; children.forEach(child => { child.parent = this; }); }
    append(child) { child.parent = this; this.children.push(child); }
    insertAdjacentHTML(_position, html) { this.markup += html; }
    focus() { if (!this.disabled) document.activeElement = this; }
    scrollIntoView() {}
  }
  const body = new Element('body', 'BODY');
  for (const [id, tag] of [['companion-hub', 'DIV'], ['pet-skills', 'SECTION'], ['my-pet', 'SECTION'], ['intent', 'INPUT']]) {
    const node = new Element(id, tag); node.parent = body; elements.set(id, node);
  }
  document = {
    body, activeElement: body, querySelector: selector => elements.get(selector.slice(1)) || null,
    createElement: tag => new Element('', tag.toUpperCase()), createTextNode: text => ({ textContent: text }),
  };
  const api = async (path, input) => {
    assert.equal(path, '/api/pets/chat');
    if (!input) return get();
    requests.push({ ...input }); return post(input);
  };
  const source = readFileSync(new URL('../public/companion.mjs', import.meta.url), 'utf8')
    .replace(/^import[^\n]*\n/gm, '').replace('export function createCompanionHub', 'function createCompanionHub');
  const context = vm.createContext({ petDisplayName, document, crypto: { randomUUID }, petMarkup: () => '<svg></svg>', Date: class extends Date { static now() { return localNow; } }, createWorldScene: () => ({ update(frame) { sceneFrames.push(JSON.parse(JSON.stringify(frame))); }, destroy() {} }) });
  vm.runInContext(source + '\nthis.createHub = createCompanionHub;', context);
  const hub = context.createHub({ api, notify() {}, refresh() {}, onPlay() {} });
  const state = { mode: 'algorithm', mine: { id: 'pet', name: '团子', species: 'xiaotangyuan', progression: { level: 1, xp: 0, xpIntoLevel: 0, xpForNextLevel: 100, clears: 0, skills: [] } } };
  hub.update(state); await settle();
  const node = id => document.querySelector(`#${id}`);
  const type = message => { node('chat-input').value = message; node('chat-input').dispatch('input'); };
  const submit = () => node('chat-form').dispatch('submit');
  return { hub, state, document, node, type, submit, requests, sceneFrames, setTime: value => { localNow = value; } };
}

test('home polling preserves a typed chat draft and its focus', async () => {
  const ui = await companion();
  ui.type('今天想和你一起玩推箱子。'); ui.node('chat-input').focus();
  for (let n = 0; n < 10; n++) ui.hub.update({ ...ui.state, now: n });
  assert.equal(ui.node('chat-input').value, '今天想和你一起玩推箱子。');
  assert.equal(ui.document.activeElement, ui.node('chat-input'));
  assert.equal(ui.node('chat-send').disabled, false);
  assert.equal(ui.requests.length, 0);
});

test('concurrent chat submits send once and recover the controls after the reply', async () => {
  const reply = deferred(), ui = await companion({ post: () => reply.promise });
  ui.type('你好'); ui.submit(); ui.submit();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.node('chat-input').disabled, true);
  assert.equal(ui.node('chat-send').disabled, true);
  for (let n = 0; n < 3; n++) ui.hub.update(ui.state);
  assert.equal(ui.node('chat-input').value, '你好');
  assert.equal(ui.node('chat-send').disabled, true);
  reply.resolve({ messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好，搭档！', method: 'algorithm' }] });
  await settle();
  assert.equal(ui.node('chat-input').disabled, false);
  assert.equal(ui.node('chat-input').value, '');
  assert.match(ui.node('chat-log').innerHTML, /你好，搭档！/);
});

test('IME confirmation and Shift+Enter do not submit; a normal Enter sends exactly once', async () => {
  const reply = deferred(), ui = await companion({ post: () => reply.promise });
  ui.type('正在输入中文');
  const key = overrides => ui.node('chat-input').dispatch('keydown', { key: 'Enter', keyCode: 13, shiftKey: false, isComposing: false, ...overrides });
  assert.equal(key({ isComposing: true }).defaultPrevented, false);
  assert.equal(key({ keyCode: 229 }).defaultPrevented, false);
  assert.equal(key({ shiftKey: true }).defaultPrevented, false);
  assert.equal(ui.requests.length, 0);
  assert.equal(key({}).defaultPrevented, true);
  ui.submit();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].message, '正在输入中文');
  reply.resolve({ messages: [{ role: 'assistant', content: '收到中文啦。', method: 'algorithm' }] }); await settle();
});

test('retrying a failed message keeps its request identity and preserves a different unsent draft', async () => {
  let attempts = 0, saved = [];
  const ui = await companion({
    get: async () => ({ messages: saved }),
    post: async request => {
      attempts++;
      if (attempts === 1) { saved = [{ role: 'user', content: request.message }]; throw new Error('暂时离线'); }
      saved = [...saved, { role: 'assistant', content: '现在收到你的消息了。', method: 'algorithm' }];
      return { messages: saved };
    },
  });
  ui.type('消息 A'); ui.submit(); await settle();
  assert.equal(ui.node('chat-input').value, '消息 A');
  assert.equal(ui.node('chat-input').disabled, false);
  ui.type('单独写好的草稿 B');
  const retry = ui.node('chat-feedback').children.find(child => child.tagName === 'BUTTON');
  assert.ok(retry, 'a failed send offers an actionable retry');
  retry.dispatch('click'); await settle();
  assert.equal(ui.requests.length, 2);
  assert.equal(ui.requests[1].message, '消息 A');
  assert.equal(ui.requests[1].requestId, ui.requests[0].requestId);
  assert.equal(ui.node('chat-input').value, '单独写好的草稿 B');
  assert.equal(ui.node('chat-send').disabled, false);
  assert.match(ui.node('chat-log').innerHTML, /现在收到你的消息了。/);
});

test('a delayed pet reply does not steal focus from the level preparation input', async () => {
  const reply = deferred(), ui = await companion({ post: () => reply.promise });
  ui.type('我先聊一句'); ui.node('chat-input').focus(); ui.submit();
  ui.node('intent').value = '两个箱子，稍微绕一点'; ui.node('intent').focus();
  reply.resolve({ messages: [{ role: 'assistant', content: '好呀。', method: 'algorithm' }] }); await settle();
  assert.equal(ui.document.activeElement, ui.node('intent'));
  assert.equal(ui.node('intent').value, '两个箱子，稍微绕一点');
  assert.equal(ui.node('chat-input').disabled, false);
});

const lifeFixture = (revision, activity='wander') => ({ revision, activity, activityLabel: activity, location: {id:'plaza',name:'村间小路',x:.49,y:.6}, from:{x:.28,y:.46}, startedAt:10000,endsAt:26000,energy:82,hunger:24,mood:78,crops:{growth:0,harvests:0},day:1,timeOfDay:'day',events:[] });

test('a conversation updates the world without action buttons and survives an older home poll', async () => {
  const ui = await companion({post:async()=>({messages:[{role:'assistant',content:'好呀，我去照料菜地。',method:'algorithm'}],life:lifeFixture(4,'water')})});
  ui.hub.update({...ui.state,now:10000,mine:{...ui.state.mine,life:lifeFixture(2)}});
  assert.equal(ui.node('companion-hub').lifeActions.length,0);
  ui.type('去照料一下菜地吧'); ui.submit(); await settle();
  assert.equal(ui.requests.length,1);
  assert.equal(ui.requests[0].message,'去照料一下菜地吧');
  assert.equal(ui.sceneFrames.at(-1).life.activity,'water');
  ui.setTime(12000);
  ui.hub.update({...ui.state,now:10001,mine:{...ui.state.mine,life:lifeFixture(3)}});
  assert.equal(ui.sceneFrames.at(-1).life.activity,'water');
  assert.equal(ui.sceneFrames.at(-1).life.revision,4);
  assert.equal(ui.sceneFrames.at(-1).now,12000,'rejecting an older life snapshot also rejects its old clock');
});

test('chat completion keeps the courtyard clock moving and ignores an older life snapshot', async () => {
  const reply=deferred(), ui=await companion({post:()=>reply.promise});
  ui.hub.update({...ui.state,now:10000,mine:{...ui.state.mine,life:lifeFixture(5,'water')}});
  ui.type('你在做什么');ui.submit();ui.setTime(12000);
  reply.resolve({messages:[{role:'assistant',content:'我在菜园里。',method:'algorithm'}],life:lifeFixture(4)});
  await settle();
  assert.equal(ui.sceneFrames.at(-1).now,12000);
  assert.equal(ui.sceneFrames.at(-1).life.revision,5);
  assert.equal(ui.sceneFrames.at(-1).life.activity,'water');
});
