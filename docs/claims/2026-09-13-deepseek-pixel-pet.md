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
