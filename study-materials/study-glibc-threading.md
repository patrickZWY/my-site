# glibc Threading Implementation Study

This note studies glibc's NPTL threading implementation, not all of glibc.
NPTL is a useful architecture study because it sits between POSIX APIs,
application ABI, Linux `clone`, futexes, thread-local storage, cancellation,
debuggers, signals, and robust mutex rules.  Its central lesson is that a
threading library is mostly contract engineering: every field, atomic operation,
and syscall wrapper exists to preserve semantics across user code, the kernel,
and debugging tools.

The files I used most heavily:

- `README`
- `nptl/descr.h`
- `sysdeps/nptl/pthreadP.h`
- `nptl/pthread_create.c`
- `nptl/pthread_join_common.c`
- `nptl/pthread_mutex_lock.c`
- `nptl/pthread_cond_wait.c`
- `nptl/pthread_cancel.c`
- `sysdeps/nptl/futex-internal.h`
- `nptl/Makefile`
- `manual/probes.texi`

## 1. What This Code Is Optimizing For

NPTL must implement POSIX threading while preserving glibc ABI compatibility.
It optimizes for:

- very fast uncontended synchronization;
- correct behavior under races, cancellation, signals, process-shared objects,
  robust mutex owner death, and thread exit;
- stable public ABI despite internal changes;
- architecture-specific TLS/TCB layouts;
- low overhead in common paths;
- debuggability through `libthread_db` and probes;
- compatibility with Linux kernel futex and `clone` behavior.

This is not a "nice wrapper around syscalls".  It is a shared-memory protocol
between user space and the kernel.

## 2. Top-Level Shape Of NPTL

Important areas:

- `nptl/`: POSIX pthread functions and core NPTL runtime.
- `sysdeps/nptl/`: internal pthread definitions and architecture/system
  dependent pieces.
- `nptl_db/`: debugger support through thread database interfaces.
- `sysdeps/unix/sysv/linux/*`: Linux-specific syscall and low-level lock
  implementations.
- `nptl/Makefile`: shows the pthread routines and extensive test lists.

The public API is `pthread_*`, but the real internal API is:

- `struct pthread` thread descriptor;
- futex wrappers;
- low-level locks;
- cancellation state bits;
- robust mutex list;
- join state;
- thread-local storage and TCB layout;
- hidden/internal symbols and symbol versioning.

## 3. Thread Descriptor As The Core Object

`nptl/descr.h` defines `struct pthread`, the thread descriptor.  It overlaps
with the thread control block and TLS area on supported architectures.

It contains:

- thread ID and join state;
- cancellation state;
- result pointer;
- robust mutex list;
- thread-specific data;
- signal and setxid coordination fields;
- scheduler and affinity-related state;
- debugger event links;
- stack and guard metadata.

The descriptor is not just a C struct.  It is a contract:

- the kernel writes to some fields, such as clear-TID/join notification;
- glibc atomically reads/writes fields;
- debuggers inspect it through `libthread_db`;
- robust futex logic depends on exact list fields;
- architecture TLS layout constrains its placement.

## 4. pthread_create: Ownership Is The Main Invariant

`nptl/pthread_create.c` contains unusually detailed concurrency notes.  They
explain ownership of `struct pthread *pd`, because use-after-free of a thread
descriptor would be catastrophic.

The creating thread starts as owner of `pd`.  Ownership can move in four ways:

- to the process for a joinable thread after `pthread_create` succeeds;
- to the new thread for a detached thread;
- to a running thread via `pthread_detach`;
- to the joining thread via `pthread_join`.

Startup has special cases:

- a new thread may need to start stopped so the creator can apply scheduling or
  affinity attributes before user code runs;
- `pd->lock` acts first like a one-shot startup semaphore, then later like a
  normal mutex for thread attributes;
- if kernel thread creation fails before the thread runs, the creator still
  owns `pd`;
- if setup fails after the thread runs, ownership and cleanup require careful
  coordination.

The lesson:

> In concurrent C, memory ownership is an explicit state machine.  Comments
> that define the state machine are part of the implementation.

## 5. clone Flags Are The POSIX Contract

Thread creation relies on Linux `clone` flags:

