import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, 'petrival.json');
    this.state = this.load();
    if (this.state.version !== 1) throw new Error('不支持的存档版本');
  }
  load() {
    if (!existsSync(this.file)) return { version: 1, sessions: {}, pets: {}, levels: {}, challenges: {} };
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      // A corrupt store must not take the whole server down: quarantine it and start
      // fresh — the alternative is every request failing on a JSON.parse at boot.
      const aside = `${this.file}.corrupt-${Date.now()}`;
      try { renameSync(this.file, aside); } catch {}
      console.warn(`[store] 存档损坏，已隔离为 ${aside}，从空存档重新开始`);
      return { version: 1, sessions: {}, pets: {}, levels: {}, challenges: {} };
    }
  }
  save() {
    // Single Node process only. Atomic replacement prevents partially written JSON after interruption.
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
