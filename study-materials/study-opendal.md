# OpenDAL Architecture Study

This note studies Apache OpenDAL as a modern Rust storage abstraction.  The
central lesson is how it offers one public API over many storage systems
without pretending that all backends have the same capabilities.  It does this
with a small facade (`Operator`), backend traits (`Service`), feature-gated
services, composable layers, explicit capabilities, and an error model that
separates kind, retry status, operation, context, and source.

The files I used most heavily:

- `README.md`
- `core/Cargo.toml`
- `core/src/lib.rs`
- `core/core/src/lib.rs`
- `core/core/src/types/operator/operator.rs`
- `core/core/src/raw/accessor.rs`
- `core/core/src/raw/layer.rs`
- `core/core/src/types/error.rs`
- `core/core/src/types/builder.rs`
- `core/core/src/types/capability.rs`
- `core/layers/retry/src/lib.rs`
- `core/layers/logging/src/lib.rs`
- `core/services/fs/src/backend.rs`

## 1. What This Repo Is Optimizing For

OpenDAL aims to make storage access portable across object stores, file
systems, cloud services, protocols, databases, and key-value services.

That goal creates three hard constraints:

- expose a consistent user API;
- preserve backend-specific capability differences;
- allow cross-cutting behavior such as retry, timeout, logging, tracing,
  metrics, throttling, and concurrency control without embedding those features
  in every backend.

The architecture solves this by separating:

- user-facing operations: `Operator`;
- backend operation contract: `Service`;
- backend construction: `Builder` and `Configurator`;
- cross-cutting behavior: `Layer`;
- runtime resources: `OperationContext`;
- behavior declaration: `Capability`;
- error semantics: `ErrorKind` and `ErrorStatus`.

## 2. Top-Level Shape

The workspace is organized into:

- `core/core`: real core library and abstractions.
- `core/src`: facade crate that re-exports `opendal_core` and registers
  services behind feature flags.
- `core/services/*`: service implementations such as memory, fs, s3, azblob,
  gcs, http, etc.
- `core/layers/*`: retry, timeout, logging, tracing, metrics, throttling,
  concurrent-limit, and related cross-cutting layers.
- `http-transports/*`: pluggable HTTP transport implementations.
- `bindings/*` or language binding areas: API surfaces for other languages.
- `testkit`: shared behavior tests across services.
- `fuzz`: fuzz targets for risky parsing/IO boundaries.

`core/Cargo.toml` is itself an architecture document.  It uses feature flags to
enable only the services and layers a build needs.  The default feature set
installs common services/layers and a default HTTP transport, but the design
keeps the core small enough for customized builds.

## 3. The Public Facade: Operator

`Operator` is the entry point for users.  Its documentation makes several
important promises:

- it is immutable;
- it is `Send`, `Sync`, and `Clone`;
- operation methods take `&self`;
- adding a layer or replacing runtime resources returns a new operator;
- existing clones and in-flight operations keep using the service stack and
  context they already hold.

Internally, the struct stores both base and composed state:

```rust
pub struct Operator {
    base_srv: Servicer,
    base_ctx: OperationContext,
    layers: Arc<Vec<Arc<dyn Layer>>>,
    srv: Servicer,
    ctx: OperationContext,
}
```

The key design is replay.  Whenever a layer or context changes, OpenDAL folds
the layer list over the base service and base context again:

```rust
let srv = layers
    .iter()
    .fold(base_srv.clone(), |srv, layer| layer.apply_service(srv));

let ctx = layers
    .iter()
    .fold(base_ctx.clone(), |inner, layer| {
        layer.apply_context(srv.clone(), inner)
    });
```

This prevents drift.  The service stack and operation context are always
derived from the same layer program.

## 4. API Pattern: Simple, Builder, Options

OpenDAL repeats a consistent public API pattern:

- simple operation: `read("path")`;
- builder operation: `read_with("path").range(...).chunk(...).await`;
- options struct: `read_options("path", ReadOptions { ... })`.

This is excellent API control because it serves three user needs without
creating unrelated function families:

- common case: concise;
- advanced case: discoverable builder;
- programmatic case: struct that can be passed around or generated.

Abstracted example:

```rust
let bytes = op.read("data.bin").await?;

let bytes = op
    .read_with("data.bin")
    .range(0..1024)
    .chunk(256)
    .await?;

let bytes = op
    .read_options("data.bin", options::ReadOptions {
        range: (0..1024).into(),
        chunk: Some(256),
        ..Default::default()
    })
    .await?;
```

## 5. Backend Contract: Service

