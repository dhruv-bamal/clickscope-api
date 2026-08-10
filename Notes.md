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
