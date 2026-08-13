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

**Production considerations.** Phase 12 of this project is explicitly
reserved as a dedicated, measurement-driven indexing pass — once there are
real routes and real query patterns (and ideally `EXPLAIN ANALYZE` output
from production-like data volumes), that's when `clicked_at` and similar
columns get revisited, backed by evidence instead of speculation.

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
worker phase reuses this exact client rather than adding a second Redis
library to the dependency tree later.

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