- `CLONE_VM`: shared address space.
- `CLONE_FS`: shared filesystem info.
- `CLONE_FILES`: shared file descriptor table.
- `CLONE_SYSVSEM`: shared SysV semaphore adjustments.
- `CLONE_SIGHAND`: shared signal handlers.
- `CLONE_THREAD`: POSIX thread group semantics.
- `CLONE_SETTLS`: install TLS for the new thread.
- `CLONE_PARENT_SETTID`: write TID for parent-side setup.
- `CLONE_CHILD_CLEARTID`: clear TID and futex-wake on thread exit.

These flags are not incidental.  They map POSIX user-visible behavior to Linux
kernel primitives.

## 6. pthread_join: Kernel Exit Notification And Futex Waiting

`nptl/pthread_join_common.c` waits on `pd->joinstate` until it becomes
`THREAD_STATE_EXITED`.

Important behavior:

- validates timeout clock/nanoseconds;
- detects self-join deadlock when cancellation state allows it;
- returns `EINVAL` for detached threads if the descriptor is still visible;
- waits through futex on the join state;
- uses cancelable futex wait for join variants that are cancellation points;
- frees the TCB after successful join.

Abstracted pattern:

```c
while (atomic_load_acquire(&pd->joinstate) != THREAD_STATE_EXITED) {
	if (pd == self)
		return EDEADLK;
	if (state == THREAD_STATE_DETACHED)
		return EINVAL;
	futex_wait(&pd->joinstate, state);
}

*thread_return = pd->result;
free_thread_descriptor(pd);
```

The acquire load matters: thread exit publishes state that join must observe.

## 7. Futex Wrapper Design

`sysdeps/nptl/futex-internal.h` is one of the most important design files.
It defines internal futex operations and documents exactly which errors callers
must handle.

Key practices:

- futex words must be accessed atomically;
- private/shared futex mode is explicit;
- wrappers return errors that can happen in correct executions;
- wrappers abort on errors that indicate glibc bugs, application bugs, or
  unknown kernel behavior;
- wake operations tolerate some errors because POSIX permits synchronization
  objects to be destroyed/reused after no thread can validly wait on them, and
  futex wake may race with reuse/unmapping.

This is danger handling by contract.  Instead of scattering raw `syscall(SYS_futex)`
calls everywhere, NPTL centralizes the futex semantics.

## 8. Mutex Fast Paths And Slow Paths

`nptl/pthread_mutex_lock.c` separates the normal path from complicated mutex
types.

Fast path:

- normal private mutex can use a single-thread optimization;
- uncontended normal mutex avoids expensive kernel work;
- owner and user counts are recorded after acquisition;
- probes mark entry/acquire events.

Slow path handles:

- recursive mutexes;
- error-checking mutexes;
- adaptive mutexes with spinning/backoff/jitter;
- robust mutexes;
- priority inheritance/protection;
- process-shared mutexes;
- owner death.

Robust mutexes are especially instructive.  Before operating, the thread sets
`robust_head.list_op_pending`, uses compiler memory barriers, and only enqueues
after acquisition.  If the previous owner died, the new owner gets the mutex
but the state is marked inconsistent and `pthread_mutex_lock` returns
`EOWNERDEAD`.

The pattern is:

```text
try fast userspace CAS
if owner died:
  acquire with OWNER_DIED bit
  mark mutex inconsistent
  enqueue in robust list
  return EOWNERDEAD
if contended:
  set WAITERS bit
  futex wait
```

## 9. Condition Variables: Avoiding Fake FIFO Assumptions

`nptl/pthread_cond_wait.c` documents why condition variables are complex.

Futexes do not guarantee FIFO wake order, and a 32-bit futex word is not enough
to represent all waiter sequence states.  NPTL uses:

- a 64-bit waiter sequence;
- two waiter groups, G1 and G2;
- separate futex words per group;
- reference counts;
- cancellation cleanup that may send replacement signals;
- broadcast/signal semantics that respect the POSIX allowance for spurious
  wakeups.

The implementation explicitly avoids relying on wakeup ordering the kernel does
not provide.  This is a major best practice: do not build correctness on an
unstated property of a lower layer.

## 10. Cancellation

`nptl/pthread_cancel.c` shows cancellation as a state machine plus signal
delivery:

- cancellation state bits live in `pd->cancelhandling`;
- asynchronous cancellation uses `SIGCANCEL`;
- the signal handler verifies signal number, sender PID, and `SI_TKILL`;
- cancellation may be deferred until the target reaches a cancellation point;
- self-cancel must work even if no thread creation has installed the signal
  handler yet;
- shared builds require `libgcc_s` unwinding support for cancellation cleanup.

