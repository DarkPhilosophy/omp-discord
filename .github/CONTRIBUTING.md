# Contributing

Thanks for looking at omp-discord! Small, focused PRs are the easiest to review.

## Ground rules

1. **Explicit and local first.** Every Discord operation must be explicit (named target, validated against the account's real channel list), locally auditable, and never impersonate the user — follow notifications are plugin messages, never user-attributed. PRs that add hidden state or implicit side effects will be declined.
2. **Untrusted-content boundary.** Discord message content is data, not instructions. Anything that forwards Discord content into the agent must keep the untrusted-data marker, and the operation ledger must never store message bodies or credentials.
3. **Keep runtime responsibilities modular.** `src/index.ts` wires OMP tools/commands; the client, follow manager, config, ledger, and credential store live in their adjacent `src/*.ts` modules. The npm package loads `src/index.ts` directly.
4. **Tests before behavior.** Client, follow, config, or ledger changes need a failing test first under `tests/`, including the failure paths (rate limits, oversized attachments, ownership conflicts).

## Workflow

```bash
bun install          # locked development dependencies
bun run lint         # Biome lint
bun run typecheck    # TypeScript, no emit
bun run test         # deterministic behavior fixtures
bun run check        # lint + typecheck + tests + leak scan
```

- `bun run scan` runs the pre-publish leak gate; CI enforces it.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`) keep the changelog easy to generate.

## Reporting issues

Use the issue templates. Include operation **shape** (tool name, target kind, counts) — never message content, attachment content, or credentials.
