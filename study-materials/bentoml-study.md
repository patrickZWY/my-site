# BentoML Codebase Study

This document studies how this repository designs, organizes, tests, and ships a
large Python serving framework. It is based on the local source tree, with
examples drawn from the code and some smaller abstracted examples that show the
same design ideas.

## Executive Summary

BentoML gets much of its engineering quality from a few repeated habits:

- It keeps the public API pleasant, but routes it through explicit internal
  contracts.
- It uses Python descriptors, decorators, and type hints to make user code feel
  native while still collecting runtime metadata.
- It separates declaration, import, build, serve, and request handling into
  distinct lifecycle phases.
- It treats artifacts as structured, versioned filesystem objects rather than
  incidental directories.
- It supports many ML frameworks through a narrow model-store contract instead
  of forcing every framework to share one fake abstraction.
- It centralizes configuration in typed objects and dependency-injection
  containers.
- It handles expensive optional dependencies with lazy imports and clear missing
  dependency errors.
- It makes serving behavior observable and bounded with readiness probes,
  metrics, request IDs, timeout middleware, concurrency middleware, and adaptive
  batching metrics.
- It tests critical product paths at several layers: small unit tests,
  framework integration tests, and end-to-end build/serve/client flows.
- It encodes security lessons as concrete checks, especially around pickle,
  URL fetching, uploaded filenames, and generated container files.

The important lesson is not "use decorators everywhere". The lesson is: expose
simple Python affordances to users, but immediately convert them into explicit
metadata, schemas, lifecycle hooks, and runtime objects that the rest of the
system can reason about.

## Repository Shape

The project is organized around product boundaries rather than only technical
layers:

- `src/bentoml/`: public package facade, legacy APIs, public management APIs,
  cloud APIs, server entry points, testing helpers, and compatibility modules.
- `src/_bentoml_sdk/`: the newer class-based SDK: `@service`, `@api`, `@task`,
  dependency descriptors, IO models, image declarations, and OpenAPI helpers.
- `src/_bentoml_impl/`: newer implementation pieces behind the SDK: server app
  factory, worker process entry point, clients, serialization, task results, and
  selected framework adapters.
- `src/bentoml/_internal/`: older and shared internals: Bento and model stores,
  build configuration, container generation, configuration containers, server
  base classes, monitoring, runners, IO descriptors, cloud schemas, and utility
  modules.
- `src/bentoml_cli/`: Click-based CLI commands for serving, building, model and
  Bento management, cloud, deployment, secrets, and containerization.
- `tests/unit/`: focused tests for stores, Bento metadata, IO descriptors,
  configuration, utilities, runners, cloud APIs, and SDK validators.
- `tests/e2e/`: service-level tests that build, serve, and call real example
  Bentos over HTTP or gRPC.
- `tests/integration/frameworks/`: framework adapter tests, split by ML
  framework so dependency-heavy work is isolated.
- `docs/`: Sphinx documentation with source snippets and generated reference
  material.
- `typings/`: project-owned stubs for optional or weakly typed dependencies.
- `noxfile.py`, `pyproject.toml`, `.github/workflows/`: test matrices, linting,
  typing, coverage, and CI orchestration.

The interesting structural choice is the split between `bentoml`,
`_bentoml_sdk`, and `_bentoml_impl`. The public package remains the stable user
surface. The SDK contains the declarative user-facing model. The implementation
package contains runtime mechanisms that should not leak into ordinary user
code.

Reusable structure:

```text
my_product/
  public_api/          # stable imports and compatibility
  sdk/                 # declarations users write
  implementation/      # runtime machinery
  internal/            # shared low-level primitives
  cli/                 # operational entry points
  tests/unit/
  tests/e2e/
  tests/integration/
```

This layout works well when a Python library is both an SDK and a runtime.

## Public API As A Thin Compatibility Layer

The top-level `src/bentoml/__init__.py` is deliberately not a giant eager import
file. It exposes many names, but most are resolved lazily.

The key patterns are:

- `MODULE_ATTRS` maps public attribute names to import targets.
- `TYPE_CHECKING` imports give type checkers a complete view without forcing
  runtime imports.
