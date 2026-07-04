# Linux Kernel Core Architecture Study

This note studies the core Linux kernel as an architectural process, not as an
attempt to summarize every subsystem.  The kernel is too large for one document
to be exhaustive.  The useful study target is how Linux organizes complexity:
subsystems own their domains, common mechanisms are aggressively reused, APIs
encode lifetime and context rules, and dangers are handled through layered
defenses such as locking rules, RCU, reference counting, `copy_from_user`,
error-pointer conventions, sanitizers, tracepoints, and subsystem tests.

The files and docs I used most heavily:

- `README`
- `Documentation/process/coding-style.rst`
- `Documentation/process/submitting-patches.rst`
- `Documentation/core-api/printk-basics.rst`
- `Documentation/trace/events.rst`
- `Documentation/locking/lockdep-design.rst`
- `Documentation/dev-tools/kselftest.rst`
- `init/main.c`
- `kernel/fork.c`
- `include/linux/err.h`
- `include/linux/list.h`
- representative subsystem layout under `kernel/`, `mm/`, `fs/`, `net/`,
  `block/`, `security/`, `drivers/`, `arch/`, and `tools/testing/selftests/`.

## 1. What The Core Kernel Is Optimizing For

The kernel must:

- abstract hardware while preserving performance;
- expose stable userspace ABI;
- let subsystems evolve independently;
- support many architectures;
- survive hostile userspace input and faulty hardware;
- run in contexts where sleeping, allocation, or blocking may be illegal;
- provide diagnostics for production systems;
- avoid regressions across enormous configuration space.

The architecture is therefore less "one grand design" and more a collection of
strict local contracts.

## 2. Top-Level Shape

Major directories:

- `arch/`: architecture-specific boot, syscall, MMU, interrupt, and low-level
  code.
- `init/`: boot sequence and initcall orchestration.
- `kernel/`: scheduler, fork/exit, signals, locking, time, cgroups, tracing,
  workqueues, modules, and core process infrastructure.
- `mm/`: physical and virtual memory management, page allocator, reclaim,
  slab, page tables, mmap, and faults.
- `fs/`: VFS, filesystems, path lookup, file descriptors, inode/dentry layers.
- `net/`: networking stack.
- `block/`: block layer and IO scheduling.
- `ipc/`: SysV/POSIX IPC.
- `security/`: LSM, keys, integrity, and security hooks.
- `drivers/`: hardware drivers and bus subsystems.
- `include/linux/`: core internal APIs.
- `include/uapi/`: userspace ABI headers.
- `Documentation/`: process, APIs, admin, subsystem, and tooling docs.
- `tools/testing/selftests/`: userspace regression tests for kernel behavior.

The split is both technical and social.  Subsystems have maintainers,
mailing lists, documentation, and local conventions.

## 3. Boot Architecture

`init/main.c` is the boot coordinator.  It initializes enough infrastructure
to move from early architecture setup into normal kernel execution:

- command-line parsing;
- early params and setup handlers;
- console/loglevel setup;
- memory and scheduler initialization;
- interrupt and time setup;
- RCU and workqueue setup;
- initcalls;
- creation of kernel threads;
- transition to the first userspace init process.

The file shows an important kernel pattern: boot is a staged state machine.
Some APIs are legal only after their subsystem has initialized.  Globals such
as `early_boot_irqs_disabled` and `system_state` make that phase visible.

## 4. Process Creation As Cross-Subsystem Composition

`kernel/fork.c` demonstrates how a core operation composes many subsystems.
Fork touches:

- task structures;
- scheduler state;
- memory management;
- file descriptor tables;
- filesystem context;
- namespaces;
- cgroups;
- credentials and security hooks;
- futexes;
- perf events;
- ptrace;
- audit;
- signals;
- IO accounting;
- RCU;
- stack allocation and hardening.

The file includes headers from across the kernel because creating a task is a
cross-cutting operation.  The architecture manages this with helper functions,
subsystem hooks, reference counting, and careful unwind paths on failure.

## 5. API Control: Userspace ABI Vs Internal API

Linux treats userspace ABI as extremely stable.  Headers under `include/uapi`
and syscall behavior cannot be casually changed.  Internal APIs under
`include/linux` can evolve, but they still encode strict contracts.

Examples:

- syscalls return negative `errno` values;
- pointer-returning internal functions may use `ERR_PTR`;
- VFS uses operation tables such as file, inode, dentry, and superblock ops;
- drivers register bus/device/driver objects with typed callbacks;
- networking uses `net_device` and protocol operation tables;
- memory allocators require flags such as `GFP_KERNEL` or `GFP_ATOMIC` that
  encode context constraints.

The lesson is:

> The kernel API is not only function signatures.  It is also caller context,
> locking state, lifetime ownership, reference rules, and whether sleeping is
> allowed.

## 6. Error Handling: errno And Error Pointers

`include/linux/err.h` defines a widely used convention: encode small negative
error numbers into pointer values.

Core helpers:

- `ERR_PTR(error)`: convert negative error code to pointer.
- `IS_ERR(ptr)`: test for encoded error.
- `PTR_ERR(ptr)`: extract error code.
- `IS_ERR_OR_NULL(ptr)`: handle both null and encoded error.
- `PTR_ERR_OR_ZERO(ptr)`: return error code or zero.

Example:

```c
struct foo *foo = foo_lookup(id);

if (IS_ERR(foo))
	return PTR_ERR(foo);

return use_foo(foo);
```

This convention avoids out-parameters and keeps pointer-returning APIs compact.
The danger is misuse, so the helpers are marked `__must_check` where possible.

## 7. Reuse In C: Intrusive Lists

`include/linux/list.h` is a model of kernel C reuse.  It implements circular
doubly linked intrusive lists with `struct list_head`.

Instead of allocating generic list nodes, objects embed list nodes:

```c
struct task_group {
	struct list_head children;
	struct list_head sibling;
};
```

The helper API handles initialization, insertion, deletion, iteration, and
special memory-order variants.  With hardening enabled, list operations perform
integrity checks and report corruption.

This design is reusable without dynamic allocation, type erasure, or runtime
polymorphism.  It is idiomatic kernel C:

- embed small generic mechanism in domain objects;
- recover containing object with `container_of`;
- make common operations inline;
- add debug/hardening checks under configuration.

## 8. Handling Dangerous Userspace Access

The kernel must treat userspace pointers as untrusted.  It does not directly
dereference them.  Instead, code uses APIs such as:

- `copy_from_user`;
- `copy_to_user`;
- `get_user`;
- `put_user`;
- hardened usercopy checks;
- access_ok-style validation where appropriate.

This is conceptually similar to OpenSSH's checked buffer parsing: dangerous
input crosses through explicit gates.  The difference is that here the danger
is page faults, malicious pointers, kernel memory disclosure, and ABI
compatibility.

## 9. Locking, Context, And Lockdep

Linux has many synchronization primitives:

- spinlocks;
- mutexes;
- rwsems;
- seqlocks;
- completions;
- atomics;
- RCU;
- percpu variables;
- refcounts;
- wait queues.

`Documentation/locking/lockdep-design.rst` explains lockdep's model.  Lockdep
does not only track lock instances.  It tracks lock classes, usage states, and
dependencies between classes.  It detects:

- recursive locking on the same class;
- lock order inversions;
- hardirq/softirq unsafe combinations;
- dependency cycles.

This is a major danger-handling pattern:

> The kernel turns a class of concurrency bugs into runtime-checkable graph
> invariants in debug configurations.

## 10. RCU And Lifetime

RCU is one of the kernel's main read-mostly concurrency mechanisms.  The
architectural idea:

- readers run cheaply inside RCU read-side critical sections;
- updaters publish new versions;
- old versions are freed only after a grace period, when pre-existing readers
  are gone.

RCU is not just a lock replacement.  It is a lifetime discipline.  Code that
uses RCU must make pointer publication, dereference, update, and freeing rules
explicit.

This same lifetime mentality appears throughout the kernel:

- `kref`/`refcount_t` for object references;
- `get_*`/`put_*` naming;
- `devm_*` managed resources for drivers;
- RCU callbacks for deferred freeing;
- module reference counts.

## 11. Memory Allocation Context

Kernel allocation APIs encode whether sleeping/reclaim is allowed:

- `GFP_KERNEL`: normal process context, may sleep.
- `GFP_ATOMIC`: atomic/interrupt context, must not sleep.
- `__GFP_*` flags: fine-grained behavior.

This is API control through flags.  The caller must know its context.  Passing
the wrong flag can deadlock or fail under pressure.

The architecture does not hide this because hiding it would be dangerous.
Instead it teaches every subsystem to propagate context constraints.

## 12. Observability

Linux has layered observability:

- `printk` and `pr_*` logging macros;
- ring buffer exposed through `/dev/kmsg` and `dmesg`;
- dynamic debug;
- tracepoints;
- ftrace;
- perf events;
- eBPF;
- kprobes/uprobes;
- `/proc`, `/sys`, and debugfs;
- lockdep reports;
- KASAN/KMSAN/KCSAN/KFENCE;
- WARN/BUG splats;
- subsystem-specific stats.

`Documentation/core-api/printk-basics.rst` shows mature logging guidance:

- messages have log levels;
- `pr_*` macros are preferred in many cases;
- hot paths should use rate-limited or one-time logging;
- excessive synchronous console printing can cause lockups;
- trace events are preferred for permanent hot-path observability.

`Documentation/trace/events.rst` shows how tracepoints become structured
events available through `/sys/kernel/tracing`.  Tracepoints are better than
ad hoc logs for high-frequency paths because they can be enabled, filtered,
and consumed by tools.

## 13. Testing Strategy

Linux testing is necessarily layered:

- KUnit for in-kernel unit tests;
- kselftest for userspace tests of kernel behavior;
- subsystem-specific tests;
- syzkaller fuzzing compatibility;
- static analysis such as sparse/smatch;
- sanitizers such as KASAN, KCSAN, KMSAN, UBSAN;
- lockdep and debug configs;
- boot tests across architectures/configurations.