`core/core/src/raw/accessor.rs` defines the underlying backend trait:

```rust
pub trait Service: Send + Sync + Debug + Unpin + 'static {
    type Reader: oio::Read;
    type Writer: oio::Write;
    type Lister: oio::List;
    type Deleter: oio::Delete;
    type Copier: oio::Copy;

    fn info(&self) -> ServiceInfo;
    fn capability(&self) -> Capability;
    fn create_dir(...);
    fn stat(...);
    fn read(...);
    fn write(...);
    fn delete(...);
    fn list(...);
    fn copy(...);
    fn rename(...);
    fn presign(...);
}
```

Several design choices matter:

- the trait requires every operation method, so unsupported behavior is
  explicit at the backend boundary;
- support is reported through `Capability`, not guessed from backend type;
- paths are normalized by `Operator`, so backend code can rely on path shape;
- runtime resources are passed via `OperationContext`, not cached directly in
  each backend;
- associated types keep normal code static and efficient;
- `ServiceDyn` erases associated types where dynamic dispatch is needed.

This is a balanced Rust design: static where possible, dynamic where needed for
composition.

## 6. Capability Instead Of Lowest Common Denominator

Storage systems differ.  Some support append, multipart write, conditional
write, native copy, presign, range read, batch delete, or metadata operations.
OpenDAL does not hide those differences.  Backends declare capabilities, and
layers may transform those capabilities.

`fs` backend example:

- `stat`
- `read`
- `write`
- empty write
- append
- multi-write
- conditional write flags
- delete
- list
- copy
- rename

The API can remain uniform while users can still inspect what the current
service stack supports.

The lesson:

> A portability layer should expose capability truth, not force every backend
> into a fake common feature set.

## 7. Construction: Builder And Configurator

`Builder` and `Configurator` split construction into two responsibilities:

- `Builder` builds a service from typed configuration.
- `Configurator` can load configuration from URI, key-value pairs, or a typed
  config object.

This supports both Rust-native usage and dynamic configuration:

```rust
pub trait Builder {
    type Config: Configurator;
    fn build(self) -> Result<impl Service>;
}

pub trait Configurator:
    Serialize + DeserializeOwned + Debug + 'static
{
    type Builder: Builder;
    fn from_uri(uri: &str) -> Result<Self>;
    fn from_iter(iter: impl IntoIterator<Item = (String, String)>)
        -> Result<Self>;
    fn into_builder(self) -> Self::Builder;
}
```

This is reuse with a clear boundary.  Every backend can define its own config,
but all configs participate in the same construction API.

## 8. Layers: Reusing Cross-Cutting Behavior

`Layer` is the main reuse mechanism:

```rust
pub trait Layer: Send + Sync + Debug + 'static {
    fn apply_service(&self, inner: Servicer) -> Servicer { inner }
    fn apply_context(
        &self,
        _srv: Servicer,
        inner: OperationContext,
    ) -> OperationContext { inner }
}
```

A layer can wrap:

- the service stack;
- runtime context;
- HTTP transport;
- executor or concurrency resources.

This is why retry, timeout, logging, tracing, metrics, and throttling do not
need to be implemented independently by every storage backend.

The design also explains when not to reuse: backend-specific authentication,
path semantics, request signing, and native API calls stay in services.  Only
cross-cutting behavior becomes a layer.

## 9. Retry Layer: Error Semantics Drive Behavior

`core/layers/retry/src/lib.rs` retries operations only when
`Error::is_temporary()` is true.  If retries are exhausted, the layer marks the
error `Persistent`.

That means retry is not a blind loop.  It depends on the error model:

- `Temporary`: retry may help.
- `Persistent`: retry was attempted and did not fix it.
- `Permanent`: retry should not be attempted.

The retry layer also documents a subtle danger: layer order matters for
stateful bodies.  A timeout outside retry can drop a retry future before it
restores body state.  This is an unusually honest API warning.  It tells users
which composition is valid and why.

Abstracted example:

```rust
let op = Operator::new(services::Memory::default())?
    .layer(TimeoutLayer::default())
    .layer(RetryLayer::default());
```

If the timeout is placed outside retry, the semantics can change because state
restoration may be interrupted.

## 10. Logging Layer: Observability As A Layer

The logging layer emits structured operation lifecycle messages:

- operation started;
- operation succeeded;
- operation finished;
- operation failed.

It uses the `log` crate and a stable target such as `opendal::services`.
Expected errors are warnings; unexpected errors preserve debug context.

The design is strong because logging is not hard-coded into every backend.
Backends return structured errors; the layer observes operations around the
service stack.