- `LazyLoader` defers expensive modules until first use.
- `FrameworkImporter` maps imports such as `bentoml.sklearn` to implementation
  modules under `_bentoml_impl.frameworks`.
- Deprecated framework modules still resolve, but warnings are attached at the
  boundary.

Simplified shape:

```python
MODULE_ATTRS = {
    "service": "_bentoml_sdk:service",
    "api": "_bentoml_sdk:api",
    "Bento": "._internal.bento:Bento",
}

def __getattr__(name: str) -> Any:
    if name in MODULE_ATTRS:
        module_name, attr_name = MODULE_ATTRS[name].split(":")
        module = import_module(module_name, __package__)
        return getattr(module, attr_name)
    raise AttributeError(name)
```

Best practices learned:

- Keep import-time behavior boring. A package with many optional ML dependencies
  should not import them at startup.
- Give type checkers the rich API through `TYPE_CHECKING` imports while keeping
  runtime imports lazy.
- Put deprecation warnings at the compatibility boundary, not deep in the new
  implementation.
- Make the public module a routing table. That makes API ownership visible.

## Services As Declarative Runtime Objects

The new SDK is centered on `src/_bentoml_sdk/service/factory.py`. A user writes a
plain Python class and decorates it with `@bentoml.service`. The decorator
returns a `Service` object that records:

- service name, labels, image, env vars, command, and config;
- API methods discovered from class attributes;
- model references discovered from class attributes;
- service dependencies discovered from descriptors;
- mounted ASGI and WSGI apps;
- import origin and working directory;
- request context and generated schema.

This gives users natural Python syntax while preserving a structured runtime
representation.

Source shape:

```python
@attrs.define
class Service(Generic[T]):
    name: str
    config: Config = attrs.field(factory=Config)
    inner: type[T] = _DummyService
    apis: dict[str, APIMethod[..., Any]] = attrs.field(factory=dict)
    dependencies: dict[str, Dependency[Any]] = attrs.field(init=False)

    def __attrs_post_init__(self) -> None:
        for field in dir(self.inner):
            value = getattr(self.inner, field)
            if isinstance(value, Dependency):
                self.dependencies[field] = value
            elif isinstance(value, APIMethod):
                self.apis[field] = value
```

The full implementation also handles task configuration, mounted apps, custom
commands, path prefixes, and legacy model references.

Abstracted example:

```python
def component(cls: type[T]) -> Component[T]:
    metadata = Component(name=cls.__name__, inner=cls)
    for name, value in vars(cls).items():
        if isinstance(value, Endpoint):
            metadata.endpoints[name] = value
        elif isinstance(value, Dependency):
            metadata.dependencies[name] = value
    return metadata
```

Best practices learned:

- Decorators should produce durable metadata objects, not only wrap functions.
- Scan a class once at declaration time, then use the resulting object
  everywhere else.
- Keep the original class available. The framework still instantiates user code
  normally, which keeps debugging and local calls understandable.
- Detect product-level side effects at declaration time. For example, a task API
  causes `external_queue` and single-concurrency defaults to be set.

## API Methods As Descriptors

`src/_bentoml_sdk/method.py` turns `@api` and `@task` methods into
`APIMethod` descriptors. This is one of the strongest Python patterns in the
repo.

An `APIMethod` records:

- the original function;
- route and public name;
- input and output IO descriptors derived from type hints;
- batching configuration;
- stream detection;
- optional context parameter detection;
- OpenAPI request and response schema generation.

Because it implements `__get__`, the same declared method can behave differently
when accessed on the class, local instance, or remote proxy.

Simplified pattern:

```python
class Method:
    def __init__(self, func: Callable[..., R]) -> None:
        self.func = func
        self.name = func.__name__

    def __get__(self, instance: object | None, owner: type) -> Any:
        if instance is None:
            return self
        local = self.bind_local(instance)
        if proxy := getattr(instance, "__self_proxy__", None):
            remote = getattr(proxy, self.name)
            remote.local = local
            return remote
        return local
```

The project uses this to give service methods three useful identities:

- local method calls for tests and in-process use;
- HTTP client calls through a proxy when served;
- metadata sources for schema and routing.

