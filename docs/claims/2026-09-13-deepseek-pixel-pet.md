# DeepSeek + concurrent play + pixel companion

User request: use the supplied DeepSeek key for Pro generation and play; AI plays on the left while the human plays on the right; add XiaoTangYuan, editable pixel pets with import/export.

Base: fde101b from the clean original C:/game/deepseekharness/PetRival checkout. Final delivery branch: codex/deepseek-pixel-release. Original runtime/storage stay unchanged.

During implementation unrelated concurrent chat/growth/Sites work appeared in the shared workspace. It was preserved. The final isolated checkout at .artifacts/delivery contains only this request's generation/play/pixel changes and their tests. No unrelated shared files were reverted or committed. Its local runtime uses port 4473 and a separate snapshot of the test save.

Required behavior:
- Server-only credential, ignored .env; no key in frontend, logs, commits, or exported pets. DeepSeek model deepseek-v4-pro, verified against current official documentation.
- Preprepared verified levels and immutable match versions stay intact. Human and AI can progress independently and simultaneously. Live AI actions are the engine-executed prefix, not a simulated success.
- Explicit change from old spec: owners may view their pet's run while playing; remove old replay embargo. No generation proof is sent to contestant models.
- Scores, deadlines, ownership, training exclusion, persistence, infrastructure-failure distinction remain enforced.
- XiaoTangYuan is a pixel avatar preset; editable/exportable cosmetic data only, never ownership, ranking or credentials. Strict imported-data validation.

Entrypoints: server/provider.mjs, server/arena.mjs, server/http.mjs, shared pixel data, public UI, .env.example, tests and docs.

Validation: baseline tests; regression evidence for changed live visibility behavior; real HTTP identity/progress/import boundaries; simulated provider faults; actual DeepSeek generation and engine-validated play; browser side-by-side operation and editor import/export. Report source/tests/mock/live/browser/GitHub status separately. No public deployment or capacity claim.

Follow-up: user reported a motionless AI. The exact challenged run completed in 14 steps / 65.645 seconds; whole-plan thinking was not distinguished clearly from movement. Show waiting/replanning/execution phases and elapsed time. Bound progress GET reads (including response bodies) to 10 seconds, release their polling lock on failure, preserve write semantics and refresh on visibility return. Regression tests cover stalled reads and recovery; a fresh real-browser DeepSeek practice completed in 20 steps / displayed 54 seconds. This changes visibility and reconnection, not model latency or thinking quality.

Authorized experiment: compare Pro high/low/none on ten frozen existing levels, once each. Add explicit MODEL_PLAY_EFFORT while keeping the default and preparation at high. Keep the same prompt, 16384 Token budget, production 180-second clock and 220ms engine execution. At most two concurrent whole trials, no hidden infrastructure retry, no solver used by the contestant. Measure first actual movement, engine-verified success, full elapsed time and numeric usage; preserve failures and provider errors. Existing game data and ranking are outside the experiment. Do not claim a faster default or target latency without the completed evidence.

Experiment complete: 30 unique combinations independently audited. High cleared 9/10 with first-move median 80.70s (one run never moved); low cleared 10/10 with 61.26s; none cleared 0/10 with 1.28s among the eight runs that moved. Current local runtime is trying low gameplay and high preparation; repository default stays high. No mode with successful play met the 10-second first-move target. Local runtime, browser behavior, source tests, and the experiment are separate evidence categories.
