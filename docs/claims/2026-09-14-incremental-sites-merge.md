# Incremental gameplay integration

Merged the committed DeepSeek gameplay work through `59a6f6a` while retaining the courtyard, companion chat, appearance studio and CloudBase phone identity.

- Default gameplay disables thinking and lets the model select one reachable push at a time. The walking helper moves to that box; it does not solve the puzzle. Preparation keeps high thinking. Chat keeps its smaller token budget.
- The Sites runtime stores each selected action sequence, animates it against the locked board, and queues the next decision with recent moves and outcome feedback. Both ranked opponents use the same default. Practice also accepts explicit plan/step/push modes.
- The original three-minute clock continues through replanning, undo and restart. Incremental runs allow up to 60 decisions; three consecutive invalid decisions fail the run. Infrastructure failures still void matches rather than deduct points.
- Internal pending plans and feedback remain excluded from client run data; scores and progression still require engine validation.

Validation: 140 automated tests passed, including D1 request reconstruction, chosen-push animation, invalid-choice retry limits, Workers model HTTP/redirect behavior, phone login and existing courtyard/chat/appearance regressions. Provider tests use HTTP fixtures. This integration has not established a new real-provider success rate or production load capacity. Further experimental optimization and the unfinished fighting game are outside this snapshot.