Best practices learned:

- Descriptors are a good fit when a method has both local and remote behavior.
- Preserve `.local` or an equivalent escape hatch so tests can bypass transport.
- Derive route and schema defaults from function signatures, but validate
  explicit overrides early.
- Do not let special methods become public APIs accidentally. BentoML rejects API
  method names starting with `__`.

## IO Models And Type-Driven Serialization

The newer IO path is in `src/_bentoml_sdk/io_models.py`,
`src/_bentoml_sdk/validators.py`, and `src/_bentoml_impl/serde.py`.

The design is:

1. Inspect a service method signature.
2. Build Pydantic models for inputs and outputs.
3. Attach validators and JSON schema hints for tensors, files, images, and data
   frames.
4. Use content-type-specific serializers to parse requests and render responses.
5. Use generated schema for clients and OpenAPI.

Examples of important behavior:

- Root string outputs become `text/plain`.
- File and image outputs become file or image responses.
- Generators become streaming responses.
- Multipart fields are detected from file-like annotations.
- Tensor and dataframe schemas encode enough metadata for JSON and Arrow paths.

Abstracted pattern:

```python
class IOMixin:
    @classmethod
    async def from_http_request(cls, request: Request, serde: Serde) -> Self:
        return await serde.parse_request(request, cls)

    @classmethod
    async def to_http_response(cls, obj: Any, serde: Serde) -> Response:
        if is_stream(obj):
            return StreamingResponse(...)
        payload = serde.serialize_model(cls(obj))
        return Response(payload.iter_bytes(), media_type=cls.mime_type())
```

Best practices learned:

- Convert Python type hints into runtime schemas once, then reuse them for
  parsing, clients, docs, and validation.
- Model file and tensor handling as schema metadata, not one-off request code.
- Keep serialization backends behind a small interface: `serialize_model`,
  `deserialize_model`, `serialize`, and `deserialize`.
- Treat streaming as an output shape at the method level so routing and OpenAPI
  can reflect it.

## Service Lifecycle And Runtime Boundaries

Serving is split across `src/_bentoml_impl/server/serving.py`,
`src/_bentoml_impl/worker/service.py`, `src/_bentoml_impl/server/app.py`, and
`src/bentoml/_internal/server/base_app.py`.

The lifecycle is roughly:

1. Load service from an import string, Bento, or working directory.
2. Inject service-specific config into `BentoMLContainer`.
3. Resolve models and deployment hooks before serving.
4. Build dependency service watchers if the service graph has local
   dependencies.
5. Allocate sockets for entry service and dependencies.
6. Start worker processes under a circus arbiter.
7. Each worker loads the service and creates a Starlette app.
8. The app lifespan instantiates user code, runs startup hooks, opens remote
   dependency clients, and sets current service context.
9. Each request is parsed, dispatched, serialized, instrumented, and cleaned up.
10. Shutdown hooks and dependency cleanup run through the lifespan stack.

The split is valuable because each file has a different job:

- `serving.py`: process graph and supervisor setup.
- `worker/service.py`: process entry point and uvicorn setup.
- `app.py`: ASGI app, routes, middleware, request dispatch, tasks, lifecycle.
- `base_app.py`: common health, readiness, metrics, timeout, concurrency.

Abstracted lifecycle:

```python
def serve(component: Component) -> Server:
    config = load_and_merge_config(component)
    graph = plan_processes(component, config)
    sockets = allocate_sockets(graph)
    supervisor = start_supervisor(graph, sockets)
    return Server(supervisor)

async def app_lifespan(app):
    instance = component()
    await run_startup_hooks(instance)
    try:
        yield
    finally:
        await run_shutdown_hooks(instance)
```

Best practices learned:

- Keep process supervision separate from request dispatch.
- Make lifecycle hooks part of the app lifespan rather than ad hoc globals.
- Keep health and readiness routes generic, then let services customize them
  through well-known hooks.
- Use an async exit stack for mounted apps and cleanup work.
- Push per-request cleanup into response background tasks so resources live long
  enough for streaming and response finalization.

## Dependency Graphs And Local/Remote Resolution