The code avoids sending `SIGCANCEL` when cancellation is disabled because some
syscalls are never restarted after signals.  That is a subtle API-danger
decision: a naive signal would create visible `EINTR` behavior outside POSIX
intent.

## 11. Error Handling Style

NPTL follows POSIX: pthread functions usually return an error number directly,
not `-1` with `errno`.

Examples:

- `pthread_join` returns `EINVAL`, `EDEADLK`, `ETIMEDOUT`, `EOVERFLOW`, or `0`.
- robust mutex lock can return `EOWNERDEAD`.
- recursive count overflow returns `EAGAIN`.
- futex wrappers return only documented recoverable errors and call
  `__libc_fatal` for impossible ones.

This is very different from application C code.  The library cannot casually
log and exit; it must return standardized errors unless an internal invariant
is broken.

## 12. Observability

glibc cannot use heavy logging in pthread primitives.  These functions are too
low-level and may run in unsafe contexts.  Instead it uses:

- SystemTap probes via `LIBC_PROBE`, such as mutex and pthread join probes;
- `libthread_db` data structures and events for debuggers;
- symbol versioning and hidden symbols for ABI control;
- fatal messages only for impossible internal failures;
- extensive test coverage rather than runtime logs.

`manual/probes.texi` explains that probes are nearly zero overhead and not
stable ABI.  That distinction matters: probes are observability hooks, not a
public compatibility promise.

## 13. Testing Strategy

`nptl/Makefile` lists a large set of routines and tests.  Threading tests must
cover:

- creation and join;
- detach behavior;
- mutex variants;
- condition variables;
- barriers;
- rwlocks;
- cancellation;
- semaphores;
- thread-specific data;
- scheduling and affinity;
- robust and process-shared synchronization;
- old symbol compatibility.

The test style is broad because the risk surface is broad.  Unit tests alone
are not enough for threading; races and ABI behavior need scenario tests.

## 14. Reuse Decisions

glibc reuses:

- futex wrappers for syscall semantics;
- low-level lock primitives;
- atomic helper APIs;
- internal pthread definitions in `pthreadP.h`;
- symbol-versioning machinery;
- sysdeps layout for architecture differences;
- cancellation/unwind helpers.

It does not over-reuse:

- architecture-specific TLS and clone setup stay in `sysdeps`;
- mutex, condvar, join, and cancellation have specialized implementations;
- public ABI structs are not casually refactored;
- hot paths avoid generic abstractions that would add overhead or hide memory
  ordering.

The rule is:

> Reuse the kernel-contract wrappers and internal state vocabulary; keep each
> synchronization primitive specialized enough to preserve its semantics.

## 15. C Practices Worth Copying

- Put detailed concurrency invariants next to the code that depends on them.
- Use explicit state bits and atomic operations.
- Separate fast paths from full slow paths.
- Wrap syscalls with semantic error contracts.
- Return standardized errors from library APIs.
- Treat memory ownership as a state machine.
- Do not rely on kernel behavior that is not guaranteed.
- Use compiler barriers and atomic memory orders deliberately.
- Keep architecture-dependent ABI layout in `sysdeps`.
- Make observability low overhead and non-invasive.

## 16. Abstract Example Inspired By NPTL

A small thread-like object with join ownership should have explicit states:

```c
enum join_state {
	JOINABLE,
	DETACHED,
	EXITED,
};

struct worker {
	atomic_uint state;
	void *result;
	unsigned int futex_word;
};

int worker_join(struct worker *w, void **result)
{
	unsigned int state;

	while ((state = atomic_load_explicit(&w->state,
	    memory_order_acquire)) != EXITED) {
		if (state == DETACHED)
			return EINVAL;
		futex_wait(&w->state, state);
	}

	if (result != NULL)
		*result = w->result;
	free_worker(w);
	return 0;
}
```

The important part is not the code itself.  The important part is publishing
exit state with an ordering guarantee and transferring final ownership to the
joiner.

## 17. What To Learn

glibc NPTL's good practice is contract precision:

- public POSIX APIs are thin surfaces over complex internal protocols;
- thread descriptors are shared with the kernel and debugger;
- futex behavior is centralized and documented;
- every synchronization primitive has a carefully separated fast and slow path;
- cancellation is handled as a state machine, not merely as a signal;
- observability uses probes/debugger interfaces rather than logging;
- ABI stability shapes the code as much as algorithmic design.

