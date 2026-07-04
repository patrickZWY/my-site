# OProfile Architecture Study

This note studies `oprofile` as a performance-tooling codebase.  Compared with
OpenSSH or the Linux kernel, OProfile is less about attack containment and more
about preserving measurement data correctly while interacting with kernel perf
interfaces, binary formats, event descriptions, mmaped sample databases, and
offline report tools.

The main lesson is separation of phases: collect low-level samples quickly,
persist them in a compact format, and do expensive symbol/report work later in
post-processing tools.

The files I used most heavily:

- `README`
- `HACKING`
- `doc/CodingStyle`
- `libdb/odb.h`
- `libdb/db_insert.c`
- `libop/op_events.c`
- `libperf_events/operf_counter.cpp`
- `pp/opreport.cpp`
- `libutil/op_libiberty.c`
- `libop/tests/*`
- `libutil/tests/*`

## 1. What This Repo Is Optimizing For

OProfile is a profiler.  Its engineering constraints are:

- keep profiling overhead low;
- collect kernel perf events without losing too much data;
- represent samples in files that can be read later by reporting tools;
- support multiple CPU/event descriptions;
- support old toolchains and varied Linux environments;
- make post-processing flexible without complicating the collector hot path.

This leads to a split between C libraries for low-level, stable mechanics and
C++ tools for richer offline processing.

## 2. Top-Level Shape

`HACKING` explains the repository organization:

- `libdb/`: sample database stored in growable mmaped files.
- `libop/`: C helpers for event parsing, CPU type handling, sample file names,
  and OProfile-specific utilities.
- `libutil/`: portable C utility routines.
- `libutil++/`: C++ utilities such as exceptions, BFD support, path filtering,
  string helpers, and verbose logging.
- `libperf_events/`: abstraction over Linux Performance Events.
- `pe_profiling/`: `operf`, the perf-events based profiler.
- `pe_counting/`: `ocount`, event counting.
- `libpp/`: post-processing library for profile files, symbols, images, and
  report data models.
- `pp/`: reporting tools such as `opreport`, `opannotate`, `oparchive`, and
  `opgprof`.
- `events/`: textual event descriptions and unit masks.
- `doc/`: manuals, internals, schemas, and coding style.

The organization matches the data pipeline:

```text
event descriptions -> configure perf counters -> collect samples
  -> write sample/perf data -> convert/mangle into profile files
  -> read profile files -> resolve images/symbols -> report
```

## 3. API Control: Textual Events Become Structured Events

`libop/op_events.c` parses CPU-specific event description files.  The input is
human-maintained text, but the rest of the system wants structured events,
unit masks, defaults, and extra modifiers.

The parser uses file/line globals for diagnostics:

```c
static char const * filename;
static unsigned int line_nr;
```

On invalid input it prints a contextual parse error and exits.  This is not a
network parser; the event files are trusted project data or administrator data.
Fail-fast behavior is therefore reasonable.  It prevents profiling with a
partially understood hardware event.

Important parser practices:

- parse decimal, hex, and long hex through small helpers;
- require explicit `0x` for fields intended to be hexadecimal;
- track duplicate/missing tags;
- support `include` for shared unit masks;
- keep CPU event descriptions outside compiled code.

Abstracted pattern:

```c
if (seen_default)
	parse_error("duplicate default tag");
if (!seen_type)
	parse_error("missing type");
```

This is a different API-control style from OpenSSH.  The boundary is not
hostile network input; it is project data whose correctness must be enforced
before profiling begins.

## 4. Sample Database Design

`libdb/odb.h` describes an in-memory and mmaped-file hash table for sample
files.  The database contains:

- a caller-defined file header;
- an OProfile descriptor;
- a node array;
- a hash table of node indexes.

Important type choices:

- keys are `uint64_t` because call-graph data can require a pair of 32-bit
  values;
- node indexes are unsigned integers rather than raw pointers, because the
  file is mmaped and may be remapped;
- node 0 is unused, so zero can represent end-of-list.

The API intentionally hides the file layout behind `odb_open`, `odb_close`,
`odb_update_node`, `odb_add_node`, and iteration helpers.