`src/_bentoml_sdk/service/dependency.py` defines `Dependency`, a descriptor used
by `bentoml.depends`.

A dependency can point to:

- another local `Service`;
- a deployed service name;
- a direct URL;
- a service plus URL, preserving types while resolving remotely.

The descriptor delays resolution until instance access. If the service is being
served and a runner mapping exists, it returns a remote proxy. If not, it
instantiates the dependency locally.

Simplified shape:

```python
class Dependency(Generic[T]):
    def __get__(self, instance: Any, owner: type) -> T:
        if instance is None:
            return self
        if self._resolved is None:
            self._resolved = self.resolve()
        return self._resolved

    def resolve(self) -> T:
        if self.url:
            return RemoteProxy(self.url, service=self.on).as_service()
        if self.on.name in runner_mapping:
            return RemoteProxy(runner_mapping[self.on.name], service=self.on).as_service()
        return self.on()
```

Best practices learned:

- The dependency declaration should not decide whether the dependency is local
  or remote. Runtime context should decide.
- Descriptors are useful for lazy dependency clients because class-level access
  remains metadata while instance-level access returns the usable object.
- Add one global cleanup path for resolved dependencies. BentoML tracks resolved
  dependencies and closes them on shutdown.
- Detect dependency name conflicts when flattening recursive service graphs.

## Adaptive Batching As A Separate Dispatcher

Dynamic batching lives in `src/bentoml/_internal/marshal/dispatcher.py`, not
inside API methods or framework adapters.

`CorkDispatcher` accepts individual requests, queues them, and releases batches
when the latency and batch-size model says it is worthwhile. It uses:

- an inbound job queue;
- futures for individual callers;
- a controller coroutine;
- a small optimizer trained from recent outbound durations;
- a semaphore to bound concurrent outbound calls;
- split logic for inputs that exceed remaining batch capacity.

The service app wires it in only for methods marked `batchable=True`.

Simplified shape:

```python
class Dispatcher:
    async def inbound_call(self, data):
        future = loop.create_future()
        queue.append(Job(data, future))
        wake_event.notify_all()
        return await future

    async def controller(self):
        while True:
            await wait_until_queue_has_items()
            if should_wait_for_more_items():
                await sleep(tick)
                continue
            batch = pop_batch()
            create_task(outbound_call(batch))
```

Best practices learned:

- Put batching behind a small callable wrapper. The API handler only needs to
  know whether a method is batchable.
- Return one future per caller even when the framework call is batched.
- Treat batching metrics as first-class observability. BentoML emits adaptive
  batch-size histograms labeled by service, method, worker, and Bento version.
- Keep batch splitting close to the dispatcher because only the dispatcher knows
  queue pressure and capacity.

## Artifact Stores And Versioned Metadata

The reusable store abstraction is in `src/bentoml/_internal/store.py`. It is
used by Bento and model stores.

The store layout is simple:

```text
store/
  item_name/
    version_a/
    version_b/
    latest
```

The `Store` class owns:

- listing all items or versions;
- resolving `latest`;
- exact and unambiguous prefix lookups;
- registering a new item through a context manager;
- rolling back incomplete registrations;
- updating `latest` after register and delete.

Key practice:

```python
@contextmanager
def register(self, tag):
    path.mkdir(parents=True)
    try:
        yield str(path)
    except Exception:
        shutil.rmtree(path)
        raise
    update_latest_file()
```

This pattern gives callers a safe place to write files without making every
caller implement partial-write cleanup.

Best practices learned:

- Use a context manager for artifact registration. Cleanup on failure belongs at
  the store boundary.
- Keep artifact identity in a small `Tag` type and validate it aggressively.
- Store metadata in explicit files such as `model.yaml` and `bento.yaml`.
- Make `latest` a convenience pointer, not a hidden database concept.
- Test the store directly. `tests/unit/_internal/test_store.py` covers exact
  lookup, prefix lookup, latest recreation, deletion, and missing-item errors.

## Bento Build Pipeline

Bento building is centered on `src/bentoml/_internal/bento/bento.py` and
`src/bentoml/_internal/bento/build_config.py`.

The pipeline is intentionally phased:

1. Parse and validate `BentoBuildConfig`.
2. Import the service from the build context.
3. Apply defaults and service-provided metadata.
4. Resolve and record models.
5. Copy included source files into the Bento `src/` directory.
6. Generate Python, Conda, and Docker environment assets.
7. Write README and OpenAPI/schema files.
8. Freeze image metadata when using the newer image system.
9. Write `bento.yaml`.
10. Validate and save through the store.

The build config classes are `attrs` objects with converters and validators:

- `DockerOptions` normalizes Python and CUDA versions, handles env values, and
  warns when a custom base image makes other options irrelevant.
- `CondaOptions` validates the dependency shape and writes an environment file.
- `PythonOptions` parses requirements, packs wheels, optionally locks packages,
  and can rewrite git dependencies into local wheel references.

Best practices learned:

- Build config should be typed and validated before any expensive side effects.
- Mutually exclusive options should warn or fail in one place.
- Defaults should be applied through `with_defaults()` rather than scattered
  across callers.
- Artifact generation should be deterministic enough to test exact metadata
  output.
- Preserve user context, but reject paths outside the build context unless there
  is an explicit supported mechanism.

## Framework Adapter Contract

Framework adapters live under both `_bentoml_impl.frameworks` and
`bentoml._internal.frameworks`. The newer adapters, such as
`src/_bentoml_impl/frameworks/sklearn.py` and
`src/_bentoml_impl/frameworks/mlflow.py`, show the common contract.

Each adapter tends to provide:

- dependency import and a helpful `MissingDependencyException`;
- `save_model` or `import_model`;
- `load_model`;
- a module name stored in model metadata;
- `ModelContext` with framework version information;
- default signatures;
- module compatibility checks before loading;
- optional legacy runnable support;
- sometimes a `get_service` helper for the new SDK.

Simplified adapter pattern:

```python
MODULE_NAME = "bentoml.some_framework"
MODEL_FILENAME = "saved_model.bin"

def save_model(name, model, signatures=None, labels=None, metadata=None):
    context = ModelContext(
        framework_name="some_framework",
        framework_versions={"some_framework": get_pkg_version("some_framework")},
    )
    with bentoml.models._create(
        name,
        module=MODULE_NAME,
        api_version="v1",
        signatures=signatures or {"predict": {"batchable": False}},
        labels=labels,
        metadata=metadata,
        context=context,
    ) as bento_model:
        write_framework_artifact(model, bento_model.path_of(MODEL_FILENAME))
        return bento_model

def load_model(model_ref):
    model = bentoml.models.get(model_ref)
    if model.info.module != MODULE_NAME:
        raise NotFound("wrong framework adapter")
    return read_framework_artifact(model.path_of(MODEL_FILENAME))
```

Best practices learned:

- Framework-specific behavior belongs in adapters, but metadata shape should be
  shared.
- Always record the adapter module that saved a model and reject mismatched
  loaders.
- Provide sensible default signatures but make them visible through logs.
- Avoid importing heavy frameworks from the top-level package.
- Keep legacy support as an adapter layer while steering new code toward
  service helpers.

## Configuration And Dependency Injection

`src/bentoml/_internal/configuration/containers.py` contains the central
configuration container. It uses `simple_di` providers for derived values such
as `bentoml_home`, store directories, stores, metrics clients, tracing providers,
cloud clients, and server options.

`BentoMLConfiguration` loads config in phases:

1. Start from a versioned default config.
2. Apply override defaults.
3. Apply config file overrides.
4. Apply JSON overrides.
5. Apply env-var style key-value overrides.
6. Run migration and finalization hooks.
7. Expand environment variables.
8. Validate against a schema.

This makes configuration observable and testable because all config paths flow
through one object.

Abstracted pattern:

```python
class Configuration:
    def __init__(self, defaults, file=None, env_values=None):
        self.config = load_defaults()
        deep_merge(self.config, defaults)
        if file:
            deep_merge(self.config, load_file(file))
        if env_values:
            deep_merge(self.config, parse_env_values(env_values))
        validate(self.config)
```

Best practices learned:

