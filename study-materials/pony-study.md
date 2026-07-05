---
tags: Python projects
---

# Pony ORM Codebase Study

This document studies the local Pony repository as a Python project. It focuses
on the design habits that make the codebase effective: native-feeling public
APIs, explicit metadata, structured translation phases, strong transaction
boundaries, dialect isolation, and tests that lock down behavior across many
edge cases.

## Executive Summary

Pony's most important engineering idea is that a friendly Python surface should
be converted quickly into explicit internal structures. A user writes normal
classes, descriptors, generator expressions, lambdas, and context managers. The
library turns those into entity metadata, schema objects, SQL AST nodes,
provider converters, identity-map entries, and transaction state.

The main lessons from this repository are:

- Python descriptors can make domain declarations compact without losing
  runtime metadata.
- A metaclass can perform a serious declaration phase when it validates names,
  attaches entities to one database, discovers attributes, builds indexes, and
  prepares mapping metadata.
- A context manager/decorator can encode transaction semantics in one public
  object, including nested sessions, retries, allowed exceptions, and rollback.
- A unit of work needs a real identity map, change tracking, uniqueness indexes,
  reverse relationship maintenance, and deterministic flush/commit behavior.
- Query translation is safer and more maintainable when it passes through
  structured phases: bytecode/source to AST, AST pre-translation, typed monads,
  SQL AST, SQL builder, DB-API adapter.
- Dialect support should be separated into providers, converters, schema
  classes, translators, and builders instead of scattered `if sqlite` branches.
- Raw SQL support can still preserve parameter binding by parsing placeholders
  and adapting them to the provider's paramstyle.
- Error quality is part of API design. Pony invests heavily in precise
  exception messages and traceback trimming at user-facing boundaries.
- Tests are used as executable product contracts: transaction retry behavior,
  closure handling, query errors, relationship synchronization, SQL AST output,
  schema mapping, and provider differences are all covered directly.

The project is a strong example of building a Python DSL without abandoning
Python syntax. The implementation succeeds because every magical user-facing
feature is backed by concrete internal state.

## Repository Shape

The repository is compact, but the package boundaries are meaningful:

- `pony/orm/core.py`: the heart of the ORM. It contains database binding,
  sessions, caches, entity metaclass logic, attributes, relationships, query
  objects, aggregates, identity-map behavior, flush/commit/rollback, and
  lifecycle hooks.
- `pony/orm/sqltranslation.py`: translates Python AST expressions into a typed
  SQL-oriented intermediate representation.
- `pony/orm/asttranslation.py`: walks Python ASTs, reconstructs source strings,
  marks external values, and builds value extractors.
- `pony/orm/decompiling.py`: decompiles Python bytecode into AST when source
  objects such as generator expressions and lambdas need analysis.
- `pony/orm/sqlbuilding.py`: turns SQL AST lists into SQL text plus DB-API
  parameter adapters.
- `pony/orm/dbschema.py`: models schema objects such as tables, columns,
  indexes, and foreign keys.
- `pony/orm/dbapiprovider.py`: common provider boundary, DB-API exception
  wrapping, pools, converters, quoting, transaction hooks, and dialect
  capabilities.
- `pony/orm/dbproviders/`: database-specific providers for SQLite, PostgreSQL,
  MySQL, Oracle, and CockroachDB.
- `pony/orm/ormtypes.py`: normalized runtime type system used by query
  translation and parameter handling.
- `pony/orm/serialization.py`: object graph export to dictionaries and JSON.
- `pony/orm/tests/`: broad unittest suite for sessions, mapping, queries,
  relationships, SQL generation, decompilation, converters, JSON/array types,
  inheritance, and CRUD behavior.
- `pony/flask/` and `pony/orm/integration/bottle_plugin.py`: small web
  integrations that wrap request handling in `db_session`.
- `setup.py`: package metadata and test discovery.

The codebase favors a "few deep modules" style. `core.py` is large, but it keeps
highly coupled ORM runtime mechanics close together: attribute descriptors need
entity metadata, the session cache needs entity state, and query execution needs
the database/provider/cache boundary.

Reusable structure for a compact framework:

```text
package/
  core.py                 # public runtime objects and domain lifecycle
  translation.py          # domain DSL to intermediate representation
  building.py             # intermediate representation to executable form
  schema.py               # durable schema/metadata model
  providers/
    base.py               # common provider contract
    sqlite.py             # dialect specialization
    postgres.py
  tests/
    test_lifecycle.py
    test_translation.py
    test_relationships.py
    test_provider_sql.py
```

