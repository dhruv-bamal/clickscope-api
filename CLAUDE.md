# Click Scope API

## What this is

URL shortening service with link analytics. Express + TypeScript REST API,
PostgreSQL, Redis, BullMQ worker. Consumed by a separate Next.js frontend.

## Architecture

- src/routes/ — Route handlers, thin; delegate to services
- src/services/ — Business logic
- src/middleware/ — Auth, validation, error handling, rate limiting
- src/db/ — Connection pool, queries
- src/lib/ — Shared utilities (logger, redis, errors)
- worker/ — BullMQ worker, separate process, separate deploy
- migrations/ — Versioned schema changes

## Commands

- npm run dev — API with hot reload
- npm run worker:dev — Worker with hot reload
- npm test — Unit + integration
- npm run migrate up — Apply migrations
- docker-compose up -d — Local Postgres + Redis

## Conventions (non-negotiable)

- ALL SQL parameterized. Never string-concatenate values into queries.
- Every user-data query scoped to the authenticated user IN THE QUERY,
  not in an if-statement.
- All input validated with Zod at the route boundary.
- Errors thrown as AppError; the error middleware formats responses.
- Structured logging via the Pino logger. No console.log.
- No secrets in code. Environment variables only, validated at startup.

## Teaching mode (non-negotiable)

I am building this to learn, not just to ship.

- Explain WHY before implementing — the concept, the alternatives, the tradeoff.
- Update Notes.md with a section per new concept: what it is, why it exists here,
  how it works mechanically, where it lives, common pitfalls, production
  considerations, and a 3-5 sentence interview answer.
- Never add a dependency silently. Name it, justify it, note the alternative.
- When I ask "why", give me the mechanism, not a restatement.

## Workflow

- Use plan mode for any change spanning multiple files.
- Implement only the current phase's scope. Don't build ahead.
- Don't modify existing working functionality unless the task requires it.