- Configuration should have a clear precedence order.
- Migration belongs in the config loader, not in random call sites.
- Derived resources, such as stores and clients, should be provider functions.
- Directory creation and validation should happen at provider boundaries.
- Service-level config can be injected into global runtime config during
  `Service.inject_config()`, making old and new subsystems interoperate.

## Clients, Proxies, And Serialization Boundaries

The newer client stack lives in `src/_bentoml_impl/client/` and
`src/_bentoml_impl/serde.py`.

Important design points:

- `HTTPClient` can talk to normal HTTP URLs, `tcp://` mappings, Unix domain
  sockets via `file://`, or an in-process ASGI app transport.
- Clients build request payloads from endpoint schemas, not hand-written method
  cases.
- `RemoteProxy` exposes a service-like object and chooses sync or async client
  calls based on the original service method.
- JSON, multipart, and pickle serializers implement a common `Serde` interface.
- The main public server rejects `application/vnd.bentoml+pickle`; pickle is
  reserved for internal service-to-service traffic.

Security-related examples:

- `ServiceAppFactory.api_endpoint()` rejects pickle content type on the main
  server with HTTP 415.
- `make_safe_connect()` blocks private, loopback, and link-local URL fetches for
  user-supplied file URLs.
- `FileSchema.decode()` uses `os.path.basename(filename)` before creating temp
  files, so uploaded filenames cannot create nested paths.
- Container generation quotes system package names and normalizes custom base
  image lines.

Best practices learned:

- Internal serialization formats can be dangerous. Gate them by trust boundary.
- A remote proxy should only call declared API methods, not arbitrary attributes.
- If the server fetches user-provided URLs, block private network targets.
- Treat filenames as labels, not paths.
- Add regression tests for security fixes, not only happy path behavior.

## Container Generation And Template Safety

Container generation is in `src/bentoml/_internal/container/generate.py` and the
Dockerfile templates under `src/bentoml/_internal/container/frontend/dockerfile`.

Good practices:

- Jinja runs in a sandboxed environment.
- Shell-sensitive values use `shlex.quote` through a `bash_quote` filter.
- Custom base image lines are normalized to a single line before template use.
- BuildKit cache mounts use locked sharing, tested in
  `tests/unit/_internal/container/test_generate.py`.
- Supported distro and CUDA choices are enumerated and validated.

The useful lesson is that generated infrastructure code is still code. It needs
input normalization, quoting, tests, and a narrow list of supported targets.

Abstracted example:

```python
def build_environment() -> SandboxedEnvironment:
    env = SandboxedEnvironment(...)
    env.filters["bash_quote"] = shlex.quote
    env.filters["normalize_line"] = lambda s: " ".join(s.strip().split())
    return env
```

Best practices learned:

- Do not concatenate user-provided package names into shell commands without
  quoting.
- Normalize single-line template fields before placing them in Dockerfile
  instructions.
- Keep the list of supported platforms explicit.
- Test the generated output for injection-shaped inputs.

## CLI As A Product API

The CLI is not a thin wrapper over random functions. `src/bentoml_cli/cli.py`
builds a Click command group and registers focused command modules.

Examples:

- `bentoml_cli/bentos.py`: list, get, delete, import, export, pull, push, build.
- `bentoml_cli/models.py`: local model store operations.
- `bentoml_cli/serve.py`: local and production serving commands.
- `bentoml_cli/containerize.py`: container build commands.
- `bentoml_cli/cloud.py`, `deployment.py`, `secret.py`, `api_token.py`: cloud
  workflows.

Good CLI practices in the repo:

- Validate tags and names in argument callbacks before commands mutate stores.
- Offer machine-readable outputs such as JSON and YAML as well as tables.
- Use `simple_di` injection for stores and clients rather than constructing them
  directly in every command.
- Keep command registration centralized so the available product surface is easy
  to scan.
- Load extension commands through entry points.

Abstracted CLI pattern:

```python
@group.command()
@click.argument("tag")
@click.option("--output", type=click.Choice(["json", "yaml", "table"]))
@inject
def get(tag: str, output: str, store: Store = Provide[Container.store]) -> None:
    item = store.get(tag)
    render(item, output)
```

Best practices learned:

- CLI commands are public APIs. Validate, structure, and test them accordingly.
- Give users both human-readable and automation-friendly output formats.
- Keep destructive commands explicit and confirm them unless an override flag is
  passed.

## Observability And Operational Controls

BentoML builds operational behavior into the server factories:

- `/livez`, `/healthz`, `/readyz`, and `/metrics` are system routes from
  `BaseAppFactory`.
- Readiness can include service-defined `__is_ready__` and dependency probes.
- Liveness can include service-defined `__is_alive__`.
- `TimeoutMiddleware` returns 504 when a request exceeds configured timeout.
- `MaxConcurrencyMiddleware` returns 429 before accepting excess work.
- OpenTelemetry middleware records trace context.
- Access log middleware can include request and response metadata.
- Response headers include service name and optional request/trace IDs.
- Adaptive batching emits method-level histograms.

Best practices learned:

- Operational endpoints should be default behavior, not copied into every
  service.
- Timeout and concurrency limits belong in middleware so business logic does not
  need to implement them.
- Readiness should be stricter than liveness and can include dependencies.
- Request IDs should propagate into response headers to connect clients with
  logs and traces.

## Testing Strategy

The test suite mirrors the product layers:

- Unit tests cover pure primitives and small contracts: stores, tags, config,
  IO validators, container generation, runner strategy, service loading, and
  model metadata.
- Framework integration tests exercise save/load behavior for many ML
  frameworks under isolated dependency sets.
- End-to-end tests build and serve real Bentos, then call them with sync and
  async clients.
- Monitoring tests exercise observability and log collection flows.
- CI runs unit tests across Linux, macOS, Windows, and Python 3.9, 3.11, and
  3.12. Nox also defines Python 3.10 sessions for local or targeted runs.
- Coverage artifacts are collected per job and combined in a separate coverage
  job.

Representative tests:

- `tests/unit/_internal/test_store.py` tests the store lifecycle directly.
- `tests/unit/_internal/bento/test_bento.py` checks exact Bento metadata YAML
  and export/import round trips.
- `tests/unit/_internal/container/test_generate.py` checks generated Dockerfile
  safety properties.
- `tests/unit/_bentoml_sdk/test_validators.py` covers uploaded filenames with
  path separators.
- `tests/e2e/bento_new_sdk/test_quickstart.py` verifies local prediction,
  build-and-serve, sync client, async client, and rejection of pickle on the
  public server.

Best practices learned:

- Test artifact metadata exactly. These files become compatibility contracts.
- Test low-level stores directly because many features depend on them.
- Split dependency-heavy framework tests from normal unit tests.
- End-to-end tests should cover the user journey: build, serve, call, and local
  direct invocation.
- Security regressions should become narrow tests with malicious-shaped inputs.

## Tooling And Quality Gates

The quality system is spread across `pyproject.toml`, `noxfile.py`, `Makefile`,
and `.github/workflows`.

Important choices:

- `ruff` handles linting and import sorting.
- `pyright` runs with strict settings over `src`, `examples`, `tests`, and
  `typings`.
- Coverage is branch-aware and configured in `pyproject.toml`.
- `nox` defines unit, framework integration, e2e, monitoring, and coverage
  sessions.
- `Makefile` gives contributors a small command surface for install, format,
  lint, type check, docs, and cleanup.
- CI separates code quality, unit, integration, e2e, monitoring, and coverage
  jobs.

Best practices learned:

- Put tool configuration in versioned project files, not only in CI scripts.
- Use Nox to make local and CI test commands share the same definitions.
- Split slow or dependency-heavy jobs so they fail independently and can be
  retried independently.
- Keep generated protobuf and docs paths out of normal lint/type loops where
  appropriate.
- Include local type stubs for dependencies whose runtime behavior matters but
  whose typing is incomplete.

## Compatibility And Migration

BentoML carries a large compatibility surface: legacy services and runners,
older framework modules, older Bento metadata, old gRPC versions, and new SDK
objects.

Patterns used:

- Top-level lazy imports warn when deprecated modules are accessed.
- `runner_service()` adapts a legacy `Runner` into a new-style service.
- `BaseBentoInfo` and `ModelInfo` allow extra fields for backward
  compatibility.