This works when the domain is cohesive and the internal objects need to
cooperate tightly.

## Public API Shape

The public ORM API is intentionally small. `pony/orm/__init__.py` re-exports
from `pony.orm.core`, so users can write:

```python
from pony.orm import Database, Required, Optional, PrimaryKey, Set, db_session
```

The public model is direct:

```python
db = Database()

class Group(db.Entity):
    number = PrimaryKey(int)
    students = Set("Student")

class Student(db.Entity):
    name = Required(str)
    group = Required(Group)

db.bind(provider="sqlite", filename=":memory:")
db.generate_mapping(create_tables=True)
```

The surface is small, but each public object carries significant behavior:

- `Database` owns entities, provider binding, schema generation, raw SQL,
  connections, and mapping state.
- `db.Entity` is a dynamically created base class associated with one database.
- `Required`, `Optional`, `PrimaryKey`, and `Set` are descriptors and metadata
  declarations.
- `db_session` is both a context manager and a decorator.
- `select`, `get`, `exists`, aggregates, and query methods form a Python-native
  query API.

Best practices learned:

- Keep imports boring and memorable for users.
- Put complexity behind objects that already make sense in the domain.
- Make user code ordinary Python where possible: classes, attributes, context
  managers, decorators, lambdas, and generator expressions.
- Do not leave declarations as passive syntax. Convert them into metadata early.

## Entity Declarations As A Compile Phase

The entity system is built around `EntityMeta` in `pony/orm/core.py`. Defining a
class is not just class creation; it is a declaration compile phase.

During class creation, Pony:

- verifies that entity classes belong to exactly one database;
- rejects entity definitions after mapping has already been generated;
- disallows user `__slots__` that would interfere with internal instance state;
- enforces naming rules such as capitalized entity names;
- discovers `Attribute` instances declared on the class;
- creates implicit primary keys when none are declared;
- builds indexes and primary-key metadata;
- attaches the entity to `database.entities`;
- prepares inheritance and discriminator metadata;
- computes bit masks used later for read/write tracking;
- creates a default generator expression for `Entity.select()`.

That gives the runtime a complete entity model before any query or flush runs.

Simplified pattern:

```python
class ModelMeta(type):
    def __new__(mcls, name, bases, namespace):
        attrs = {
            key: value
            for key, value in namespace.items()
            if isinstance(value, Field)
        }
        cls = super().__new__(mcls, name, bases, namespace)
        cls._fields = attrs
        for key, field in attrs.items():
            field.bind(cls, key)
        registry.register(cls)
        return cls
```

Best practices learned:

- Treat class definition as a validation and metadata-building boundary.
- Make illegal states impossible before runtime operations start.
- Record enough metadata once so hot paths do not repeatedly inspect class
  dictionaries.
- If a declaration is tied to a specific runtime owner, such as one database,
  enforce that ownership at declaration time.

## Attributes As Descriptors

`Attribute` and its subclasses are central to Pony's design. `Required`,
`Optional`, `PrimaryKey`, and `Set` are not simple markers; they are descriptors
that manage validation, lazy loading, change tracking, reverse relationships,
and column/converter metadata.

An attribute declaration records:

- Python type or related entity;
- required/optional/nullability semantics;
- uniqueness and index options;
- column names and SQL converters;
- reverse relationship information;
- collection behavior for sets and many-to-many joins;
- default values and optimistic checks;
- bits used for loaded/modified tracking.

At instance access time, the descriptor can:

- return cached values;
- lazy-load unloaded values from the database;
- validate assignment;
- update reverse relationship collections;
- mark objects as modified;
- maintain indexes in the session cache.

Abstracted pattern:

```python
class Field:
    def bind(self, owner, name):
        self.owner = owner
        self.name = name

    def __get__(self, obj, owner):
        if obj is None:
            return self
        if self.name not in obj._loaded:
            obj._load_field(self)
        return obj._values[self.name]

    def __set__(self, obj, value):
        value = self.validate(value)
        old = obj._values.get(self.name)
        obj._values[self.name] = value
        obj._mark_changed(self, old, value)
```

Best practices learned:

- Descriptors are a natural fit when a declared attribute must behave as both
  metadata on the class and managed data on instances.
