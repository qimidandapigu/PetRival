import { createHash, randomBytes } from 'node:crypto';
import { ApiError } from '../server/arena.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const cookieValue = (request, name) => (request.headers.get('cookie') || '').split(';').map(value => value.trim()).find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const sessionKey = request => {
  const token = cookieValue(request, 'petrival_account');
  return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? `auth:${hash(token)}` : null;
};
export function accountSession(request, arena) {
  const key = sessionKey(request), session = key && arena.s.sessions[key];
  return session?.kind === 'cloudbase' && session.expiresAt > arena.now() ? session : null;
}
export function authConfig(env) {
  const envId = env.CLOUDBASE_ENV_ID || '';
  return { enabled: /^[a-z0-9][a-z0-9-]{3,99}$/.test(envId), envId, region: 'ap-shanghai' };
}
export async function verifyCloudBase(env, accessToken, fetcher = fetch) {
  const config = authConfig(env);
  if (!config.enabled) throw new ApiError(503, '手机号登录尚未配置');
  if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 8192 || /[\s\r\n]/.test(accessToken)) throw new ApiError(401, '登录凭证无效，请重新验证手机号');
  let response, profile;
  try {
    response = await fetcher(`https://${config.envId}.api.tcloudbasegateway.com/auth/v1/user/me`, {
      headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'manual', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new ApiError([400, 401, 403].includes(response.status) ? 401 : 503, '手机号身份验证失败，请重新登录或稍后重试');
    profile = await response.json();
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(503, '暂时无法连接手机号认证服务，请稍后重试'); }
  if (profile.status !== 'ACTIVE' || typeof profile.sub !== 'string' || !/^[\w-]{1,128}$/.test(profile.sub) || typeof profile.phone_number !== 'string' || !/^\+86\s?1\d{10}$/.test(profile.phone_number) || profile.is_anonymous === true) throw new ApiError(401, '请使用已验证的中国大陆手机号登录');
  const phone = profile.phone_number.replace(/\s/g, '').slice(3);
  return { owner: `cloudbase:${config.envId}:${profile.sub}`, maskedPhone: `${phone.slice(0, 3)}****${phone.slice(-4)}` };
}
const accountCookie = (request, token, seconds) => `petrival_account=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${seconds}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
export function signInAccount(request, arena, verified, { useExisting = false, sourceOwner } = {}) {
  // Only bind the current guest/Sites save, never move another phone account's pet.
  const guestOwner = accountSession(request, arena) ? null : (sourceOwner || arena.owner(cookieValue(request, 'petrival')));
  const guest = guestOwner && arena.mine(guestOwner), accountPet = arena.mine(verified.owner);
  // Never merge scores or overwrite an existing pet when two saves exist.
  if (guest && accountPet && guest.id !== accountPet.id && !useExisting) return { conflict: true, guestName: guest.name, accountName: accountPet.name };
  const oldKey = sessionKey(request);
  for (const [id, session] of Object.entries(arena.s.sessions)) if (session.kind === 'cloudbase' && session.expiresAt <= arena.now()) delete arena.s.sessions[id];
  if (Object.keys(arena.s.sessions).length - (oldKey && arena.s.sessions[oldKey] ? 1 : 0) >= 10000) throw new ApiError(503, '登录会话容量已满，请稍后重试');
  let migrated = false;
  if (guest && !accountPet) {
    guest.owner = verified.owner;
    for (const practice of Object.values(arena.s.practices)) if (practice.owner === guestOwner) practice.owner = verified.owner;
    migrated = true;
  }
  const token = randomBytes(32).toString('hex'), age = 30 * 24 * 3600;
  if (oldKey) delete arena.s.sessions[oldKey];
  arena.s.sessions[`auth:${hash(token)}`] = { kind: 'cloudbase', owner: verified.owner, maskedPhone: verified.maskedPhone, createdAt: arena.now(), expiresAt: arena.now() + age * 1000 };
  return { ok: true, migrated, setCookie: accountCookie(request, token, age) };
}
export function signOutAccount(request, arena) {
  const key = sessionKey(request); if (key) delete arena.s.sessions[key];
  return accountCookie(request, '', 0);
}
