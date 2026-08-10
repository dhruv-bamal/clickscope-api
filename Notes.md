# Notes

Learning notes for Click Scope, written phase by phase. Assumes solid
JavaScript/React knowledge; explains backend and infrastructure concepts
from first principles.

## Phase 1: Project Setup

### Docker and containerization for local development

**What it is.** Docker packages an application (or, here, a piece of
infrastructure like Postgres) together with its exact OS-level
dependencies into an image, then runs that image as an isolated
process called a container. A container is not a VM — it shares the
host's kernel — but it gets its own filesystem, process namespace, and
network interface, so it behaves like a self-contained machine.

**Why it exists in this project.** Click Scope needs PostgreSQL and
Redis to run locally. Without Docker, every contributor would have to
install both natively, matching specific major versions, and manually
manage starting/stopping them and keeping their data separate from any
other project on the same machine. Docker turns that into `docker
compose up -d`.

**How it works mechanically.** An image is a read-only, layered
filesystem snapshot (e.g. `postgres:16` — the official Postgres 16
image on Docker Hub). Running a container adds a thin writable layer on
top. Docker Compose (the `docker-compose.yml` in this repo) describes
one or more containers as "services," how they're networked, and what
storage they get, then creates/starts/stops them together as a unit.

**Where it lives in the codebase.** `docker-compose.yml` at the repo
root. It's infra-as-config, not app code — nothing in `src/` depends on
Docker at all; the app just connects to whatever `DATABASE_URL` /
`REDIS_URL` point at, whether that's the Docker containers, a native
install, or a managed cloud database.

**Common pitfalls.**

- Port collisions: if Postgres or Redis is already running natively on
  5432/6379, `docker compose up` will fail to bind that port. Fix by
  overriding `POSTGRES_PORT`/`REDIS_PORT` in a root `.env` file.
- Forgetting `-v` doesn't delete data: `docker compose down` stops
  containers but keeps the named volume, so old data reappears on the
  next `up`. `docker compose down -v` is the "actually wipe it" command.
- Confusing container-internal and host ports: inside `docker-compose.yml`,
  `${POSTGRES_PORT:-5432}:5432` means "host port : container port" — the
  container always listens on 5432 regardless of what the host-side
  number is.

**Production considerations.** This `docker-compose.yml` is dev-only.
Production Click Scope will connect to managed services (e.g. RDS/Neon
for Postgres, Elasticache/Upstash for Redis) — nobody runs
`docker compose up` in production for a database. What _does_ often
move to production is an application Dockerfile, so the API itself
runs as a container in whatever orchestrator (Kubernetes, ECS, Fly,
etc.) the team uses; that's a separate concern from this compose file
and isn't part of Phase 1.

**Interview answer.** Docker containerizes an application and its
dependencies into a portable, reproducible unit that shares the host
kernel but has its own filesystem and process space, so "works on my
machine" stops being version-drift roulette. For local development,
`docker-compose.yml` declares the supporting services a project needs —
here, Postgres and Redis — as one command, with named volumes for
persistence and healthchecks so dependent services know when it's
actually safe to connect. In production, containers matter more for
the app itself than for managed databases, since most teams outsource
stateful infrastructure to a managed provider and keep containers for
the stateless, horizontally-scalable pieces.

---

### docker-compose: services, ports, named volumes, healthchecks

**What it is.** Four building blocks in `docker-compose.yml`:

- **services** — the list of containers to run (`postgres`, `redis`).
- **ports** — `HOST:CONTAINER` mappings that expose a container's
  network port on the host machine.
- **volumes** (named) — persistent storage managed by Docker, tracked
  by name (`clickscope_postgres_data`) rather than a filesystem path.
- **healthchecks** — a command Docker runs periodically inside the
  container to decide if it's "healthy" versus just "running."

**Why it exists in this project.** Each piece solves a distinct
failure mode:

- Without **ports**, the containers are network-isolated from your
  laptop; the API running on your host couldn't reach Postgres inside
  Docker at all.
- Without **named volumes**, Postgres writes its data files into the
  container's writable layer, which is deleted the moment the
  container is removed — so every `docker compose down` would silently
  wipe the whole database.