- Keep validation close to assignment.
- Let descriptors own lazy loading and change notification; callers should not
  need to remember those rules.
- Relationship attributes should update both sides in one operation.

## Database Binding And Mapping

`Database` has two major lifecycle phases:

1. Binding to a provider.
2. Generating mapping and schema metadata.

Binding loads the provider module/class, records provider state, installs
connection hooks, and prevents accidental rebinding. Mapping resolves attribute
types, links reverse attributes, computes table and column names, creates
schema objects, handles many-to-many tables, creates indexes and foreign keys,
and optionally checks or creates physical tables.

This phase split matters. Entity classes can be declared before the concrete
database connection is known. Once binding and mapping happen, runtime behavior
has the full provider and schema context.

Simplified lifecycle:

```python
db = Database()

class User(db.Entity):
    email = Required(str, unique=True)

db.bind(provider="postgres", dsn="...")
db.generate_mapping(create_tables=True)
```

Best practices learned:

- Separate declaration from provider binding when users need flexible startup.
- Once mapping is generated, freeze the declaration surface.
- Resolve strings and forward references during a dedicated mapping phase.
- Build structured schema objects before emitting DDL.
- Keep `check_tables` and `create_tables` explicit so users control safety.

## `db_session` As The Transaction Boundary

`DBSessionContextManager` is both a context manager and a decorator. It encodes
the transaction contract for ordinary code, nested calls, retries, generator
functions, and allowed exceptions.

Important behaviors:

- `with db_session:` starts a session and commits or rolls back on exit.
- Nested sessions are recognized and do not create independent transactions.
- As a decorator, `@db_session` wraps function execution in the same lifecycle.
- `allowed_exceptions` can cause selected exceptions to commit instead of
  rollback.
- `retry` and `retry_exceptions` rerun decorated functions after retryable
  failures.
- Generator/coroutine usage is special because work can suspend; the code
  forces explicit commit/rollback discipline around suspension.
- Session state is stored in local state and accessed by database caches.

The tests in `test_db_session.py` treat this as a product contract: invalid
arguments, nested sessions, decorator behavior, rollback on exceptions, allowed
exceptions, retry counts, successful retry commits, and session scope are all
tested explicitly.

Reusable pattern:

```python
class UnitOfWork:
    def __call__(self, func=None, **options):
        if func is None:
            return self.configure(**options)

        def wrapper(*args, **kwargs):
            attempts = options.get("retry", 0) + 1
            for attempt in range(attempts):
                with self:
                    try:
                        return func(*args, **kwargs)
                    except options.get("retry_exceptions", ()):
                        if attempt + 1 == attempts:
                            raise
                        self.rollback()
        return wrapper

    def __enter__(self):
        self.cache = open_cache()
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc is None or self.is_allowed(exc):
            self.commit()
        else:
            self.rollback()
```

Best practices learned:

- A transaction boundary should be one obvious public construct.
- Make decorator and context-manager semantics match.
- Test retry and exception behavior with exact counts and database state.
- Treat nested usage deliberately; accidental nested commits are a common source
  of bugs.

## Identity Map And Unit Of Work

`SessionCache` is Pony's identity map and unit of work. It owns the in-session
view of database objects and the changes that need to be flushed.

It tracks:

- loaded objects by entity and primary key;
- uniqueness indexes;
- objects to save;
- modified flags and read/write bit masks;
- query result caches;
- connection state and transaction mode;
- permissions and seed objects;
- many-to-many modifications;
- after-save hooks.

This is why two loads of the same row return the same in-memory object within a
session, and why relationship changes can be coordinated before SQL is emitted.

The cache lifecycle handles:

- connecting and reconnecting;
- preparing connections before query execution;
- flushing pending changes;
- committing and rolling back;
- releasing or dropping connections;
- detaching objects when the session closes.

Best practices learned:

- Do not scatter persistence state across model instances alone. Keep a session
  object that owns identity, connection, pending work, and query caches.
- Maintain uniqueness indexes in memory so conflicts are caught before flush
  where possible.
- Distinguish created, loaded, modified, deleted, and detached states.
- Put flush ordering and lifecycle hooks in one unit-of-work implementation.

## Entity Instances And Object State

`Entity` instances have explicit internal slots such as session cache, status,
primary-key value, database values, current values, read bits, write bits, and
save status. Pony does not rely on a loose `__dict__` for persistence state.

Constructor behavior is strict:

- only keyword arguments are allowed;
- mapping must be generated before instances are created;
- attributes are validated;
- uniqueness and primary-key indexes are checked in the cache;
- new objects are added to the identity map;
- save work is scheduled.

Runtime methods handle:

- loading missing values;
- marking attributes changed;
- constructing optimistic update criteria;
- saving created, updated, and deleted rows;
- deleting objects and cascading relationship updates;
- lifecycle hooks such as `before_insert`, `after_update`, and related hooks;
- conversion to dictionaries and JSON.

Best practices learned:

- Give persisted objects explicit state transitions.
- Keep object construction strict; permissive construction creates later mapping
  and flush errors.
- Use internal slots for framework-managed state when object count can be high.
- Keep lifecycle hooks close to the save implementation that invokes them.

## Query Pipeline

Pony's query system lets users write:

```python
students = select(s for s in Student if s.group.number == 101 and s.gpa > 3.0)
```

That expression goes through a multi-stage pipeline:

1. Capture a generator expression, lambda, or string query.
2. Obtain or decompile a Python AST.
3. Walk the AST and identify external values.
4. Build extractor functions for those external values.
5. Normalize external values and types.
6. Translate the AST into typed monads.
7. Build a SQL AST.
8. Convert SQL AST to SQL text plus parameter adapter.
9. Execute through the provider and session cache.
10. Materialize entities or scalar results with prefetch/cache support.

This is the key design lesson in the repo: a native Python DSL should not be
translated by ad hoc string manipulation. Pony carries structure forward at
each stage.

Best practices learned:

- Preserve source location and expression text for better error messages.
- Extract external variables explicitly instead of interpolating values into
  SQL strings.
- Normalize external value types before translation cache lookup.
- Cache translators and built SQL by normalized structure and provider context.
- Keep query execution separate from query construction.

## AST Translation And External Values

`asttranslation.py` provides two important pieces:

- `PythonTranslator`, which reconstructs source text from AST nodes.
- `PreTranslator`, which marks nodes as internal query variables, constants, or
  external values.

The pre-translation pass understands generator scopes and lambda arguments. It
marks names assigned inside the query as local and names from surrounding
scopes as external. It also treats selected functions specially, including
constant functions and raw SQL.

External nodes are converted into extractor functions:

```python
extractors = {
    "threshold": lambda globals, locals: eval("threshold", globals, locals),
    "user.group.id": lambda globals, locals: eval("user.group.id", globals, locals),
}
```

The exact implementation compiles each expression once and caches extractors by
code key.

Best practices learned:

- Query translation should know lexical scope, not just variable names.
- Compile reusable extractor functions instead of repeatedly evaluating parsed
  text.
- Treat constants and external variables differently; constants can participate
  in structural caching more aggressively.
- Cache visitor dispatch methods because AST traversal happens frequently.

## Bytecode Decompilation

`decompiling.py` exists because Python generator expressions and lambdas are
runtime objects. Source is not always directly available in the shape the ORM
needs, so Pony reconstructs an AST from bytecode.

The decompiler:

- accepts code objects, generator objects, and functions;
- unwraps decorated functions;
- records closure cells;
- caches ASTs by code object identity;
- scans bytecode instructions across Python versions;
- handles jumps, boolean operations, comprehensions, lambda bodies, calls,
  comparisons, constants, and newer bytecode changes;
- reports unsupported bytecode as explicit decompile errors.

The decompiler tests generate many boolean-expression shapes and verify that
the decompiled expression has equivalent truth-table behavior. Other tests
compare AST dumps for generator expressions and lambdas.

Best practices learned:

- If a framework relies on interpreter internals, isolate that logic in one
  module and test it heavily.
- Cache by code object identity; decompilation is expensive and pure for a code
  object.
- Version-specific compatibility code is acceptable when it is explicit and
  covered by tests.
- Behavioral tests can be more robust than only checking exact generated text.

## Typed Monads As An Intermediate Language

`sqltranslation.py` uses many `Monad` classes. These are not mathematical
decoration; they are Pony's typed intermediate representation for query
expressions.

Different monads represent:

- entities;
- attributes;
- constants;
- parameters;
- comparisons;
- boolean expressions;
- functions;
- lists, tuples, and sets;
- query sets;
- aggregates;
- raw SQL fragments.

Each monad carries enough information to answer questions such as:

