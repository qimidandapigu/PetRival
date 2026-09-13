import cloudbase from '@cloudbase/js-sdk/app';
import '@cloudbase/js-sdk/auth';
export function createAuth(config) {
  return cloudbase.init({ env: config.envId, region: config.region }).auth({ persistence: 'session' });
}
