# Sites deployment and persistence

The repository root is the canonical source for both the local Node service and the published Sites Worker. The ignored `sites-app/` checkout is only a publishing mirror with its existing Sites repository history. It is not a second implementation: synchronize tracked source from this root before building and publishing. Never copy `.env`, `.dev.vars`, local saves, `.git`, dependencies or `.artifacts` into a source commit or deployment archive.

The existing `.openai/hosting.json` identifies PetRival. Reuse that project and its current audience; do not create a replacement site. Sites owns the real D1 resource. Existing generated migration SQL and metadata are immutable. This integration adds living state and conversations inside the existing pet JSON data and uses the existing jobs table, so no new schema migration or save reset is required.

`npm run build` emits `dist/server/index.js`, `dist/client`, and `dist/.openai` with the logical bindings and migrations. Push the exact source to the existing Sites source repository, obtain the full commit SHA, package only `dist`, save a version and deploy to the site's existing audience. Wait for terminal deployment success. GitHub main and the Sites source repository have distinct commit histories; their application source files must match.

## Runtime behavior

- D1 persists pets, verified puzzles, matches, skills, courtyard state, private chat, sessions, background jobs and the score ledger.
- Two foreground work requests and one preparation request run while the page is open. Preparation cannot occupy either contestant slot. Closing all pages stops new job claims; persisted tasks resume on later visits. This is not an always-running offline simulation.
- Chat turns are persisted before model work, serialized for each pet, and completed with their validated action and receipt in one transaction. Completed request IDs do not replay actions. Expired claims cannot overwrite a retry. Chat cannot grant game experience or ranking points.
- Only the owner can read private chat or claim its task. An opponent can help run match/preparation jobs without receiving chat history. Private level proofs and unexecuted model plans are excluded from public responses.
- This prototype loads arena records per request, uses a revision fence for atomic changes, and caps 500 pets and 2,000 matches. Larger public operation needs partitioning and archival; this release is not a capacity certification.
- Anonymous data is saved in D1 but access depends on the current browser cookie. ChatGPT identity is also supported. Phone/email authentication and guest-account linking are not implemented.
- Provider requests use `redirect: 'manual'`: Workers does not support `redirect: 'error'`. Redirect responses fail safely without forwarding model credentials. Server diagnostics retain only job kind, error class/code and upstream HTTP status.
- Voided matches remain unranked and immutable. Their recovery panel can open the same board and local moves as an unranked practice, or explicitly create a new challenge.

## Verification boundary

Run `npm test`, `npm run test:cloud`, `npm run check`, and `npm run build`. Cloud tests use SQLite to exercise the same Worker handler, job transactions, identities, retries and score bookkeeping. A passing suite does not prove live provider behavior or human acceptance.

The Worker runtime regression also runs the bundled application under Miniflare/workerd (installed with Wrangler) against a local model HTTP double, including redirect rejection. This catches runtime incompatibilities that Node-only handler tests cannot detect.

`node scripts/preview.mjs` serves the same Worker locally against temporary in-memory SQLite when the native Windows Worker emulator is unavailable. Use it only as a development preview. Production data remains in Sites D1.