- What Python/ORM type does this expression have?
- Is it nullable?
- Is it aggregated?
- What SQL AST represents it?
- Which methods or operations are allowed?
- Can it be compared with another expression?

This layer is why Pony can reject bad queries with domain-specific messages,
such as incompatible types or invalid aggregate usage.

Abstracted pattern:

```python
class Expr:
    type = object

    def to_sql(self):
        raise NotImplementedError

class AttrExpr(Expr):
    def __init__(self, entity, attr):
        self.entity = entity
        self.attr = attr
        self.type = attr.py_type

    def eq(self, other):
        if not comparable(self.type, other.type):
            raise TypeError("incomparable types")
        return CompareExpr("=", self, other)
```

Best practices learned:

- Build a typed intermediate layer when translating a rich host language.
- Put operation validity on the intermediate objects, not in scattered `if`
  checks.
- Carry enough metadata to produce useful errors.
- Delay SQL string creation until after expression semantics are validated.

## SQL AST And SQL Builder

Pony represents SQL as nested list-like AST nodes using symbols from
`sqlsymbols.py`. `sqlbuilding.py` turns that AST into SQL text and a parameter
adapter.

The builder handles:

- SELECT, INSERT, UPDATE, DELETE, joins, WHERE, GROUP BY, ORDER BY, LIMIT, and
  dialect-specific syntax;
- quoting values and identifiers;
- parameter numbering;
- nested builder output;
- DB-API paramstyle adaptation;
- flattening and formatting SQL;
- moving join conditions when a dialect or option requires older syntax.

Tests in `test_sqlbuilding_sqlast.py` exercise direct SQL AST construction,
including alias handling with names that need quoting.

Simplified flow:

```python
sql_ast = [
    SELECT,
    [ALL, [COLUMN, "s", "name"]],
    [FROM, ["s", TABLE, "Student"]],
    [WHERE, [EQ, [COLUMN, "s", "group"], [PARAM, "group_id"]]],
]

sql, adapter = db._ast2sql(sql_ast)
cursor = db._exec_sql(sql, adapter(values))
```

Best practices learned:

- Keep generated SQL structured until the final rendering step.
- Make parameter adaptation a builder output, not a side effect of execution.
- Test the builder directly with SQL AST examples.
- Let providers customize builders for dialect syntax instead of complicating
  the common builder.

## Provider And Dialect Boundary

`DBAPIProvider` is the common boundary between ORM logic and database-specific
behavior. Provider modules specialize it for SQLite, PostgreSQL, MySQL, Oracle,
and CockroachDB.

The provider owns:

- DB-API module integration;
- paramstyle and quoting rules;
- maximum name and parameter limits;
- dialect feature flags;
- converter classes;
- schema, translator, and builder classes;
- connection pools;
- exception wrapping;
- transaction commands;
- SQL execution hooks;
- server-version behavior;
- DDL inspection and creation.

This design makes dialect specialization explicit. For example, SQLite has
custom date/time/string/json functions and no real `SELECT FOR UPDATE`.
PostgreSQL registers JSON/UUID handling, uses pyformat parameters, supports
arrays, handles serializable modes, and discards connection state on release.

Best practices learned:

- Put all dialect capability flags and classes behind one provider object.
- Let providers override translator, schema, and builder classes as needed.
- Wrap DB-API exceptions at the boundary so the rest of the ORM sees stable
  exception types.
- Keep connection-pool behavior provider-owned; transaction cleanup differs by
  database.

## Converters And Type Normalization

Pony separates two related concerns:

- DB value conversion in `dbapiprovider.py`.
- Query value/type normalization in `ormtypes.py`.

Converters validate Python values, convert Python values to database values,
convert database values back to Python, and provide SQL type declarations. The
base converter hierarchy covers strings, integers, floats, decimals,
datetimes, JSON, arrays, UUIDs, and provider-specific variants.

`ormtypes.py` normalizes values used in query translation. It recognizes entity
classes, entity objects, queries, raw SQL fragments, functions, methods,
primitive values, sets, arrays, and tracked JSON/array values. Normalized types
are used for comparison checks and query cache keys.

Best practices learned:

- Keep database conversion separate from expression type analysis.
- Use immutable or hashable normalized type objects for cache keys.
- Preserve change tracking for mutable JSON/array values through tracked
  wrappers.
- Make unsupported values fail during translation, not after SQL execution.

## Schema Modeling

`dbschema.py` models database schema using objects:

- `DBSchema`;
- `Table`;
- `Column`;
- `DBIndex`;
- `ForeignKey`.

The schema layer is responsible for:

- table and column name ownership;
- duplicate name detection;
- primary keys and indexes;
- foreign-key dependency ordering;
- many-to-many join tables;
- DDL generation;
- table creation and checking.

Schema objects validate their relationships. A foreign key must reference
columns in compatible tables. An index owns a set of columns. A table owns its
columns and constraints. This gives the ORM a structured model before DDL is
rendered.

Best practices learned:

- Model DDL as objects first, strings second.
- Keep ownership rules in schema classes.
- Sort tables by dependency when creating or dropping them.
- Give schema errors precise table/column names.

## Raw SQL Without Giving Up Binding

Pony supports raw SQL fragments, but it does not require users to manually
format values into SQL strings. `raw_sql` expressions and `Database._execute`
paths use placeholder adaptation.

`adapt_sql` scans `$expr` placeholders, evaluates the Python expression in the
provided globals/locals, and converts placeholders to the provider's DB-API
paramstyle. The result is SQL plus arguments.

Conceptual example:

```python
min_age = 21
db.select("select * from Person where age >= $min_age")
```

The SQL sent to the database uses provider parameters rather than string
interpolation.

Best practices learned:

- Raw SQL is useful, but it should still use the same parameter-binding
  discipline as generated SQL.
- Make raw SQL adaptation provider-aware.
- Keep raw SQL escape hatches explicit so the translator can reason about them.

## Relationship Integrity

Pony relationship handling is one of the more carefully tested areas. Required,
optional, one-to-one, one-to-many, and many-to-many relationships all have
different ownership and deletion semantics.

The relationship tests cover behavior such as:

- assigning `None` to a required relationship raises a clear `ValueError`;
- removing an object from a required parent collection can mark the child for
  deletion;
- clearing a collection updates affected child state;
- assigning one collection to another updates reverse links;
- adding or removing invalid values gives precise errors;
- membership checks and collection counts use caches when possible;
- read bits are updated when relationship membership is checked.

Best practices learned:

- Relationship updates must be bidirectional in memory before flush.
- Required relationships need explicit deletion or rejection rules.
- Collection operations should validate inputs as strongly as scalar
  assignments.
- Cache-aware collection methods need direct tests so optimizations do not
  become stale behavior.

## Lazy Loading, Prefetching, And Query Caches

Pony uses lazy loading for unloaded attributes and relationship collections, but
keeps loaded state explicit through read bits and cache entries. Query results
can be cached inside the session, and collection methods can reuse loaded
counts or membership state.

`PrefetchContext` and query prefetching help avoid repeated lazy loads when the
query knows related data will be needed. The session cache also clears or
invalidates relevant query results after bulk operations.

The test suite covers examples such as:

- collection `is_empty()` using cached results;
- `count()` using cached or modified collection state;
- loaded objects avoiding unnecessary SQL during collection updates;
- bulk delete clearing query caches so later queries reflect new state.

Best practices learned:

- Lazy loading must be paired with explicit loaded-state tracking.
- Cache invalidation should be tested at the behavior level.
- Collection caches need to account for pending in-memory modifications.
- Prefetch should be a query execution concern, not a descriptor side effect.

## Serialization

`serialization.py` provides `to_dict` and `to_json` for entities and object
graphs. The `Bag` helper gathers objects from one database/session, applies
per-entity configuration, walks related objects when requested, and emits a
stable dictionary keyed by entity name and primary key.

Important details:

- objects from different transactions are rejected;
- entity configuration can include/exclude attributes and control collections;
- related objects can be included without infinite recursion;
- composite primary keys are reduced to stable string keys;
- dates, datetimes, and decimals are converted for JSON.

Best practices learned:

- Serialize through a graph collector, not by recursively calling `to_dict` on
  every object independently.
- Validate that exported objects belong to one database and one transaction.
- Make composite identifiers stable in serialized output.
- Keep JSON conversion narrow and explicit.

## Web Integrations

The Flask and Bottle integrations are intentionally tiny because the transaction
boundary is already well designed.

Flask integration:

```python
def _enter_session():
    session = db_session()
    request.pony_session = session
    session.__enter__()

def _exit_session(exception):
    session = getattr(request, "pony_session", None)
    if session is not None:
        session.__exit__(exc=exception)
```

