import test from 'node:test';
import assert from 'node:assert/strict';
import { actor, makeLevel, stepActor, touchObjects, freshProgress, gapAhead, JumpMemory, DemonstrationRecorder, PetController } from '../public/jump-engine.mjs';

// This synthetic keyboard player is test data only. Production has no scripted
// jump expert: it records only input actually performed by the human.
function demonstrate(level, memory, distance = 24) {
  const human = actor(), recorder = new DemonstrationRecorder(memory);
  for (let t = 0; t < 1200 && !human.dead && human.x < level.goalX; t++) {
    const gap = gapAhead(human, level);
    const input = { move: 1, jump: !human.grounded || !!(gap && gap[0] - human.x < distance && gap[0] >= human.x) };
    recorder.before(human, input, level); stepActor(human, input, level); recorder.after(human);
  }
  return human;
}
function runPet(level, memory) {
  const pet = actor(), controller = new PetController(memory), progress = freshProgress();
  for (let t = 0; t < 1200 && !pet.dead && !progress.won; t++) {
    stepActor(pet, controller.action(pet, level), level); touchObjects(pet, 'pet', level, progress);
  }
  return { pet, progress };
}
test('an untrained pet fails; recorded human input enables a real clear and transfers to shifted gaps', () => {
  const memory = new JumpMemory(), lesson = makeLevel(0);
  assert.equal(runPet(lesson, memory).pet.dead, true);
  assert.equal(demonstrate(lesson, memory).dead, false);
  assert.equal(memory.clips.length, 1);
  assert.equal(runPet(lesson, memory).progress.won, true);
  assert.equal(runPet(makeLevel(1), memory).progress.won, true, 'two unseen positions, no demonstration from that level');
  assert.equal(memory.clips.length, 1, 'pet actions never teach themselves into human memory');
});
test('wider gaps need new demonstrations; each reachable width can be taught', () => {
  const memory = new JumpMemory(); demonstrate(makeLevel(0), memory);
  assert.equal(runPet(makeLevel(2), memory).pet.dead, true);
  assert.equal(demonstrate(makeLevel(2), memory, 20).dead, false);
  assert.equal(memory.clips.length, 3);
  assert.equal(runPet(makeLevel(2), memory).progress.won, true);
});
test('human cannot collect, operate switch, or win; pet can', () => {
  const level = makeLevel(), progress = freshProgress();
  for (const x of [...level.coins.map(c => c.x), level.switchX, level.goalX]) touchObjects(actor(x), 'human', level, progress);
  assert.deepEqual(progress, freshProgress());
  for (const x of [...level.coins.map(c => c.x), level.switchX, level.goalX]) touchObjects(actor(x), 'pet', level, progress);
  assert.equal(progress.won, true);
});
test('failed and plain-ground jumps are not learning; reload preserves only validated clips', () => {
  const memory = new JumpMemory(); demonstrate(makeLevel(), memory, 145);
  assert.equal(memory.clips.length, 0);
  const recorder = new DemonstrationRecorder(memory), h = actor();
  for (let i = 0; i < 70; i++) { const input = { move: 0, jump: i < 30 }; recorder.before(h, input, makeLevel()); stepActor(h, input, makeLevel()); recorder.after(h); }
  assert.equal(memory.clips.length, 0);
  demonstrate(makeLevel(), memory);
  const loaded = new JumpMemory(JSON.parse(JSON.stringify(memory.json())));
  assert.equal(runPet(makeLevel(1), loaded).progress.won, true);
  assert.equal(new JumpMemory({ version: 1, clips: [{ width: 72, distance: 20, actions: [{ move: 99, jump: true }, {}] }] }).clips.length, 0);
});
