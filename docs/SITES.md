# Sites deployment and persistence

The repository root is the canonical source for both the local Node service and the published Sites Worker. The ignored `sites-app/` checkout is only a publishing mirror with its existing Sites repository history. It is not a second implementation: synchronize tracked source from this root before building and publishing. Never copy `.env`, `.dev.vars`, local saves, `.git`, dependencies or `.artifacts` into a source commit or deployment archive.

The existing `.openai/hosting.json` identifies PetRival. Reuse that project and its current audience; do not create a replacement site. Sites owns the real D1 resource. Existing generated migration SQL and metadata are immutable. Living state and conversations use existing pet JSON data and the jobs table. The v11 boxing integration additionally includes the additive `0001_eminent_war_machine.sql` migration creating `boxing_matches`; package it with the existing migrations. Do not reset saves or rewrite previously applied SQL.

`npm run build` emits `dist/server/index.js`, `dist/client`, and `dist/.openai` with the logical bindings and migrations. Push the exact source to the existing Sites source repository, obtain the full commit SHA, package only `dist`, save a version and deploy to the site's existing audience. Wait for terminal deployment success. GitHub main and the Sites source repository have distinct commit histories; their application source files must match.

## Runtime behavior

- D1 persists pets, verified puzzles, matches, skills, courtyard state, private chat, sessions, background jobs and the score ledger.
- Two foreground work requests and one preparation request run while the page is open. Preparation cannot occupy either contestant slot. Closing all pages stops new job claims; persisted tasks resume on later visits. This is not an always-running offline simulation.
- Chat turns are persisted before model work, serialized for each pet, and completed with their validated action and receipt in one transaction. Completed request IDs do not replay actions. Expired claims cannot overwrite a retry. Chat cannot grant game experience or ranking points.
- Only the owner can read private chat or claim its task. An opponent can help run match/preparation jobs without receiving chat history. Private level proofs and unexecuted model plans are excluded from public responses.
- This prototype loads arena records per request, uses a revision fence for atomic changes, and caps 500 pets and 2,000 matches. Larger public operation needs partitioning and archival; this release is not a capacity certification.
- Anonymous data is saved in D1 but access depends on the current browser cookie until bound to an account. ChatGPT identity and CloudBase SMS phone login with guest-account binding are supported. Phone identity is verified server-side. Email authentication is not implemented.
- Provider requests use `redirect: 'manual'`: Workers does not support `redirect: 'error'`. Redirect responses fail safely without forwarding model credentials. Server diagnostics retain only job kind, error class/code and upstream HTTP status.
- Voided matches remain unranked and immutable. Their recovery panel can open the same board and local moves as an unranked practice, or explicitly create a new challenge.

## Verification boundary

Run `npm test`, `npm run test:cloud`, `npm run check`, and `npm run build`. Cloud tests use SQLite to exercise the same Worker handler, job transactions, identities, retries and score bookkeeping. A passing suite does not prove live provider behavior or human acceptance.

The Worker runtime regression also runs the bundled application under Miniflare/workerd (installed with Wrangler) against a local model HTTP double, including redirect rejection. This catches runtime incompatibilities that Node-only handler tests cannot detect.

`node scripts/preview.mjs` serves the same Worker locally against temporary in-memory SQLite when the native Windows Worker emulator is unavailable. Use it only as a development preview. Production data remains in Sites D1.

## Historical v11 release and development baseline

As verified on 2026-09-14, Sites v11 is published successfully at https://petrival.clear-oasis-2741.chatgpt.site/. The game integration is GitHub main `b995ae8088d5787516c5ce4874145747e74eaf80`; its Sites mirror source is `7faec498ef239f8a4b4f620cbf0db0a9b2979d3e`. Documentation-only follow-ups may advance GitHub main without changing this deployed runtime.

Boxing queues, input and settlement persist in D1; model work runs outside transactions. The competition skill is fixed when a match starts. Sokoban defaults to feedback; candidate preview remains opt-in. See [the integration evidence](claims/2026-09-14-multi-game-integration.md).

Daily check-in AI credit, ads and payment are not part of v11. Refer to [CONTRIBUTING.md](../CONTRIBUTING.md) before new work; the publishing mirror is not a development branch.

## Puzzle mastery upgrade

Preparation jobs now persist a server-validated size/box/difficulty snapshot in existing JSON data. Unlocks derive from verified unique pet clears; no migration is required. Both Worker and Node support 8–10 square boards and 2–4 boxes, including step observations and previews. Failed hard-board verification keeps the previous ready level. See [implementation and validation](PUZZLE-MASTERY-2026-09-14.md).

Current release: **v14 succeeded** on 2026-09-14. Puzzle mastery runtime source is GitHub `aaaca5e2429ff1caab32b3548bb6271a5f26da89`, Sites source `1dc34b0beb7d8ce7066e8fac1e3afbfc50d633b9`; 50 runtime source files match. See the puzzle mastery validation record above. Later documentation-only commits do not change the deployed runtime.

## Spirit naming release

Sites v15 succeeded on 2026-09-14. GitHub runtime source: `f2be068`; Sites source: `00c95c3e529a34157380e15941b2c640df4349ce`. Default labels, legacy pet names, displayed chat text and courtyard activity use 小精灵. Stored identity, species IDs and historical records are unchanged. 14 targeted regression tests, syntax checks and build passed; deployment `appgdep_6aa7bc55014c8191a91398d6f04db4c7` reported succeeded. No new browser or real-model gameplay test was performed for this text change.

## Jump class release

Sites v16 succeeded on 2026-09-14: `/jump.html` is linked from the game library. GitHub source `779ecee`; Sites source `6d7216a5b54d35bf1b85b909511013bfc7c537bd`. 63 runtime source files matched. Deployment `appgdep_6aa7f132c9788191aca25cab41d0903e` reported succeeded. 162 Node tests and 39 cloud tests passed. This game uses browser-local demonstration memory; no D1 migration, model calls, account rewards or cloud-learning synchronization. See [learning and verification boundaries](JUMP-CLASS-2026-09-14.md).

## Model-driven jump update

The current source adds real-model jump decisions and model-generated platform geometry with replay verification. Existing session identities are reused; no schema migration. Demonstrations remain browser-local and unranked. The previous v16 description is historical. See [behavior and evidence](JUMP-MODEL-2026-09-15.md) for source versus deployment status.

Sites v17 succeeded on 2026-09-15. Runtime GitHub `b1ad48b`, Sites `ec5bc1675b548d53f5d982c7bb975bef180d861b`; 64 runtime files identical. 167 Node + 40 cloud tests, syntax/secret-pattern scan and build passed. Deployment `appgdep_6aa8b5d6c8f48191a0fba1e186ed5b9f` reported succeeded. Real local model generation and partial gameplay checked; full learning effectiveness remains unverified.