Bottle integration wraps each route callback with `db_session`, treating normal
HTTP responses as allowed exceptions while real HTTP errors still roll back.

Best practices learned:

- If the core lifecycle primitive is strong, framework integrations can be
  small adapters.
- Store request-local session handles on the web framework's request object.
- Let framework-specific response/control-flow exceptions participate in the
  same commit/rollback policy.

## Error Handling And Developer Experience

Pony cares about error messages. Many tests assert exact exception text. This is
important because the ORM exposes a Python DSL; when translation fails, users
need to know which expression and type caused the problem.

Examples of tested error categories include:

- bad `db_session` arguments;
- unsupported query iteration sources;
- undefined names in query expressions;
- incomparable query types;
- unsupported external values;
- invalid mapping table/column declarations;
- invalid relationship shapes;
- invalid collection operations;
- unsupported bytecode operations.

`pony.utils.cut_traceback` trims internal frames when `CUT_TRACEBACK` is enabled,
so user-facing errors are shorter. Tests disable traceback cutting to preserve
diagnostic detail during the suite.

Best practices learned:

- Assert exact error messages for important user-facing failures.
- Include the expression fragment in translation errors when possible.
- Keep traceback trimming as an option, not a hardcoded behavior that makes
  debugging the framework impossible.
- Raise domain exceptions at boundaries instead of leaking DB-API or interpreter
  internals everywhere.

## Testing Strategy

The test suite is broad and pragmatic. It uses `unittest`, in-memory SQLite by
default, and an environment-driven provider setting for other databases. Test
helpers provide provider skipping, exact-message assertions, and mocked
providers/connections for SQL generation tests.

Representative test areas:

- `test_db_session.py`: transaction boundaries, nesting, retries, allowed
  exceptions, rollback/commit behavior, session scope.
- `test_query.py`: query construction, invalid sources, external variables,
  type errors, aggregates, closures, pickling, cache invalidation.
- `test_declarative_sqltranslator.py`: joins, aggregates, object parameters,
  composite keys, chained relationships, functions, slicing, entity-database
  mismatch errors.
- `test_decompiler.py`: bytecode decompilation for generator expressions,
  lambdas, boolean logic, and AST equivalence.
- `test_sqlbuilding_sqlast.py`: direct SQL AST to SQL behavior.
- `test_mapping.py`: table/column mapping, implicit IDs, duplicate columns,
  relationship validity, custom column names.
- `test_relations_one2many.py` and related files: required/optional
  relationship semantics, reverse updates, collection caches.
- converter and type tests: Python value validation and provider conversion.

Best practices learned:

- Use in-memory defaults for fast local tests, but keep provider selection
  configurable.
- Test behavior through the public API even when internals are sophisticated.
- Add direct tests for intermediate representations such as SQL ASTs and
  decompiled ASTs.
- Treat error messages and cache invalidation as first-class test targets.

## Design Patterns Worth Reusing

### 1. Native Declarations, Explicit Metadata

Let users write natural Python, then immediately convert it into metadata.

```python
class Task(Model):
    title = Required(str)
    owner = Required(User)
```

Internally:

```python
Task._fields == {
    "title": Field(type=str, required=True),
    "owner": Relationship(target=User, required=True),
}
```

This gives users a pleasant syntax while giving the framework structured data.

### 2. Dedicated Lifecycle Phases

Pony separates:

- class declaration;
- provider binding;
- mapping generation;
- session execution;
- flush;
- commit/rollback;
- detach/close.

Reusable checklist:

- What can be validated at declaration time?
- What requires external configuration?
- When does the runtime become immutable?
- Where are side effects allowed?
- What cleanup always happens?

### 3. Structured Translation Pipeline

For any user-facing DSL, prefer this shape:

```text
user syntax
  -> language AST
  -> semantic intermediate objects
  -> backend-neutral operation tree
  -> backend-specific renderer
  -> executable command and bound parameters
```

Avoid jumping directly from user syntax to backend strings.

### 4. Provider-Owned Dialects

Instead of:

```python
if provider == "sqlite":
    ...
elif provider == "postgres":
    ...
```

Prefer:

```python
provider.translator_cls
provider.schema_cls
provider.sqlbuilder_cls
provider.converter_classes
provider.paramstyle
```

That keeps dialect differences in the dialect layer.

### 5. Unit Of Work As The Source Of Truth

