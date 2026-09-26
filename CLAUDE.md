# Claude Instructions

> Non-negotiable. Every session.

## North Star — the problem Neuron solves

Neuron is a life companion for people who want to live intentionally and build a life they absolutely love. The user is the main character of their own life, and Neuron is where they see, track and improve every part of it. Neuron helps you turn intentions into actions, actions into evidence, and evidence into better decisions. It aims to be the most important companion they have, and ideally the only one they need. This is the core of the app. Whatever solving that problem takes, we build.

Check every feature, schema change and UI decision against it:

- Does it help the user see their life more clearly, live it more intentionally, or improve it?
- Does it keep them the main character: in charge, never managed, never judged?
- Does it make showing up easier? Friction that adds no meaning is a defect.
- If implementation convenience conflicts with the user's experience, the user wins.

## Principles

- **Scan before code.** Read the closest golden file below before writing anything new. Mirror its naming, imports, and folder placement. No pre-existing pattern → flag it, don't assume.
- **Ambiguity halt.** Requirement unclear or conflicts with existing architecture → stop, ask one specific question. Don't guess.
- **No stubs.** No `// TODO`, placeholders, or partial features. Every delivered feature fetches, renders, errors, and empties end-to-end.
- **Multi-file features need a plan first.** Before writing code that touches >1 file, output: files to create/modify, golden file mirrored, new packages needed (if any — ask before adding), ambiguities. Wait for confirmation.
- **Ship complete.** All files in one response, fully wired — no "you'll need to connect this yourself."

### Golden files

| Layer               | File                                                    |
| ------------------- | ------------------------------------------------------- |
| DAL                 | `apps/backend/src/data-access-layer/EntitiesDAL.ts`     |
| Repository          | `apps/backend/src/repositories/EntitiesRepo.ts`         |
| Routes              | `apps/backend/src/routes/EntitiesRoutes.ts`             |
| Frontend data layer | `apps/web/src/routes/_authenticated/entities/-data.ts`  |
| Frontend page       | `apps/web/src/routes/_authenticated/entities/index.tsx` |

## Stack

Monorepo (pnpm workspaces): `apps/web` (TanStack Start, React 19, Cloudflare Workers) · `apps/backend` (Hono, Drizzle, D1) · `packages/schemas` (Zod schemas + types, source of truth for all types — never duplicate one in an app).

**Approved packages — don't introduce alternatives:** routing `@tanstack/react-router`+`react-start` · server state `@tanstack/react-query` · client state `zustand` · forms `@tanstack/react-form` (not react-hook-form) · validation `zod` v4 · UI `shadcn/ui` in `src/shadcn/ui/` + Tailwind v4 · icons `@phosphor-icons/react` · auth `@clerk/tanstack-react-start` (web) / `@clerk/backend` (worker) · HTTP `hono` v4 + `@hono/zod-validator` · ORM `drizzle-orm` + D1 · logging `@logtape/logtape` via `AppLogger` (never `console.log`) · errors Sentry · tests Vitest + RTL.

Before using any third-party API: check the installed version in `package.json`, read its file under `llm-context/`, and use context7 if still unclear. Never code against training-data memory of a library.

## New feature checklist

1. `packages/schemas/src/<feature>/` — `<Feature>Common.ts`, `ApiRequest.ts`, `ApiResponse.ts`, `DALRequest.ts`, `index.ts`; export from `packages/schemas/src/index.ts`. Add `LogCategory`/`LogAction` entries in `log.ts`. Status fields get the Status Enum Pattern (below).
2. `apps/backend/src/db/tables.ts` — add the table (see DB Tables below), then `pnpm --filter backend db:generate` immediately, commit the migration with the schema change.
3. `data-access-layer/<Feature>DAL.ts` → `repositories/<Feature>Repo.ts` → `routes/<Feature>Routes.ts`, mounted in `apps/backend/src/index.ts`.
4. `apps/web/src/routes/_authenticated/<feature>/` — `-data.ts`, `index.tsx`, `new/index.tsx` and `$id/index.tsx` if applicable, `-Component.tsx` co-located (prefixed `-`).

**Layers never skip or reverse:** Routes → Repo → DAL → DB.

## Conventions

- **Status Enum Pattern** (any discrete-state field): DB stores int only. Define `<Feature>StatusIntEnum`, `<Feature>StatusLabelEnum`, `<FEATURE>_STATUS_LABEL_MAP` in `<Feature>Common.ts`. DAL returns raw int; Repo maps int→label in a private `withStatusLabel`; API response always carries both `<feature>Status` (int) and `<feature>StatusLabel` (string).
- **Public ID Pattern** (every table): `id` (autoincrement int) is internal-only — joins/FKs, never sent to or accepted from a client. `publicId` (`Utility.generatePublicId()`, unique-indexed) is client-facing — every route param, API response, and frontend reference uses it instead. DAL generates it on insert and finds rows by it; API response types structurally omit `id` (`Omit<Entity, "id">`). See `EntitiesCommon.ts` / `EntitiesDAL.ts` / `EntitiesRoutes.ts`.
- **DB tables**: `sqliteTable` aliased `table`; camelCase in code, `snake_case` in DB; timestamps as `t.integer({ mode: "timestamp" })`; `createdAt` notNull + `updatedAt` nullable; index every FK; unique-index `publicId` and any other unique field.
- **DAL**: class holding `private db`, ctor takes `env`. Every method inits `{ isSuccess: false }`, try/catch, `AppLogger.error` with `LogCategory`/`LogAction` on failure.
- **Repo**: thin — maps API shapes to DAL params, business logic lives here, not in DAL.
- **Routes**: `checkAuth` first, then `zValidator`. `c.get("clerkUserId")` for the user. 201/200/404/500.
- **Frontend `-data.ts`**: `Queries` class with hierarchical keys (`keys.all()` invalidates every detail). `setQueryData` on update, `removeQueries` on delete, `mutateAsync` when the caller must await, `mutate` otherwise. Every mutation needs a non-empty `onError` (toast).
- **Frontend pages**: `useAuth()` at page level, explicit loading/error states, all requests through `apiClient`.
- **Routes needing user data** live under `_authenticated/` — always.
- **Styling**: Tailwind only, shadcn used as-is or via `className` (never edit `src/shadcn/ui/`), no CSS modules.

## Hard bans

- `console.log`, `any`, `@ts-ignore`/`as any` as a fix
- Types or Zod schemas defined outside `packages/schemas`
- Skipping a layer, or an authenticated route outside `_authenticated/`
- A client-supplied `id`, or an internal `id` in any response/param — `publicId` only
- Installing a package without asking, or one with a native browser API equivalent
- Disabling an ESLint rule inline without asking
- A schema change without immediately running `db:generate`
- A mutation with an absent or empty `onError`
- `npm`/`yarn` — `pnpm` always

## Commands

```bash
pnpm dev                          # run all apps
pnpm --filter web dev
pnpm --filter backend dev
pnpm --filter web test
pnpm --filter backend test
pnpm --filter backend db:generate # generate migration after schema change
pnpm --filter backend db:migrate  # apply migration (remote — apps/backend has no local variant yet)
```

---

> Scan. Verify. Plan. Implement completely. The repo is the source of truth over training memory.