## 11. Error Model

`Error` contains:

- `ErrorKind`: what category of failure occurred;
- message;
- status: permanent, temporary, persistent;
- operation;
- context key/value entries;
- source error;
- optional backtrace for unexpected errors.

`ErrorKind` is non-exhaustive and includes categories such as:

- `Unexpected`
- `Unsupported`
- `ConfigInvalid`
- `NotFound`
- `PermissionDenied`
- `IsADirectory`
- `NotADirectory`
- `AlreadyExists`
- `RateLimited`
- `ConditionNotMatch`
- `RangeNotSatisfied`

This is better than a single string error because layers can make decisions.
Retry uses status.  Logging can choose severity.  Users can match kinds.
Context can accumulate backend and operation details.

Abstracted pattern:

```rust
return Err(Error::new(ErrorKind::NotFound, "object does not exist")
    .with_operation("stat")
    .with_context("service", "s3")
    .with_context("path", path));
```

## 12. Danger Handling

OpenDAL's dangers are not memory-unsafe C dangers.  They are distributed-system
and abstraction-boundary dangers:

- retrying non-idempotent or stateful operations incorrectly;
- hiding unsupported backend behavior;
- losing error context across layers;
- mixing a service stack with the wrong runtime context;
- enabling too many services/features by default;
- path normalization inconsistencies;
- HTTP transport/resource drift.

The architecture handles these through:

- immutable `Operator`;
- replayed layer composition;
- explicit `Capability`;
- structured `Error`;
- `OperationContext`;
- feature flags;
- trait bounds such as `Send + Sync + 'static`;
- testkit behavior tests across services.

## 13. Observability

OpenDAL offers observability mostly through layers:

- logging layer;
- tracing layer;
- metrics layer;
- retry interceptors;
- error context;
- operation names in errors;
- debug implementations that avoid exposing too much internals but show service,
  context, and layer shape.

The key lesson is:

> Observability is part of the composition model, not an afterthought inside
> each backend.

## 14. Testing Strategy

The repo uses several testing styles:

- core unit tests for type guarantees such as public types being `Send + Sync`;
- per-service tests;
- shared `testkit` behavior tests;
- fuzz targets for risky parsing/IO surfaces;
- documentation examples that show expected API usage;
- feature-gated builds to ensure optional services compose.

For a storage abstraction, shared behavior tests are especially important.
They check that different backends honor the same user-facing contract where
their capabilities say they can.

## 15. Reuse Decisions

OpenDAL reuses:

- `Operator` as the public facade;
- `Service` as backend contract;
- `Layer` for cross-cutting behavior;
- `Capability` for feature truth;
- `Error` for behavior-driving failures;
- `Builder`/`Configurator` for construction;
- `OperationContext` for runtime resources.

It does not reuse:

- service-specific request signing;
- cloud-specific authentication;
- backend-specific path/root/bucket configuration;
- native API behavior;
- capability declarations that are not actually true.

The rule is:

> Reuse the operation grammar, not the backend implementation.

## 16. Abstract Example Inspired By OpenDAL

A small plugin-like storage system could copy this architecture:

```rust
trait Backend: Send + Sync {
    fn capability(&self) -> Capability;
    fn read(&self, ctx: &Context, path: &str) -> Result<Bytes>;
    fn write(&self, ctx: &Context, path: &str, data: Bytes) -> Result<()>;
}

trait Layer: Send + Sync {
    fn wrap(&self, inner: Arc<dyn Backend>) -> Arc<dyn Backend>;
}

#[derive(Clone)]
struct Client {
    base: Arc<dyn Backend>,
    layers: Arc<Vec<Arc<dyn Layer>>>,
    current: Arc<dyn Backend>,
}

impl Client {
    fn layer(&self, layer: impl Layer + 'static) -> Self {
        let mut layers = (*self.layers).clone();
        layers.push(Arc::new(layer));

        let current = layers
            .iter()
            .fold(self.base.clone(), |inner, l| l.wrap(inner));

        Self {
            base: self.base.clone(),
            layers: Arc::new(layers),
            current,
        }
    }
}
```

The important part is the replayable layer list.  It lets clones diverge
without mutating shared service state.

## 17. What To Learn

OpenDAL's good practice is compositional architecture:

- give users one facade;
- keep backend truth in capabilities;
- centralize cross-cutting behavior in layers;
- make errors structured enough for policy;
- keep operators immutable and cheap to clone;
- use feature flags to control build surface;
- expose simple, builder, and options APIs consistently;
- test the shared contract across implementations.