## 5. Atomic Visibility By Layout Discipline

`libdb/db_insert.c` is a good example of low-level C design around concurrent
visibility.  Adding a node follows a reservation/commit pattern:

1. ensure there is room, growing the mmaped hash table if needed;
2. use `current_size` as the reserved node index;
3. initialize the node fields;
4. link the node into the hash bucket;
5. increment `current_size` to make it visible to readers.

The code comments explain that iteration reads through the node array and that
the new slot is not visible until `odb_commit_reservation`.

Abstracted example:

```c
node = &data->node_base[data->descr->current_size];
node->value = value;
node->key = key;
node->next = data->hash_base[index];
data->hash_base[index] = new_node;

/* commit last: readers now see the initialized node */
odb_commit_reservation(data);
```

There is also a `FIXME` about needing a write memory barrier.  That comment is
valuable because it marks a real concurrency assumption rather than pretending
the code is stronger than it is.

## 6. Handling Data Overflow

`odb_update_node_with_offset` checks whether adding the offset would wrap the
sample count to zero:

```c
if (node->value + offset != 0)
	node->value += offset;
else
	/* post profile tools must handle overflow */
```

This is not a perfect solution, but it demonstrates a practical profiler
tradeoff: collection code should not become too expensive or format-breaking
just to make an overflow elegant.  The code records the limitation and leaves
post-processing responsible for dealing with overflow semantics.

## 7. Perf Events Boundary

`libperf_events/operf_counter.cpp` abstracts Linux `perf_event_open`, mmaped
perf buffers, perf event IDs, and event records.

The constructor translates OProfile event configuration into
`perf_event_attr`:

- event type and raw config;
- sample period;
- callgraph/sample CPU flags;
- kernel/hypervisor exclusion flags;
- precise IP where supported;
- `enable_on_exec` and inheritance.

`operf_counter::perf_event_open` handles kernel errors with user-specific
diagnostics:

- `EBUSY`: another profiling tool may be using hardware counters.
- `ESRCH`: target process ended before profiling started.
- other errors: print the syscall failure.

This is good error handling for tooling: it maps common kernel failure modes to
actionable user messages instead of only printing `errno`.

## 8. Pipe And File Robustness

The perf reader contains robust read loops for pipe records.  `_get_perf_event`
style logic handles:

- partial reads;
- interrupted syscalls (`EINTR`);
- closed pipes;
- empty records;
- bogus header sizes;
- file remapping when a record crosses mmap window boundaries.

Abstracted example:

```c
again:
	n = read(fd, p, remaining);
	if (n < 0 && errno == EINTR)
		goto again;
	if (n == 0)
		return PIPE_CLOSED;
	if (n != remaining) {
		p += n;
		remaining -= n;
		goto again;
	}
```

The style is old-school C/C++, but appropriate for the boundary: kernel and
pipe IO do not guarantee record-sized reads.

## 9. Reporting Architecture

`pp/opreport.cpp` shows the offline phase.  It builds summaries from profile
classes, profile sets, application images, dependent libraries, and sample
files.  Counts are aggregated into containers and sorted for output.

This phase can afford richer abstractions:

- `std::vector`, `std::list`, `std::map`;
- C++ exceptions such as `op_runtime_error`;
- symbol and image containers;
- XML output helpers;
- formatting layers.

That is a deliberate reuse decision.  The hot collection path stays close to
kernel/file primitives; the reporting path uses higher-level C++ because its
job is data shaping, not low-overhead sampling.

## 10. Error Handling Style

OProfile has several error modes:

- parser errors in event files call `exit(EXIT_FAILURE)` with file/line
  diagnostics;
- low-level C APIs often return `EXIT_SUCCESS`/`EXIT_FAILURE` or `errno`;
- perf-event code maps common `errno` values to handled profiler errors;
- C++ reporting code throws project-specific runtime errors for impossible
  post-processing states;
- allocation wrappers from libiberty-style helpers centralize out-of-memory
  behavior.