- Metadata loaders migrate older YAML shapes before structuring them.
- Generated gRPC code exists for multiple protocol versions.
- New service loading falls back to old service objects when no new SDK service
  is found.

Best practices learned:

- Compatibility should be explicit at boundaries: import boundary, metadata
  loader boundary, and service loader boundary.
- New code should not spread legacy checks everywhere. Build small adapters.
- Metadata parsers should tolerate extra fields when reading old artifacts.
- Warnings should include a migration direction when practical.

## Reusable Design Checklist

For a Python project that is both SDK and runtime, BentoML suggests this
checklist:

- Public API:
  expose stable names lazily, keep optional dependencies optional, and make
  deprecations visible at import boundaries.

- Declarations:
  convert decorators into metadata objects immediately; do not rely on
  inspecting user code repeatedly at runtime.

- Type hints:
  use annotations to derive schemas, clients, docs, and validation, but keep
  explicit override hooks.

- Lifecycle:
  separate import, declaration, build, process supervision, worker startup,
  request handling, and shutdown.

- Artifacts:
  write structured metadata, validate names, use context managers for
  registration, and make partial writes roll back.

- Configuration:
  define a precedence order, validate schemas centrally, and expose derived
  resources through providers.

- Optional integrations:
  make each integration own framework-specific save/load logic while sharing a
  common model metadata contract.

- Serving:
  put health, readiness, metrics, tracing, timeout, and concurrency controls in
  app factories and middleware.

- Security:
  guard serialization trust boundaries, sanitize filenames, block unsafe URL
  fetches, and test generated shell/container text with injection-shaped input.

- Tests:
  cover primitives directly, product journeys end to end, and dependency-heavy
  integrations in isolated jobs.

## A Small Abstracted Example

This example compresses several BentoML lessons into a smaller service runtime:

```python
class Endpoint:
    def __init__(self, func, *, route=None):
        self.func = func
        self.name = func.__name__
        self.route = route or f"/{self.name}"
        self.input_model = model_from_signature(func)
        self.output_model = model_from_return_type(func)

    def __get__(self, instance, owner):
        if instance is None:
            return self
        local = functools.partial(self.func, instance)
        if proxy := getattr(instance, "__proxy__", None):
            remote = getattr(proxy, self.name)
            remote.local = local
            return remote
        return local


def endpoint(func=None, *, route=None):
    def wrap(f):
        return Endpoint(f, route=route)
    return wrap(func) if func else wrap


@attrs.define
class Component:
    name: str
    inner: type
    endpoints: dict[str, Endpoint] = attrs.field(factory=dict)

    def __attrs_post_init__(self):
        for name in dir(self.inner):
            value = getattr(self.inner, name)
            if isinstance(value, Endpoint):
                self.endpoints[name] = value

    def __call__(self):
        instance = self.inner()
        instance.__component__ = self
        return instance


def component(cls):
    return Component(name=cls.__name__, inner=cls)
```

This is not a replacement for BentoML. It shows the transferable pattern:
declaration stays ergonomic, but the framework immediately creates structured
objects that can power schema generation, local calls, remote calls, lifecycle
management, and tests.

## Final Takeaways

BentoML is strong because it accepts the complexity of its domain instead of
flattening it into one generic abstraction. Serving AI applications involves
Python user code, optional ML frameworks, artifact packaging, process
supervision, HTTP/gRPC protocols, cloud deployment, local development, and
security-sensitive serialization. The repo handles that by creating clear
boundaries:

- declarations in `_bentoml_sdk`;
- implementation in `_bentoml_impl`;
- shared primitives in `bentoml._internal`;
- stable user imports in `bentoml`;
- operational commands in `bentoml_cli`;
- layered tests under `tests/`.

The best reusable lesson is to make every boundary produce a concrete object:
`Service`, `APIMethod`, `Dependency`, `Model`, `Bento`, `Tag`,
`BentoBuildConfig`, `Serde`, `BaseAppFactory`, `RemoteProxy`. Once behavior is
represented by explicit objects, the project can validate it, serialize it,
test it, document it, and run it in different environments without losing track
of what the user declared.