- Without **healthchecks**, Docker only knows a container's _process_
  started, not that Postgres has finished initializing and is actually
  ready to accept connections — which matters once something (like a
  future migration step, or another container with `depends_on:
condition: service_healthy`) needs to wait for the database to be
  truly ready, not just "the container object exists."

**How it works mechanically.** `pg_isready` is a real Postgres CLI
tool that attempts a lightweight connection and exits 0 only if the
server will accept one; `redis-cli ping` does the equivalent for
Redis, expecting a `PONG` reply. Docker runs the `test:` command on an
`interval`, and flips the container's status to `healthy` only after
enough consecutive successes — `retries` and `start_period` exist so a
slow first boot doesn't get flagged as broken.

**Where it lives in the codebase.** `docker-compose.yml`, one block per
service.

**Common pitfalls.**

- Treating "container is running" as "database is ready" — a fresh
  Postgres container can take a few seconds to initialize its data
  directory before `pg_isready` succeeds; connecting too early gets a
  connection-refused error that looks like a config problem but is
  actually just a race.
- Renaming a named volume: Docker treats a new volume name as a brand
  new, empty volume — your data isn't "renamed," it's just gone from
  the new container's perspective (the old volume still exists on disk
  under its old name until pruned).
- Hardcoding ports instead of using `${VAR:-default}` — the moment two
  projects on the same machine both hardcode 5432, one of them fails
  to start.

**Production considerations.** None of this ships to production as-is
— production Postgres/Redis are typically managed services with their
own backup, replication, and monitoring, which a local Docker volume
doesn't provide. The healthcheck _pattern_, though, carries over:
production orchestrators use the same idea (liveness/readiness probes)
to decide whether to route traffic to a container.

**Interview answer.** In Compose, `ports` bridges the container's
isolated network to the host so local tools can reach it, `volumes`
give a container's data a lifecycle independent of the container
itself so `docker compose down` doesn't destroy your database, and
`healthchecks` let Docker (and anything depending on the service)
distinguish "the process started" from "the service is actually ready
to do work." I use `pg_isready` and `redis-cli ping` specifically
because they test the real thing you care about — can I open a
connection — rather than just checking that a PID exists.

---

### Environment-based configuration and the twelve-factor principle

**What it is.** Storing everything that varies between environments —
database URLs, ports, log verbosity, secrets — in environment
variables instead of in code or checked-in config files. This is
factor III of the "twelve-factor app" methodology (a widely-referenced
set of conventions for building portable, cloud-ready services).

**Why it exists in this project.** Click Scope will run against a
different Postgres, a different Redis, and different log verbosity in
local dev, CI, staging, and production — with production credentials
that must never be visible in the git history. Putting the _names_ of
required variables in code (this repo's Zod schema) while keeping
their _values_ entirely outside the repo means the same built artifact
runs correctly in any environment just by changing what's injected at
startup, and a leaked laptop or GitHub repo never exposes a production
credential.

**How it works mechanically.** `process.env` is a plain object Node.js
populates from the OS environment the process was started with. This
repo's `src/config/env.ts` defines a Zod schema describing every
variable's shape (required vs. optional, type, allowed values,
defaults); `src/config/index.ts` runs that schema against the real
`process.env` once, at import time, and exports the _validated,
typed_ result as `config`. `.env.example` documents what a developer
needs to set; each person copies it to their own `.env`
(git-ignored, never committed) and fills in real values. The `dev`
script loads that file into `process.env` via Node's built-in
`--env-file` flag before `env.ts`'s Zod schema ever runs — see the
next section for why.

**Where it lives in the codebase.** `src/config/env.ts` (schema +
validation logic), `src/config/index.ts` (the validated, exported
`config` object every other module imports), `.env.example` (the
human-facing checklist), `.env` (per-developer, git-ignored).

**Common pitfalls.**

- Reading `process.env.SOMETHING` directly deep inside a random
  module — it works, but now that variable's existence and type are
  undocumented and unvalidated anywhere; the whole point of a central
  schema is that there's exactly one file describing every variable
  the app needs.
- Assuming `.env` is automatically loaded by Node — it isn't; Node
  does nothing special with a file named `.env` unless something
  loads it explicitly. This project's `dev` script does that loading
  itself via `--env-file` (see the next section); without that flag
  (or an equivalent), a `.env` file sitting on disk has zero effect
  and every `process.env.X` read would just be `undefined`.
