// The SDK is loaded only after an explicit login action. Game saves remain in D1.
const host = document.querySelector('.top-right');
if (host) {
  const button = document.createElement('button');
  button.type = 'button'; button.id = 'phone-login'; button.hidden = true; host.append(button);
  const saveNotice = document.createElement('p');
  saveNotice.id = 'guest-save-note'; saveNotice.hidden = true;
  host.closest('header').after(saveNotice);
  const dialog = document.createElement('dialog');
  dialog.className = 'phone-dialog'; dialog.setAttribute('aria-labelledby', 'phone-title');
  dialog.innerHTML = `<form id="phone-form">
    <div class="section-heading"><h2 id="phone-title">手机号登录</h2><button type="button" id="phone-close" aria-label="关闭登录">×</button></div>
    <p id="phone-save-note">登录后，宠物和积分会跟着账号走。首次登录将绑定当前宠物；已有存档时会先让你选择。</p>
    <label for="phone-number">中国大陆手机号</label><input id="phone-number" type="tel" inputmode="tel" autocomplete="tel-national" maxlength="11" pattern="1[0-9]{10}" required placeholder="输入 11 位手机号">
    <label for="phone-code">短信验证码</label><div class="input-row"><input id="phone-code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" pattern="[0-9]{4,8}" placeholder="验证码"><button type="button" id="phone-send">获取验证码</button></div>
    <p id="phone-status" role="status" aria-live="polite"></p>
    <button type="submit" class="primary" id="phone-submit" disabled>登录并保存宠物</button>
    <button type="button" id="phone-existing" hidden>使用账号已有存档</button>
    <button type="button" id="phone-skip">暂不登录，继续玩</button>
    <button type="button" id="phone-logout" hidden>退出手机号账号</button>
    <p class="fine">验证码由腾讯云发送。未注册的手机号验证后自动注册。登录或退出会刷新页面，请先完成当前游戏。</p>
  </form>`;
  document.body.append(dialog);
  const $ = id => dialog.querySelector('#' + id), phone = $('phone-number'), code = $('phone-code'), send = $('phone-send'), submit = $('phone-submit');
  let current, authPromise, verifyOtp, accessToken, busy = false, retryAt = 0;
  const say = text => { $('phone-status').textContent = text; };
  async function request(path, body) {
    const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error || '服务暂时不可用'); error.data = data; throw error; }
    return data;
  }
  const auth = () => authPromise ||= (async () => {
    const config = await request('/api/auth/config');
    if (!config.enabled) throw new Error('手机号登录尚未配置');
    const sdk = await import('/cloudbase-auth.mjs'); return sdk.createAuth(config);
  })().catch(error => { authPromise = null; throw error; });
  function controls() {
    const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    send.disabled = busy || seconds > 0; send.textContent = seconds ? `${seconds} 秒后重发` : '获取验证码';
    phone.disabled = busy; code.disabled = busy; submit.disabled = busy || !verifyOtp;
    $('phone-existing').disabled = busy; $('phone-logout').disabled = busy;
    $('phone-close').disabled = busy;
    $('phone-skip').disabled = busy;
  }
  function providerError(error) {
    const kind = String(error?.code || '') + ' ' + String(error?.message || '');
    if (/rate|frequen|limit|频繁/i.test(kind)) return '请求过于频繁，请稍后再试。';
    if (/disabled|not.enabled|not.support|未开启|未启用/i.test(kind)) return '短信登录尚未开通，请联系站点作者开启短信登录。';
    if (/domain|origin|域名/i.test(kind)) return '网站域名尚未获准登录，请联系站点作者配置安全域名。';
    if (/captcha|验证码|verification|otp|expired/i.test(kind)) return '验证未通过或已过期，请检查验证码，必要时重新获取。';
    return '暂时无法完成短信验证，请稍后重试。';
  }
  async function exchange(useExisting = false) {
    try {
      await request('/api/auth/cloudbase', { accessToken, useExisting });
      accessToken = null; say('登录成功，正在读取你的宠物…'); location.reload();
    } catch (error) {
      if (error.data?.code === 'account_has_pet') {
        say(`当前宠物「${error.data.guestName}」与账号中的「${error.data.accountName}」不同。可使用账号已有存档，或关闭窗口保留当前存档；两份存档不会合并。`);
        $('phone-existing').hidden = false;
      } else say(error.message);
    }
  }
  globalThis.petRivalPhoneLogin = { update(state) {
    current = state;
    button.hidden = !state.auth?.phoneEnabled;
    button.textContent = state.auth?.provider === 'cloudbase' ? state.auth.maskedPhone : '手机号登录 · 保存进度';
    saveNotice.hidden = state.storage !== 'D1' || state.signedIn === true;
    saveNotice.textContent = '不登录也能直接玩。游客进度仅能通过当前浏览器找回，清理浏览器数据、身份过期或换设备后可能无法恢复。' + (state.auth?.phoneEnabled ? '登录绑定进度后，可在其他设备继续。' : '');
  } };
  button.addEventListener('click', () => {
    const signed = current?.auth?.provider === 'cloudbase';
    $('phone-title').textContent = signed ? `已登录 ${current.auth.maskedPhone}` : '手机号登录';
    $('phone-save-note').textContent = signed ? '宠物、小院、对话和积分已保存在账号中。换设备登录同一手机号即可继续。' : '不登录也能继续玩。登录后，当前宠物、小院、对话和积分会绑定到手机号，换设备也能找回。若账号已有另一份存档，会先让你选择，不会覆盖。';
    for (const element of [phone, code, send, submit, ...dialog.querySelectorAll('label')]) element.hidden = signed;
    $('phone-logout').hidden = !signed; $('phone-skip').hidden = signed; dialog.showModal(); controls();
    if (!signed) void auth().catch(() => { if (dialog.open && !busy) say('登录服务加载失败，请关闭窗口后重试。'); });
  });
  function clearProof() { verifyOtp = null; accessToken = null; code.value = ''; $('phone-existing').hidden = true; controls(); }
  function dismiss() { clearProof(); phone.value = ''; say(''); }
  $('phone-close').addEventListener('click', () => { if (!busy) { dismiss(); dialog.close(); } });
  $('phone-skip').addEventListener('click', () => { if (!busy) { dismiss(); dialog.close(); } });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); else dismiss(); });
  phone.addEventListener('input', () => { clearProof(); say(''); });
  send.addEventListener('click', async () => {
    if (busy || Date.now() < retryAt || !phone.reportValidity()) return;
    busy = true; clearProof(); say('正在请求验证码…');
    try {
      const provider = await auth();
      // SDK CAPTCHA overlays live outside this dialog: release the modal top layer
      // while the provider is running so its verification UI remains operable.
      dialog.close(); dialog.show();
      const result = await provider.signInWithOtp({ phone: `+86 ${phone.value}`, options: { shouldCreateUser: true } });
      if (result.error || !result.data?.verifyOtp) throw result.error || new Error('OTP unavailable');
      verifyOtp = result.data.verifyOtp; retryAt = Date.now() + 60000; say('验证码已发送，请在下方输入。'); code.focus();
    } catch (error) { say(providerError(error)); }
    finally { if (dialog.open) dialog.close(); dialog.showModal(); busy = false; controls(); if (verifyOtp) code.focus(); }
  });
  $('phone-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !verifyOtp) return;
    if (!/^\d{4,8}$/.test(code.value)) { say('请输入短信中的验证码。'); return; }
    busy = true; controls(); say('正在验证…');
    try {
      const result = await verifyOtp({ token: code.value });
      if (result.error) throw result.error;
      accessToken = result.data?.session?.access_token;
      if (!accessToken) { const session = await (await auth()).getSession(); if (session.error) throw session.error; accessToken = session.data?.session?.access_token; }
      if (!accessToken) throw new Error('session unavailable');
      code.value = ''; await exchange();
    } catch (error) { say(providerError(error)); }
    finally { busy = false; controls(); }
  });
  $('phone-existing').addEventListener('click', async () => {
    if (busy || !accessToken) return; busy = true; controls();
    try { await exchange(true); } finally { busy = false; controls(); }
  });
  $('phone-logout').addEventListener('click', async () => {
    if (busy) return; busy = true; controls();
    try {
      await request('/api/auth/logout', {});
      if (authPromise) { try { await (await authPromise).signOut(); } catch {} }
      location.reload();
    } catch (error) { say(error.message); busy = false; controls(); }
  });
  setInterval(() => { if (dialog.open) controls(); }, 1000);
}
