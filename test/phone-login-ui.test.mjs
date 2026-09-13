import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function fixture({ conflict = false } = {}) {
  const elements = new Map(), calls = [], sent = [], checked = []; let reloads = 0;
  class Element {
    constructor() { this.events = {}; this.value = ''; this.hidden = false; this.disabled = false; }
    addEventListener(name, fn) { this.events[name] = fn; }
    append() {} after(element) { elements.set(element.id, element); } closest() { return this; } setAttribute() {} querySelector(selector) { return get(selector.slice(1)); }
    querySelectorAll() { return []; } reportValidity() { return /^1\d{10}$/.test(this.value); }
    showModal() { this.open = true; } show() { this.open = true; } close() { this.open = false; } focus() {}
    async fire(name) { await this.events[name]?.({ preventDefault() {} }); }
  }
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let button, dialog;
  const document = { querySelector: () => get('host'), body: new Element(), createElement(tag) { const e = new Element(); if (tag === 'button') button = e; else if (tag === 'dialog') dialog = e; return e; } };
  const context = { document, setInterval() {}, Date, location: { reload() { reloads++; } },
    __sdk: { createAuth: () => ({ async signInWithOtp(params) { sent.push(params); return { data: { verifyOtp: async params => { checked.push(params); return { data: { session: { access_token: 'test-access' } } }; } } }; } }) },
    fetch: async (path, options) => {
      const body = options?.body && JSON.parse(options.body); calls.push({ path, body });
      let data = path === '/api/auth/config' ? { enabled: true, envId: 'test' } : { ok: true }, ok = true;
      if (path === '/api/auth/cloudbase' && conflict && !body.useExisting) { ok = false; data = { code: 'account_has_pet', guestName: '游客宠物', accountName: '账号宠物' }; }
      return { ok, json: async () => data };
    },
  };
  const source = readFileSync('public/phone-login.mjs', 'utf8').replace("import('/cloudbase-auth.mjs')", 'Promise.resolve(__sdk)');
  runInNewContext(source, context);
  context.petRivalPhoneLogin.update({ auth: { phoneEnabled: true, provider: 'guest' } });
  return { get, button, dialog, calls, sent, checked, update: context.petRivalPhoneLogin.update, reloads: () => reloads };
}

test('guest play never opens login or sends SMS automatically and skipping discards login proof', async () => {
  const f = fixture();
  f.update({ storage: 'D1', signedIn: false, auth: { phoneEnabled: true, provider: 'guest' } });
  assert.equal(f.dialog.open, undefined); assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.get('guest-save-note').hidden, false);
  await f.button.fire('click'); f.get('phone-number').value = '13800001234';
  await f.get('phone-send').fire('click'); await f.get('phone-skip').fire('click');
  assert.equal(f.dialog.open, false); assert.equal(f.get('phone-number').value, '');
  assert.equal(f.get('phone-submit').disabled, true); assert.equal(f.reloads(), 0);
  assert.equal(f.calls.some(c => c.path === '/api/auth/cloudbase'), false);
  f.update({ storage: 'D1', signedIn: true, auth: { phoneEnabled: true, provider: 'cloudbase', maskedPhone: '138****1234' } });
  assert.equal(f.get('guest-save-note').hidden, true);
});
test('phone UI uses SDK OTP callback, enforces resend delay and clears proof when phone changes', async () => {
  const f = fixture(); await f.button.fire('click'); f.get('phone-number').value = '13800001234';
  await f.get('phone-send').fire('click'); assert.equal(f.sent.length, 1); assert.equal(f.get('phone-submit').disabled, false); assert.equal(f.dialog.open, true);
  await f.get('phone-send').fire('click'); assert.equal(f.sent.length, 1);
  f.get('phone-code').value = '123456'; await f.get('phone-form').fire('submit');
  assert.equal(f.checked[0].token, '123456'); assert.equal(f.reloads(), 1);
  const exchange = f.calls.find(c => c.path === '/api/auth/cloudbase');
  assert.deepEqual(exchange.body, { accessToken: 'test-access', useExisting: false });
  await f.get('phone-number').fire('input'); assert.equal(f.get('phone-submit').disabled, true);
  assert.equal(f.calls.some(c => JSON.stringify(c.body || {}).includes('13800001234')), false);
});
test('phone UI requires explicit choice before using an existing account save', async () => {
  const f = fixture({ conflict: true }); await f.button.fire('click'); f.get('phone-number').value = '13800001234';
  await f.get('phone-send').fire('click'); f.get('phone-code').value = '123456'; await f.get('phone-form').fire('submit');
  assert.equal(f.reloads(), 0); assert.equal(f.get('phone-existing').hidden, false);
  assert.match(f.get('phone-status').textContent, /两份存档不会合并/);
  await f.get('phone-existing').fire('click'); assert.equal(f.reloads(), 1);
  assert.equal(f.calls.at(-1).body.useExisting, true);
});