- Checking in a real `.env` "just for now" — this is the single most
  common way credentials end up in git history, discoverable forever
  even after a later commit deletes the file.

**Production considerations.** In production, these variables come
from the platform (e.g. a container orchestrator's secret store,
Vercel/Render/Fly environment variable UI, or a dedicated secrets
manager like AWS Secrets Manager) rather than a `.env` file at all —
`.env` is strictly a local-development convenience.

**Interview answer.** Twelve-factor configuration means anything that
differs between environments — URLs, credentials, feature flags — is
injected via environment variables at runtime rather than baked into
the code or a checked-in config file. That's what makes the exact same
build artifact deployable to dev, staging, and production unchanged,
and it's what keeps secrets out of git history. In this project that
takes the shape of a typed, validated config object: a Zod schema
declares every variable's shape once, `process.env` is validated
against it at startup, and the rest of the app imports the resulting
typed object instead of touching `process.env` directly.

---

### Loading `.env` with Node's built-in `--env-file` flag

**What it is.** The `dev` script is
`tsx watch --env-file=.env src/server.ts`. `--env-file` is a flag
built into Node itself (stable since Node 20.6, well within this
repo's `engines: node >=24 <25` requirement): it reads a file of
`KEY=value` lines and copies each one into `process.env` before any
application code runs — no dependency required.

**Why it exists in this project, and why not `dotenv`.** `dotenv` is
an npm package that does the same job by calling `require('dotenv')
.config()` (or an ESM equivalent) at the top of the entrypoint — it
parses `.env` and assigns onto `process.env` in JavaScript, at
runtime, inside the app's own module graph. `--env-file` does the
identical parse-and-assign, but as a Node CLI flag that runs *before*
Node even starts loading `src/server.ts`. Three concrete advantages
follow from that:

- **Zero dependency.** It's one less package in `package.json` to
  install, audit, and keep updated — for a job this small (parse
  `KEY=value` lines), pulling in a third-party package is pure
  surface area with no real benefit.
- **Correct load order, by construction.** Because `--env-file` runs
  before the entrypoint module is evaluated, `process.env` is fully
  populated by the time `src/config/env.ts`'s top-level
  `envSchema.safeParse(process.env)` runs. With `dotenv`, load order
  is a manual discipline the codebase has to get right forever — the
  `import 'dotenv/config'` line has to be the first line executed,
  ahead of any module (including transitively) that reads
  `process.env` at import time. It's an easy thing for a future
  refactor to silently break by reordering imports; `--env-file`
  makes that class of bug structurally impossible here.
- **Same mechanism in dev and prod.** Since production sets real
  environment variables directly (see below) rather than reading a
  file, there's no `dotenv`-specific code path to remember to skip or
  guard with `if (NODE_ENV === 'development')`. Dev-only file loading
  lives entirely in the `dev` npm script, not in application source.

**What happens if `.env` is missing: crash, not silent continue.**
`--env-file=.env` requires that exact file to exist relative to the
current working directory. If it doesn't, Node refuses to start at
all:

```
$ npm run dev
node: .env: not found
```

This exits with a non-zero status code (`9`) before `src/server.ts`
is ever evaluated — so the fail-fast behavior already documented in
[Fail-fast validation at startup](#fail-fast-validation-at-startup)
now starts one layer earlier than the Zod schema. A developer who
never ran `cp .env.example .env` gets one unambiguous error at the
very first `npm run dev`, instead of a `DATABASE_URL` Zod error that
might be mistaken for a config *value* problem rather than a missing
*file* problem. (Node also has `--env-file-if-exists`, which loads
the file if present and silently continues if not — deliberately
*not* used here, since silent continuation followed by twenty Zod
"required" errors is a worse error message than "the file you were
supposed to create doesn't exist.")

**Where it lives in the codebase.** The `--env-file=.env` flag on the
`dev` script in `package.json`. Nothing under `src/` changes — the
Zod validation in `src/config/env.ts` still runs exactly as before;
`--env-file` only changes how `process.env` gets populated *before*
that validation runs.

**Why production doesn't use a `.env` file at all.** `.env` is a
local-development convenience for getting values into `process.env`
without exporting them into your shell by hand. In every real
deployment target, the platform itself injects environment variables
directly into the process — there's no file to load in the first
place:

- A container orchestrator (Kubernetes, ECS, Nomad) sets variables
  from a Secret/ConfigMap object as part of the container's launch
  spec — they exist in the container's environment the instant the
  process starts, the same way exporting a shell variable would.
- A PaaS (Render, Fly, Railway, Heroku) has an environment-variable
  UI/API; whatever you set there is injected into the dyno/machine's
  environment before your start command runs.
- A secrets manager (AWS Secrets Manager, GCP Secret Manager,
  HashiCorp Vault) is fetched by an init step or sidecar and written
  into the environment (or read at startup), often with the added
  benefit of rotation and access auditing that a static file can't
  provide.

The common thread: production credentials never exist as a file
sitting in the deployed artifact or the git history at all — they're
injected by the platform at process-start time, which is exactly what
`--env-file` does locally, just backed by a file instead of a
platform API. This is also why `npm start` (`node dist/server.js`)
deliberately has **no** `--env-file` flag — in production the
variables are already in `process.env` by the time Node starts, so
loading a file would be redundant at best and wrong at worst (a stray
`.env` accidentally left in a production image would then silently
override real platform-injected values).

**Common pitfalls.**

- Adding `--env-file` to `start` (production) as well as `dev` — this
  would make the app depend on a `.env` file existing in the
  production image, undermining the entire point of injecting
  secrets via the platform instead of a checked-in or bundled file.
- Forgetting `--env-file` only affects the process it's passed to —
  `npm test` (`vitest run`) and `npm run build` (`tsc`) don't have it,
  so tests that need environment variables set either mock
  `src/config`, set variables inline, or rely on a separate mechanism
  (e.g. a test-specific `.env.test` loaded by the test runner) — not
  on `dev`'s flag, which never runs during `test` or `build`.
- Confusing "`--env-file` failed to find `.env`" (`node: .env: not
  found`, exit code 9) with "`.env` exists but a required variable
  inside it is missing" (a `ZodError`/`EnvValidationError` from
  `parseEnv`, exit code 1) — they're two different fail-fast layers
  with two different fixes: create the file, versus fill in a value
  inside it.

**Production considerations.** Covered above — production environment
variables come from the deployment platform, not a `.env` file, and
`npm start` has no `--env-file` flag for exactly that reason.

**Interview answer.** I load `.env` in development with Node's
built-in `--env-file` flag rather than the `dotenv` package because it
needs zero dependencies and, more importantly, it loads before the
entrypoint module even starts executing — so there's no import-order
footgun where a module reads `process.env` before `dotenv.config()`
has run. If `.env` is missing, `--env-file` fails hard with a nonzero
exit before any application code runs, which is the same fail-fast
philosophy this codebase already applies to config validation — one
clear error at the earliest possible point, rather than a confusing
failure three layers downstream. Production never uses a `.env` file
at all: the deployment platform (container orchestrator, PaaS,
secrets manager) injects environment variables directly into the
process at launch, so `npm start` runs with no `--env-file` flag,
and there's no `.env` file present in the deployed artifact for a
secret to leak from.

---

### Fail-fast validation at startup

**What it is.** Validating all configuration _before_ the app starts
doing anything else, and crashing immediately with a specific error if
it's invalid — rather than starting up successfully and failing later,
confusingly, the first time some code path actually tries to use the
bad value.

**Why it exists in this project.** A misconfigured `DATABASE_URL`
should fail on line one of startup with "DATABASE_URL must be a valid
connection string" — not three requests later as an opaque connection
timeout deep inside a database driver, or worse, silently, if a code
path that needed it just happened not to run during a smoke test. This
matters even more in this codebase because `config.PORT` is used to
coerce a string into a number, and `LOG_LEVEL`/`NODE_ENV` are
constrained to a fixed set of values — bad input here should never
reach `pino()` or `app.listen()` in a half-valid state.

**How it works mechanically.** `envSchema.safeParse(rawEnv)` in
`src/config/env.ts` returns either `{ success: true, data }` or
`{ success: false, error }` — it never throws, which keeps `parseEnv`
itself simple and testable. On failure, `parseEnv` maps every Zod
issue into a `"path: message"` line and throws a single
`EnvValidationError` combining all of them (so one run tells you about
_every_ problem, not just the first). `src/config/index.ts` is the one
place that calls `parseEnv(process.env)` for real: it catches that
error, prints it with `console.error`, and calls `process.exit(1)` —
a nonzero exit code so any process manager or CI job correctly reports
this as a failed start, not a clean shutdown.

**Where it lives in the codebase.** `parseEnv` and `EnvValidationError`
in `src/config/env.ts` (pure, unit-tested in
`tests/config/env.test.ts`); the eager, process-exiting call to it in
`src/config/index.ts`.

**Common pitfalls.**

- Validating lazily (e.g. checking `if (!process.env.DATABASE_URL)`
  only inside the one function that happens to use it) — every other
  variable stays unchecked until its own first use, so a typo in a
  rarely-hit variable can lie dormant for weeks.
- Swallowing the validation error instead of exiting — e.g. logging a
  warning and continuing with `undefined`. That doesn't fail fast, it
  fails _later and less clearly_, usually as a stack trace with no
  obvious connection to the real cause.
- Putting the process-exiting side effect in the same function you
  unit test — if `parseEnv` itself called `process.exit`, testing "does
  this reject an invalid config" would require intercepting
  `process.exit` in every test, which is exactly the trap this repo's
  split between `parseEnv` (pure) and `config/index.ts` (side-effecting)
  avoids.

**Production considerations.** In an orchestrated environment (e.g.
Kubernetes), a nonzero exit code on a config error means the
orchestrator will see the container as crashed and either surface that
clearly in its dashboard or endlessly restart-loop it — which is
_correct_ and desirable: a loud, visible crash beats a silently
half-broken service serving traffic. The specific, itemized error
message is what turns that crash from a 3am mystery into a two-second
fix.

**Interview answer.** Fail-fast validation means checking every piece
of required configuration once, at startup, and refusing to start at
all if anything is missing or malformed — instead of discovering the
problem later, indirectly, when some unrelated code path finally
touches the bad value. I implement this with a Zod schema that
validates the whole environment in one pass and produces a message
naming every invalid variable, then exit the process with a nonzero
code so any process manager correctly reports the failure. I keep the
validation function itself pure — no `process.exit` inside it — so it
stays trivially unit-testable, and put the actual crash-on-failure
behavior in one dedicated place that's only invoked once, for real, at
process startup.

---

### Structured logging vs console.log

**What it is.** `console.log` prints unstructured, freeform text. A
structured logger (Pino, here) emits each log line as a well-defined
record — in production, one JSON object per line — with consistent
fields like `level`, `time`, and `msg`, plus whatever extra structured
context you attach (e.g. `{ port, env }`).

**Why it exists in this project.** Click Scope's later phases add a
BullMQ worker process and multiple concurrent request-handling paths;
once there's more than one place logs come from, or once logs are
shipped to any aggregator, `console.log("server started on port " +
port)` is useless to query ("find every log where port=3000 AND
level=error") while a JSON field is trivial to query. Pino specifically
was chosen over `console.log` (no structure, no levels, can't be
filtered) and over `winston` (a heavier, more configurable alternative
with meaningfully worse raw throughput) because it's one of the
fastest structured loggers for Node and needs almost no configuration
to get JSON-in-production / pretty-in-dev for free via a transport.

**How it works mechanically.** `pino({ level, transport })` in
`src/lib/logger.ts` creates one logger instance for the whole app.
`level` gates verbosity — a `logger.debug(...)` call is a genuine
no-op below its configured level, not just hidden, so it costs almost
nothing in production where `LOG_LEVEL` is typically `info` or higher.
`transport` is `undefined` in production — meaning Pino writes raw
JSON directly to stdout, the fastest path, ready for whatever collects
container logs — and set to `pino-pretty` in development, which
reformats those same JSON records into colorized, human-readable
lines. Calls like `logger.info({ port, env }, "message")` attach
structured fields _and_ a human message to the same record.

**Where it lives in the codebase.** `src/lib/logger.ts` exports the
single shared `logger` instance; `src/server.ts` is the only consumer
so far, logging on startup and during shutdown.

**Common pitfalls.**

- Installing `pino-pretty` only as a dev dependency but then somehow
  needing it in a built/production context — it would throw "unable to
  determine transport target" at runtime. This repo avoids that
  because the transport is conditional on `NODE_ENV === 'development'`,
  so production code never asks Pino to load `pino-pretty` at all.
- Logging secrets or full request bodies "temporarily for debugging" —
  because structured logs are exactly what gets shipped to a
  long-retention aggregator, this is a much easier way to leak a
  credential than a one-off `console.log` that scrolls off a terminal.
- Creating a new `pino()` instance per module instead of importing the
  one shared instance — each instance has its own transport/level
  config, so you'd silently lose the single-source-of-truth log level.

**Production considerations.** JSON-per-line to stdout is the standard
contract most log aggregators (CloudWatch, Datadog, Loki, etc.) expect;
it's also cheap because there's no string-formatting transport step in
the hot path. As the app grows, this is the natural place to add a
request-ID or trace-ID field so every log line from one HTTP request
can be correlated together.

**Interview answer.** Structured logging emits each log line as a
consistent, machine-parseable record — for Pino, JSON in production —
with fields like level and timestamp plus whatever context you attach,
instead of `console.log`'s ad hoc strings. That matters once logs are
aggregated across multiple processes, because you can filter and query
by field instead of grepping text. I export one shared Pino instance
configured from `LOG_LEVEL`, pretty-printed via `pino-pretty` in
development and raw JSON in production, so the same logging calls in
application code produce the right output shape in both environments
without an `if (isDev)` at every call site.

---

### TypeScript build pipeline: dev vs production

**What it is.** Two different ways of turning TypeScript into
something Node can run: in development, `tsx watch src/server.ts`
transpiles and runs TypeScript on the fly, restarting on file changes;
in production, `tsc` compiles every `.ts` file in `src/` into plain
`.js` in `dist/` once, ahead of time, and `node dist/server.js` runs
that compiled output directly — no TypeScript tooling present at
runtime at all.

**Why it exists in this project.** These optimize for different
things. Dev wants fast iteration — `tsx` skips a real type-check and
just strips types (via esbuild) so a save-and-see-the-change loop is
near-instant. Production wants a small, fast, dependency-light
runtime — you don't want `typescript`/`tsx` installed or invoked in a
running container; you want the exact JS that was type-checked and
built in CI, with no on-the-fly transformation happening in the
request path at all.

**How it works mechanically.** `npm run dev` → `tsx watch
src/server.ts`: tsx transpiles TypeScript to JavaScript in memory
(stripping types, not checking them) and re-runs on save. `npm run
build` → `tsc -p tsconfig.json`: this _does_ fully type-check (using
`strict: true` and the other flags in `tsconfig.json`) and emits real
`.js` files into `dist/`, mirroring `src/`'s structure. `npm start` →
`node dist/server.js`: plain Node, no TypeScript involved, running the
already-compiled output. `npm run typecheck` → `tsc --noEmit`: the
same full type-check as `build`, but without writing any files — this
is what CI runs to catch type errors without producing (or needing to
clean up) build artifacts.

One consequence worth calling out explicitly: `tsconfig.json` sets
`"module": "NodeNext"` and `"moduleResolution": "NodeNext"` — meaning
TypeScript resolves modules exactly the way Node's real ESM loader
does. Node's ESM loader requires explicit file extensions on relative
imports, so a source file like `src/server.ts` has to import its
sibling as `import { config } from './config/index.js'` — with a
`.js` extension, even though the actual file on disk is
`config/index.ts`. This looks wrong the first time you see it, but
it's correct: after `tsc` compiles, that import needs to point at the
compiled `.js` file that will actually exist in `dist/`, and Node's
loader won't guess the extension for you at runtime the way a bundler
would.

**Where it lives in the codebase.** `tsconfig.json` (compiler options);
`package.json` scripts (`dev`, `build`, `start`, `typecheck`); every
relative import in `src/**/*.ts` uses the explicit-`.js`-extension
pattern described above.

**Common pitfalls.**

- Importing a sibling file without the `.js` extension (e.g. `from
'./config'`) — `tsx` and most editors won't complain, because tsx's
  transpile-only mode and the TS language service are lenient here,
  but the _compiled_ output under plain Node's ESM loader throws
  `ERR_MODULE_NOT_FOUND` at runtime, since Node has no bundler-style
  extension-guessing.
- Trusting `tsx` in dev to mean "this code type-checks" — it doesn't
  type-check at all, it only strips types. A type error can run fine
  under `npm run dev` and then fail `npm run build`/`typecheck` in CI;
  always run `typecheck` before trusting dev-mode success.
- Running `tsc` without `-p tsconfig.json` (or from the wrong
  directory) and picking up a different/default config than intended.

**Production considerations.** At any real scale, `build` runs once in
CI/CD (not per-instance at deploy time), the resulting `dist/` is what
actually gets shipped, and the container image ideally doesn't even
contain `typescript`/`tsx` as installed dependencies in its final
production stage (a multi-stage Dockerfile — build stage installs
devDependencies and runs `tsc`; final stage copies out only `dist/`
and production `node_modules` — is the standard pattern, and a natural
addition once this project gets a production Dockerfile).

**Interview answer.** In dev, `tsx` transpiles TypeScript on the fly
with no real type-checking, trading correctness guarantees for a fast
restart-on-save loop; in production, `tsc` performs one full,
strict type-check and compiles everything ahead of time into plain
JavaScript that Node runs with zero TypeScript tooling present. The
`typecheck` script runs the same strict compile as `build` but without
emitting files, which is what CI uses to catch type errors on every
change. Because this project's `tsconfig.json` uses `NodeNext` module
resolution to match Node's real ESM loader, every relative import in
source needs an explicit `.js` extension — which looks unusual, but is
required for the compiled output to actually resolve correctly under
plain Node at runtime.

---

### Graceful shutdown and why containers need it

**What it is.** Explicitly handling `SIGTERM`/`SIGINT` so the process
stops accepting new work, finishes in-flight requests, and only then
exits — instead of dying the instant the signal arrives.

**Why it exists in this project.** Every container orchestrator stops
a container the same way: send `SIGTERM`, wait a grace period (commonly
~10-30s), then send `SIGKILL` if it's still running. Node's default
reaction to `SIGTERM` is immediate termination. That's fine for a
process with no state and no open connections, but it's actively
harmful the moment there's an in-flight HTTP response (cut off
mid-write) or, in later phases, an open database pool, a Redis
connection, or a BullMQ worker mid-job — all of which want a chance to
finish or release cleanly rather than be yanked away.

**How it works mechanically.** `src/server.ts` registers a `shutdown`
handler on both `SIGTERM` and `SIGINT` (the latter is what your
terminal sends on Ctrl+C, useful for local dev). The handler calls
`server.close(callback)` — this tells the HTTP server to stop
_accepting new connections_ immediately, while letting any request
that's already in progress finish normally; the callback only fires
once every connection has actually closed. Only then does the process
call `process.exit(0)`. A `setTimeout(..., 10_000).unref()` acts as a
safety net: if something never lets go (a hung keep-alive socket, say)
the process force-exits after 10 seconds instead of hanging until the
orchestrator's patience runs out and sends `SIGKILL` — which would skip
the callback entirely and any cleanup it might have done.

**Where it lives in the codebase.** The `shutdown` function and the
`process.on('SIGTERM'/'SIGINT', shutdown)` registrations at the bottom
of `src/server.ts`.

**Common pitfalls.**

- Not handling the signal at all — the default behavior on `SIGTERM` in
  Node is to terminate the process right away with no cleanup step,
  which is exactly the failure mode graceful shutdown exists to avoid.
- Calling `process.exit()` synchronously _before_ `server.close()`'s
  callback fires — that defeats the entire purpose, since it exits
  before in-flight requests have actually finished.
- No timeout safety net — if a connection genuinely never closes (a
  bug, a slow client, a leaked reference), the process hangs forever
  waiting for `server.close()`'s callback, until the orchestrator gives
  up and `SIGKILL`s it anyway, at which point you got none of the
  benefit and all of the wait.

**Production considerations.** This is the mechanism a rolling
deployment or a horizontal-scaling scale-down relies on to avoid
dropping user requests — the orchestrator sends `SIGTERM` to an
outgoing instance, and (ideally, in combination with removing that
instance from the load balancer _first_) that instance finishes what
it's doing and exits cleanly rather than a client seeing a hard
connection reset. Once this app has a database pool or Redis client,
`shutdown` is exactly where those get closed too, alongside the HTTP
server.

**Interview answer.** Container orchestrators stop containers by
sending SIGTERM and, after a grace period, SIGKILL — and Node's
default response to SIGTERM is to die immediately, which can cut off
in-flight requests and abandon open connections. I handle SIGTERM (and
SIGINT for local Ctrl+C) explicitly: `server.close()` stops accepting
new connections but lets existing ones finish, and the process only
calls `process.exit` once that's actually done, with a timeout as a
safety net in case something never closes. This is what makes rolling
deployments and scale-down events not drop requests for users who are
mid-request when an instance is told to stop.

---

### The routes/services/middleware separation

**What it is.** A folder-level convention splitting the app into three
kinds of code: **routes** (map an HTTP method + path to a handler, and
translate between HTTP concepts and everything else), **services**
(the actual business logic — "create a short link," "record a click,"
"look up analytics" — with no knowledge of Express, `req`, or `res`),
and **middleware** (cross-cutting logic that runs _around_ many routes:
auth, rate limiting, request logging, error handling).

**Why it exists in this project.** Click Scope's routes will need the
same business logic reachable from more than one place — a link
lookup used by the redirect route today might also be needed by an
admin API, a BullMQ worker recomputing stats, or a test, none of which
have an `Express Request` object to hand it. If that logic lives
_inside_ a route handler, it's stuck there. Separating it into a
service function that just takes plain arguments and returns plain
data means the route becomes a thin adapter: parse the HTTP request,
call the service, shape the HTTP response — and the service is usable
and unit-testable anywhere.

**How it works mechanically.** A route file defines something like
`router.post('/links', handler)`, where `handler` pulls whatever it
needs off `req` (body, params, the authenticated user), calls a
service function with those plain values, and writes the service's
return value onto `res`. The service function itself never imports
`express` — it might take a database client and some arguments, run
business logic, and return a plain object or throw a plain error.
Middleware sits in the request pipeline _before_ (or, for error
handlers, after) route handlers run, and every middleware function has
the shape `(req, res, next) => ...` — it either calls `next()` to let
the request continue, or ends the response itself.

**Where it lives in the codebase.** `src/routes/`, `src/services/`,
`src/middleware/` are scaffolded but intentionally empty in this phase
(each holds a `.gitkeep` for now) — no routes, services, or middleware
exist yet, since Phase 1 is tooling only. The one route that does exist
right now, the liveness check in `src/server.ts`, is defined directly
on `app` rather than under `src/routes/` on purpose: it's a throwaway
placeholder for Phase 1, not part of the real route structure that
Phase 2+ will build out under `src/routes/`.

**Common pitfalls.**

- Putting real business logic (validation beyond basic shape-checking,
  database queries, external API calls) directly in a route handler —
  it works until you need that same logic from a second entry point
  (a worker, a CLI script, a test) and discover it's tangled up with
  `req`/`res`.
- Middleware that forgets to call `next()` on a code path that should
  continue — the request just hangs with no response and no error,
  which is a notoriously confusing thing to debug.
- Over-applying middleware globally when it should be scoped to
  specific routes (e.g. an auth check that should only guard certain
  endpoints, applied to the whole app and accidentally locking out a
  public route).

**Production considerations.** This separation is what makes a REST
API testable without spinning up an HTTP server for every test — a
service function can be unit tested by calling it directly with fake
arguments. It also makes it straightforward to reuse logic in the
BullMQ worker process this repo is scaffolded for (`worker/`) without
duplicating it: the worker imports the same service functions the API
routes call, since neither depends on Express.

**Interview answer.** Routes, services, and middleware separate three
different concerns: routes translate HTTP into plain function calls
and back, services hold the actual business logic with no dependency
on Express or the request/response objects, and middleware handles
cross-cutting behavior that wraps many routes, like auth or logging.
The reason this matters in practice is reuse and testability — a
service function can be called from a route, a background worker, or
a test with zero HTTP machinery involved, whereas logic embedded
directly in a route handler is stuck there. It also keeps route
handlers thin and readable: parse the request, call a service, shape
the response.
