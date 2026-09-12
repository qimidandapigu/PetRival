import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, 'petrival.json');
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { version: 1, sessions: {}, pets: {}, levels: {}, challenges: {} };
    if (this.state.version !== 1) throw new Error('不支持的存档版本');
  }
  save() {
    // Single Node process only. Atomic replacement prevents partially written JSON after interruption.
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