The style is not uniform across the whole repo because the repo spans C
libraries, old code, and newer C++ perf-event tooling.  The architectural rule
is more important than uniform syntax: the error contract fits each phase.

## 11. Observability

OProfile is itself an observability tool, but internally it also includes
diagnostic practices:

- verbose channels such as `vrecord` and `vconvert`;
- progress communication between recording and conversion processes;
- specific messages for kernel perf limitations;
- reporting headers that include CPU/event metadata;
- XML schemas for machine-readable reports;
- debug/stat functions for sample database validation.

The key design lesson is that profiler observability must not distort the thing
being measured.  Therefore, collection diagnostics are guarded by verbosity
channels and common errors are handled with concise messages, while detailed
analysis happens offline.

## 12. Testing And Quality

The repository has unit-style tests under libraries:

- `libop/tests/alloc_counter_tests.c`
- `libop/tests/cpu_type_tests.c`
- `libop/tests/load_events_files_tests.c`
- `libop/tests/mangle_tests.c`
- `libop/tests/parse_event_tests.c`
- `libutil/tests/file_tests.c`
- `libutil/tests/string_tests.c`

These tests cover reusable parsing and utility logic.  That matches the risk:
event parsing, mangling, CPU recognition, and utility behavior are stable
components that many tools depend on.

For full profiler behavior, tests are harder because they depend on kernel
perf_event support, hardware counters, privilege, and workload timing.
OProfile therefore keeps the reusable parts testable and the system behavior
documented/manual.

## 13. Reuse Decisions

The project reuses code when the abstraction is stable across tools:

- `libdb` for sample database storage;
- `libop` for OProfile-specific parsing and CPU/event logic;
- `libutil` and `libutil++` for common utility code;
- `libpp` for profile post-processing data structures.

It avoids over-reuse where phases differ:

- collection code uses low-level syscalls and mmap directly;
- reporting code uses C++ containers and exceptions;
- event descriptions remain data files instead of being compiled into C;
- kernel perf interaction is isolated in `libperf_events`.

The rule is:

> Reuse data formats and shared domain logic; keep hot-path kernel interaction
> simple and local.

## 14. Coding Style Lessons

`doc/CodingStyle` is unusually explicit about reuse:

- keep files and headers focused;
- use forward declarations to reduce include dependencies;
- move general routines to `libop`, `libutil++`, etc.;
- avoid complex conditionals through helper functions;
- prefer configure/build mechanisms over heavy `#ifdef` use;
- comments should explain the unexpected, not restate the code;
- preserve old compiler compatibility;
- avoid bashisms in scripts because BusyBox-like environments matter.

For C specifically:

- use small helpers for parsing;
- define file formats with explicit integer-sized types;
- use indexes instead of pointers in mmaped file structures;
- check syscall return values and handle `EINTR`;
- keep hot paths allocation-light;
- document memory-order assumptions.

## 15. Abstract Example Inspired By OProfile

A profiler-like system can copy this shape:

```text
collector
  parse configuration
  open kernel/event fds
  mmap buffers
  write compact records

database library
  stable file format
  append/update by key
  expose iteration

post processor
  read compact records
  resolve expensive metadata
  aggregate and format reports
```

Minimal mmap database pattern:

```c
int add_sample(struct db *db, uint64_t key, unsigned delta)
{
	struct node *n;
	unsigned slot;

	if (db->used == db->capacity && grow_db(db) != 0)
		return -1;

	slot = db->used;
	n = &db->nodes[slot];
	n->key = key;
	n->value = delta;
	n->next = db->buckets[hash(key)];
	db->buckets[hash(key)] = slot;

	/* Publish only after initialization. */
	db->used++;
	return 0;
}
```

## 16. What To Learn

OProfile's good practice is pipeline discipline:

- do minimum work in the measurement path;
- represent sample data in compact structures;
- keep file formats explicit and versionable;
- move expensive symbol and report logic offline;
- centralize event parsing and CPU knowledge;
- keep utilities reusable but avoid abstracting away kernel IO realities;
- write tests for deterministic libraries even if the full profiler is
  hardware-dependent.