Persisted objects should not each independently decide when to write. A session
or cache should own:

- identity;
- modified objects;
- uniqueness checks;
- pending inserts/updates/deletes;
- query caches;
- flush ordering;
- transaction outcome.

### 6. Exact Error Messages For DSLs

When a project translates user code, vague errors are expensive. Tests should
assert messages for common mistakes:

```python
@raises_exception(TypeError, "Incomparable types 'str' and 'list'")
def test_bad_comparison(self):
    select(x for x in Item if x.name == ["bad"])
```

This turns developer experience into a maintained contract.

## Practical Checklist For A Python Framework

Use this checklist when applying Pony's lessons to another project:

- Public API:
  - Can users write ordinary Python constructs?
  - Is the import surface small and memorable?
  - Are compatibility imports separated from internals?

- Declaration phase:
  - Are declarations validated once?
  - Is metadata explicit and inspectable?
  - Are ownership rules enforced early?

- Runtime lifecycle:
  - Is there one obvious context manager/decorator for scoped work?
  - Are nested scopes defined?
  - Are retry and exception policies explicit?
  - Is cleanup deterministic?

- State management:
  - Is there a central session/cache/unit-of-work object?
  - Are object states explicit?
  - Are identity and uniqueness maintained in memory?
  - Are cache invalidation cases tested?

- Translation:
  - Is user syntax parsed into structured representations?
  - Are external values extracted safely?
  - Are types normalized before cache lookup?
  - Are backend strings generated only at the final step?

- Backend support:
  - Do providers own dialect capabilities?
  - Are converters centralized?
  - Are exceptions normalized at the boundary?
  - Are schema objects modeled before DDL strings?

- Testing:
  - Are user-facing errors asserted exactly?
  - Are lifecycle edge cases tested?
  - Are provider differences testable without real services where possible?
  - Are internal intermediate forms tested directly when they are core to
    correctness?

## Small Abstracted Example

The following miniature sketch captures Pony's main architectural lesson: keep
the user syntax simple, but make the internal phases explicit.

```python
class Field:
    def __init__(self, py_type, required=False):
        self.py_type = py_type
        self.required = required

    def bind(self, owner, name):
        self.owner = owner
        self.name = name

    def validate(self, value):
        if value is None and self.required:
            raise ValueError(f"{self.name} is required")
        if value is not None and not isinstance(value, self.py_type):
            raise TypeError(f"{self.name} must be {self.py_type.__name__}")
        return value

    def __get__(self, obj, owner):
        if obj is None:
            return self
        return obj._values.get(self.name)

    def __set__(self, obj, value):
        obj._values[self.name] = self.validate(value)
        obj._session.mark_dirty(obj)


class ModelMeta(type):
    def __new__(mcls, name, bases, namespace):
        fields = {k: v for k, v in namespace.items() if isinstance(v, Field)}
        cls = super().__new__(mcls, name, bases, namespace)
        cls._fields = fields
        for field_name, field in fields.items():
            field.bind(cls, field_name)
        return cls


class Model(metaclass=ModelMeta):
    def __init__(self, **kwargs):
        self._values = {}
        self._session = current_session()
        for name, field in self._fields.items():
            setattr(self, name, kwargs.get(name))
        self._session.add(self)


class Session:
    def __init__(self):
        self.new = []
        self.dirty = set()

    def add(self, obj):
        self.new.append(obj)

    def mark_dirty(self, obj):
        self.dirty.add(obj)

    def __enter__(self):
        set_current_session(self)
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc is None:
            self.commit()
        else:
            self.rollback()
        clear_current_session()
```

This is much smaller than Pony, but the same principles apply:

- descriptors own attribute behavior;
- metaclasses turn declarations into metadata;
- sessions own persistence state;
- lifecycle boundaries decide commit or rollback.

## Final Takeaways

Pony is a good Python project because it leans into Python's strengths without
letting dynamic behavior become unstructured. The user sees classes,
attributes, context managers, and generator expressions. The runtime sees
entity metadata, provider contracts, schema objects, typed expression monads,
SQL ASTs, converters, session caches, and explicit object states.

The reusable lesson is to design a friendly API and a rigorous internal model
at the same time. If the API is friendly but the internals are implicit, the
framework becomes fragile. If the internals are rigorous but the API is
awkward, users avoid it. Pony shows how to keep both: make Python syntax the
front door, then immediately lower it into structured, validated, testable
runtime objects.