`Documentation/dev-tools/kselftest.rst` emphasizes:

- tests should be small and target individual code paths;
- tests may run on older kernels and should skip gracefully;
- root-only requirements should be handled carefully;
- output should conform to TAP;
- tests should not break builds across architectures;
- timeouts should be bounded.

The test architecture matches the kernel's reality: no single test type can
cover all behavior.

## 14. Coding Style As Architecture

Linux coding style is not just aesthetics.  It supports maintenance at scale:

- 8-column tabs make deep nesting visibly painful;
- avoid more than three indentation levels;
- keep functions short and focused;
- prefer simple expressions over clever ones;
- avoid splitting user-visible `printk` strings so messages are grepable;
- use explicit names and standard idioms;
- place braces consistently;
- avoid unnecessary abstraction when direct code is clearer.

The style's deeper rule is:

> Code should be readable by maintainers under pressure, during debugging, and
> across decades.

## 15. Reuse Decisions

Linux reuses mechanisms aggressively:

- intrusive lists;
- rbtrees and xarrays;
- ID allocators;
- workqueues;
- kthreads;
- completions and wait queues;
- refcounts and krefs;
- RCU;
- seq_file for `/proc` output;
- netlink;
- sysfs/kobjects;
- device model;
- VFS abstractions;
- tracepoints;
- error-pointer helpers.

It avoids over-reuse where hardware/subsystem reality differs:

- architecture code lives under `arch/`;
- drivers own device-specific behavior;
- filesystems implement operation tables rather than one generic filesystem;
- network protocols have distinct stacks;
- memory allocators and reclaim paths stay specialized;
- fast paths often use local optimized code with shared helper mechanisms.

The rule is:

> Reuse primitive mechanisms and subsystem contracts; do not erase domain
> differences that affect performance, locking, hardware, or ABI.

## 16. Example: A Kernel-Style Operation

An abstract kernel-style lookup function might use error pointers,
reference ownership, and context-specific allocation:

```c
struct thing *thing_get_by_id(unsigned long id)
{
	struct thing *t;

	rcu_read_lock();
	t = idr_find(&thing_idr, id);
	if (t && !refcount_inc_not_zero(&t->refcnt))
		t = NULL;
	rcu_read_unlock();

	if (!t)
		return ERR_PTR(-ENOENT);

	return t;
}

int thing_do(unsigned long id)
{
	struct thing *t;
	int ret;

	t = thing_get_by_id(id);
	if (IS_ERR(t))
		return PTR_ERR(t);

	ret = thing_operate(t);
	thing_put(t);
	return ret;
}
```

This illustrates common kernel API rules:

- lookup returns either a referenced object or an encoded error;
- RCU protects lookup lifetime;
- refcount pins the object after lookup;
- caller must put the reference;
- errors are negative `errno`.

## 17. Example: Observability Choice

Bad permanent hot-path practice:

```c
pr_info("packet received len=%u\n", len);
```

Better options:

```c
pr_debug_ratelimited("packet received len=%u\n", len);
```

or, for structured permanent diagnostics:

```c
trace_my_subsystem_packet(dev, len, status);
```

The tracepoint can be disabled by default, enabled at runtime, filtered, and
consumed by tracing tools.

## 18. How The Kernel Handles Failure

Common failure patterns:

- return negative `errno`;
- unwind acquired resources in reverse order;
- use `goto` labels for cleanup;
- encode pointer errors with `ERR_PTR`;
- use `WARN_ON` for recoverable invariant violations worth reporting;
- use `BUG_ON` only when continuing is impossible;
- use `panic` for system-wide unrecoverable states;
- isolate usercopy and hardware interaction behind checked APIs;
- add debug configs that catch misuse early.

Classic cleanup shape:

```c
ret = step1();
if (ret)
	return ret;

ret = step2();
if (ret)
	goto err_step2;

ret = step3();
if (ret)
	goto err_step3;

return 0;

err_step3:
	undo_step2();
err_step2:
	undo_step1();
	return ret;
```

This is not accidental style.  In C, explicit unwind paths are often clearer
and safer than trying to compress ownership into clever constructs.

## 19. What To Learn

The kernel's good practice is disciplined local contracts:

- every subsystem owns a domain and exposes narrow internal APIs;
- context rules are explicit: can sleep, cannot sleep, IRQ, RCU, lock held;
- lifetime is managed through references, RCU, and ownership naming;
- userspace data crosses checked accessors;
- errors use standard negative `errno` and error-pointer idioms;
- observability is layered from `printk` to tracepoints to sanitizers;
- reuse focuses on primitive mechanisms, not fake generic subsystems;
- tests and debug tools are part of architecture, not afterthoughts.

The architectural process to learn is:

1. Define the subsystem boundary.
2. Define ownership and lifetime of every object crossing that boundary.
3. Define caller context rules.
4. Define error conventions.
5. Add observability that is safe for the path's frequency and context.
6. Add debug-time validators where humans cannot reliably reason about every
   interleaving.
7. Reuse kernel mechanisms when they match the domain; specialize when hardware,
   ABI, or locking rules require it.

