---
tags: Compiler
---

# Lua 5.5.0 Code Study

Lua is a good C case study because it is small enough to read end to end, but
large enough to show real engineering tradeoffs: a parser, compiler, virtual
machine, garbage collector, public C API, standard libraries, coroutines,
portable configuration, and robust error recovery.

This note is based on the local Lua 5.5.0 source tree. File names are relative
to the repository root.

## 1. Repository Shape

The repository is deliberately flat and readable.

- `src/` contains all runtime, compiler, VM, standard library, and tool code.
- `doc/` contains the manual, readme, CSS, images, and man pages.
- `Makefile` is the top-level build/install wrapper.
- `src/Makefile` builds `liblua.a`, `lua`, and `luac`.

Concrete example: `src/Makefile` divides object files into clear groups:

```make
CORE_O= lapi.o lcode.o lctype.o ldebug.o ldo.o ldump.o lfunc.o lgc.o llex.o lmem.o lobject.o lopcodes.o lparser.o lstate.o lstring.o ltable.o ltm.o lundump.o lvm.o lzio.o
LIB_O=  lauxlib.o lbaselib.o lcorolib.o ldblib.o liolib.o lmathlib.o loadlib.o loslib.o lstrlib.o ltablib.o lutf8lib.o linit.o
```

That split is useful to study. The core implements the language. The libraries
are ordinary C modules built on top of the public and auxiliary APIs.

## 2. Language Pipeline

Lua's language pipeline is:

1. Read bytes through a `lua_Reader`.
2. Wrap input in a buffered stream (`ZIO`).
3. Parse text chunks or undump binary chunks.
4. Produce a Lua closure containing a function prototype (`Proto`).
5. Execute bytecode in the VM.

Concrete example: `src/lapi.c` exposes this through `lua_load`:

```c
luaZ_init(L, &z, reader, data);
status = luaD_protectedparser(L, &z, chunkname, mode);
```

After parsing, `lua_load` also initializes the first upvalue, normally `_ENV`,
from the global table and applies a GC barrier:

```c
getGlobalTable(L, &gt);
setobj(L, f->upvals[0]->v.p, &gt);
luaC_barrier(L, f->upvals[0], &gt);
```

That is an important design point: loading code is not just parsing. It also
repairs runtime invariants before exposing the function to the caller.

### Text vs. Binary Chunks

The parser dispatcher is in `src/ldo.c`, function `f_parser`.

```c
int c = zgetc(p->z);
if (c == LUA_SIGNATURE[0])
  cl = luaU_undump(L, p->z, p->name, fixed);
else
  cl = luaY_parser(L, p->z, &p->buff, &p->dyd, p->name, c);
```

This is a clean boundary:

- `lundump.c` loads precompiled binary chunks.
- `lparser.c`, `llex.c`, and `lcode.c` compile text source.
- Both routes produce an `LClosure`.

### Parser and Code Generator

The parser delays code generation decisions using expression descriptors.
`src/lparser.h` defines `expdesc`, which can describe constants, locals,
globals, indexed variables, jumps, calls, and varargs.

Concrete example:

```c
typedef struct expdesc {
  expkind k;
  union {
    lua_Integer ival;
    lua_Number nval;
    TString *strval;
    int info;
    struct {
      short idx;
      lu_byte t;
      lu_byte ro;
      int keystr;
    } ind;
  } u;
  int t;
  int f;
} expdesc;
```

The `t` and `f` jump lists are especially instructive: boolean expressions are
not forced into values too early. Short-circuit operators can remain as pending
control-flow patches until the compiler knows the final context.

### Bytecode Format

`src/lopcodes.h` documents the instruction layout with a bit diagram. Lua uses
32-bit instructions with several compact formats:

```text
iABC    C(8) | B(8) | k | A(8) | Op(7)
iABx          Bx(17)    | A(8) | Op(7)
isJ           sJ(25)           | Op(7)
```

This is a good example of making a low-level binary format explicit. The
comment documents assumptions, field sizes, signed encodings, and limits before
the macros implement them.

### VM Dispatch

The interpreter loop is in `src/lvm.c`, function `luaV_execute`.

```c
for (;;) {
  Instruction i;
  vmfetch();
  vmdispatch (GET_OPCODE(i)) {
    vmcase(OP_MOVE) {
      StkId ra = RA(i);
      setobjs2s(L, ra, RB(i));
      vmbreak;
    }
```

The VM is explicit and mechanical:

- Fetch one instruction.
- Decode opcode and operands with macros.
- Operate on stack slots.
- Preserve GC and debug-hook invariants.

The macros make the dispatch portable. Depending on configuration, Lua can use a
switch dispatch or a jump table.

## 3. Public API Design

Lua's C API is one of its strongest engineering features. It is stack-based,
small, stable, and hides internal object layouts.

### Opaque State

`src/lua.h` exposes `lua_State` only as an incomplete type:

```c
typedef struct lua_State lua_State;
```

Clients can hold a pointer but cannot inspect internals. That gives Lua freedom
to change `struct lua_State` in `src/lstate.h` without breaking source-level API
users.

### Stack as the API Boundary

Most API calls push, read, or modify values on a virtual stack:

```c
lua_pushinteger(L, 10);
lua_getfield(L, idx, "name");
lua_pcall(L, nargs, nresults, errfunc);
```

In `src/lua.h`, the API is grouped by behavior:

- stack manipulation
- access functions
- push functions
- get functions
- set functions
- load/call functions
- coroutine functions
- GC functions
- debug API

That organization makes the API easier to learn and maintain.

### Positive, Negative, and Pseudo-Indices

`src/lapi.c` turns public stack indices into internal value pointers with
`index2value`.

Concrete behavior:

- Positive index: relative to the current function frame.
- Negative index: relative to the top of the stack.
- `LUA_REGISTRYINDEX`: the registry.
- `lua_upvalueindex(i)`: C closure upvalues.

The code handles all cases in one place:

```c
if (idx > 0) {
  StkId o = ci->func.p + idx;
  if (o >= L->top.p) return &G(L)->nilvalue;
  else return s2v(o);
}
else if (!ispseudo(idx)) {
  return s2v(L->top.p + idx);
}
else if (idx == LUA_REGISTRYINDEX)
  return &G(L)->l_registry;
else {
  idx = LUA_REGISTRYINDEX - idx;
  if (ttisCclosure(s2v(ci->func.p))) {
    CClosure *func = clCvalue(s2v(ci->func.p));
    return (idx <= func->nupvalues) ? &func->upvalue[idx-1]
                                    : &G(L)->nilvalue;
  }
  else
    return &G(L)->nilvalue;
}
```

Centralizing this conversion reduces API bugs. Most public functions do not
reimplement index logic.

### API Checks and Internal Invariants

`src/lapi.h` defines `api_check`, `api_checkpop`, and `api_checknelems`.

Concrete example:

```c
#define api_checkpop(L,n) \
  api_check(L, (n) < L->top.p - L->ci->func.p && \
               L->tbclist.p < L->top.p - (n), \
               "not enough free elements in the stack")
```

This shows a pattern worth copying: a public API should validate not just
obvious inputs, but also hidden invariants. Here, popping values must not cross
to-be-closed variables.

### Auxiliary Library as API Ergonomics

The core API stays primitive. Higher-level conveniences live in `lauxlib`.

Concrete example: `src/lauxlib.h` provides helpers such as:

```c
luaL_checkinteger
luaL_checklstring
luaL_newmetatable
luaL_loadfilex
luaL_error
luaL_ref
```

This keeps the core API small while still giving library authors productive
tools.

## 4. Error Handling

Lua has two levels of error handling:

- Public protected calls return status codes.
- Internal failures use non-local jumps.

### Protected Public Boundary

`lua_pcallk` in `src/lapi.c` is the public protected-call entry point.

Concrete example:

```c
status = luaD_pcall(L, f_call, &c, savestack(L, c.func), func);
adjustresults(L, nresults);
lua_unlock(L);
return APIstatus(status);
```

The caller sees a simple integer status such as `LUA_OK`, `LUA_ERRRUN`, or
`LUA_ERRMEM`. Internally, Lua can unwind deeply nested calls without manually
threading error returns through every function.

### Non-Local Internal Error Path

`src/ldo.c` implements the internal throw/catch machinery. `luaD_throw` checks
for a current error handler, jumps to it, or falls back to the main thread and
panic handler.

```c
if (L->errorJmp) {
  L->errorJmp->status = errcode;
  LUAI_THROW(L, L->errorJmp);
}
```

`luaD_rawrunprotected` installs a temporary handler:

```c
lj.previous = L->errorJmp;
L->errorJmp = &lj;
LUAI_TRY(L, &lj, f, ud);
L->errorJmp = lj.previous;
```

The engineering lesson: non-local exits are dangerous unless tightly
centralized. Lua keeps them in `ldo.c` and exposes status codes at API
boundaries.

### Error Messages with Context

`luaL_error` in `src/lauxlib.c` prepends source location information:

```c
luaL_where(L, 1);
lua_pushvfstring(L, fmt, argp);
lua_concat(L, 2);
return lua_error(L);
```

So library code can write:

```c
return luaL_error(L, "bad argument #%d", arg);
```

and users get contextual messages rather than raw internal failures.

### Stack Recovery After Errors

`luaD_pcall` in `src/ldo.c` saves old execution state and restores it after
failure:

```c
L->ci = old_ci;
L->allowhook = old_allowhooks;
status = luaD_closeprotected(L, old_top, status);
luaD_seterrorobj(L, status, restorestack(L, old_top));
luaD_shrinkstack(L);
```

This is graceful error handling in C: failing code unwinds, closes resources,
restores stack shape, installs an error object, and shrinks overflow-expanded
stacks.

## 5. Memory Management and GC

Lua uses an incremental/generational garbage collector. The interesting part is
not only the collector itself, but how ordinary code cooperates with it.

### Explicit Object Representation

`src/lobject.h` defines `TValue`, the fundamental tagged value:

```c
typedef struct TValue {
  Value value_;
  lu_byte tt_;
} TValue;
```

The tag encodes the base type, variant bits, and whether the value is
collectable. This makes runtime type tests cheap and local.

### Allocation Triggers Collection

`src/lgc.h` defines `luaC_checkGC`:

```c
#define luaC_checkGC(L) luaC_condGC(L,(void)0,(void)0)
```

API functions call it after allocations. For example, string-pushing functions
in `src/lapi.c` call `luaC_checkGC(L)` after creating values.

The lesson: collection points are explicit, visible, and close to allocation
sites.

### Write Barriers Preserve Collector Invariants

Lua uses write barriers whenever an old or black object starts pointing to a
young or white collectable object.

`src/lgc.h`:

```c
#define luaC_barrier(L,p,v) \
  (iscollectable(v) ? luaC_objbarrier(L,p,gcvalue(v)) : cast_void(0))
```

`src/lapi.c`, raw table set:

```c
luaH_set(L, t, key, s2v(L->top.p - 1));
invalidateTMcache(t);
luaC_barrierback(L, obj2gco(t), s2v(L->top.p - 1));
```

This is a central GC lesson: the collector is not isolated in `lgc.c`. Mutating
code must participate in the memory model.

### Forward and Backward Barriers

`src/lgc.c` distinguishes two strategies:

- `luaC_barrier_`: mark the newly referenced object or age it.
- `luaC_barrierback_`: put the container back into `grayagain`.

Concrete example:

```c
reallymarkobject(g, v);
linkobjgclist(o, g->grayagain);
```

This is a performance tradeoff. Some objects are better handled by marking the
new child immediately. Tables often use a backward barrier because they may be
mutated repeatedly.

### Tables Separate Fast Path and Correctness Path

`src/ltable.c`, `luaH_psetshortstr`, optimizes common constructor writes:

```c
if (!ttisnil(slot)) {
  setobj(((lua_State*)NULL), cast(TValue*, slot), val);
  return HOK;
}
```

But if the operation might need a metamethod, a barrier, or a rehash, it returns
an encoded result for the slower caller:

```c
return retpsetcode(t, slot);
```

This is a recurring Lua pattern: make the common path tiny, but never hide the
cases where correctness requires a slower path.

## 6. Concurrency, Coroutines, and Signals

Lua is not internally preemptively multithreaded. Instead, it offers:

- independent Lua states
- coroutines as cooperative threads
- optional host-provided locking hooks
- careful signal interruption in the standalone interpreter

### Optional Lock Hooks

`src/lapi.h` defines default no-op locks:

```c
#if !defined(lua_lock)
#define lua_lock(L)   ((void) 0)
#define lua_unlock(L) ((void) 0)
#endif
```

Public API functions call `lua_lock` and `lua_unlock`, but Lua does not impose a
threading implementation. An embedding application can define these macros to
integrate with its own lock policy.

The lesson: Lua makes concurrency policy embeddable instead of pretending one
global policy fits all hosts.

### Coroutines Are Controlled by Yieldability

`src/lstate.h` stores two counters in one `nCcalls` field:

```c
/* lower 16 bits: recursive C calls
   higher 16 bits: non-yieldable calls */
#define yieldable(L) (((L)->nCcalls & 0xffff0000) == 0)
```

`src/ldo.c` uses this when making calls:

```c
void luaD_call (lua_State *L, StkId func, int nResults) {
  ccall(L, func, nResults, 1);
}

void luaD_callnoyield (lua_State *L, StkId func, int nResults) {
  ccall(L, func, nResults, nyci);
}
```

This is a compact way to prevent yields across unsafe C boundaries.

### Signal Handling Avoids Unsafe State Mutation

The standalone interpreter handles `SIGINT` in `src/lua.c`.

The signal handler does not directly mutate arbitrary interpreter state.
Instead, it installs a hook:

```c
lua_sethook(globalL, lstop, flag, 1);
```

The hook later runs in a safer interpreter context and raises:

```c
luaL_error(L, "interrupted!");
```

The comment in `lua.c` is the key engineering idea: a C signal cannot safely
change a Lua state directly, so interruption is deferred through the debug hook
mechanism.

## 7. Portability and Configuration

Lua is portable because portability is designed into the code, not patched on at
the edges.

### Central Configuration

`src/luaconf.h` controls:

- C89/POSIX/Windows feature selection
- integer and float representation
- package paths
- symbol visibility
- buffer sizes and limits

Concrete example:

```c
#define LUA_INT_DEFAULT   LUA_INT_LONGLONG
#define LUA_FLOAT_DEFAULT LUA_FLOAT_DOUBLE
```

Changing numeric types is an ABI decision, so Lua centralizes it in the
configuration header.

### Portability Macros

`src/llimits.h` defines casts and platform-sensitive helpers:

```c
#define cast_int(i)   cast(int, (i))
#define cast_sizet(i) cast(size_t, (i))
```

This style may look verbose, but it makes intentional casts searchable and
auditable. In a C codebase that cares about many compilers, that is valuable.

### Explicit Non-Portable Assumptions

Lua documents where it relies on common but not strictly ISO C behavior.

Example from `src/llimits.h`: pointer-to-integer conversion is used for hashing,
with comments explaining the limitation. Example from `src/ldo.c`: stack
reallocation has a `LUAI_STRICT_ADDRESS` option because using pointers after
reallocation is undefined behavior in ISO C.

The lesson: when portability is imperfect, document the assumption and isolate
it behind a macro.

## 8. Defensive Limits and Abuse Resistance

Lua contains many small defensive checks against overflow, recursion abuse,
pathological tables, and version mismatches.

### C Stack Overflow

`src/lstate.c` checks recursive C call depth:

```c
if (getCcalls(L) == LUAI_MAXCCALLS)
  luaG_runerror(L, "C stack overflow");
```

`src/ldo.c` also checks during calls and resumes.

### Lua Stack Limits

`src/ldo.c` defines `MAXSTACK` as the minimum of a logical Lua limit and what
`size_t` can represent:

```c
#define MAXSTACK cast_int(LUAI_MAXSTACK < MAXSTACK_BYSIZET \
                          ? LUAI_MAXSTACK : MAXSTACK_BYSIZET)
```

This is a good pattern: validate limits against both language semantics and C
representation limits.

### Hash and Length Hardening

`src/ltable.c`, `hash_search`, randomizes the first probe when searching for a
table boundary:

```c
unsigned rnd = G(L)->seed;
```

The nearby comment explains the threat: with a fixed probing sequence, a bad
actor could construct keys that make `#t` expensive for small tables.

### ABI Compatibility Checks

`src/lauxlib.c`, `luaL_checkversion_`, verifies that a library was built against
compatible Lua numeric settings:

```c
if (sz != LUAL_NUMSIZES)
  luaL_error(L, "core and library have incompatible numeric types");
else if (v != ver)
  luaL_error(L, "version mismatch: app. needs %f, Lua core provides %f",
                  (LUAI_UACNUMBER)ver, (LUAI_UACNUMBER)v);
```

This catches subtle embedding mistakes early.

## 9. Programming Style

Lua's style is compact, but not casual. It relies heavily on naming, comments,
assertions, and local invariants.

### Prefixes Communicate Ownership

Common prefixes:

- `lua_*`: public C API.
- `luaL_*`: auxiliary library API.
- `luaD_*`: call stack, protected calls, execution control.
- `luaV_*`: VM operations.
- `luaC_*`: garbage collector.
- `luaH_*`: tables.
- `luaS_*`: strings.
- `luaF_*`: functions, closures, upvalues.
- `luaY_*`: parser.
- `luaX_*`: lexer.
- `luaK_*`: code generator.

That naming system makes cross-file navigation practical in plain C.

### Comments Explain Invariants, Not Obvious Code

Good examples:

- `src/lstate.h` explains GC object lists and generational ages.
- `src/lopcodes.h` explains bytecode bit layouts.
- `src/ltable.c` explains table resizing failure cases.
- `src/ldo.c` explains stack reallocation and pointer invalidation.

The comments are usually about why a rule exists, not merely what a line does.

### Assertions Are Used as Internal Documentation

Lua uses `lua_assert`, `lua_longassert`, and `api_check`.

Concrete example from `luaV_execute`:

```c
lua_assert(base == ci->func.p + 1);
lua_assert(base <= L->top.p && L->top.p <= L->stack_last.p);
```

These assertions document what must be true at every VM instruction.

### Small Public Functions, Deep Internal Helpers

Many public functions are thin wrappers. For example, `lua_load` sets up a
`ZIO`, calls `luaD_protectedparser`, fixes `_ENV`, and returns a status.

The complex work lives in internal modules:

- parsing in `lparser.c`
- code generation in `lcode.c`
- protected execution in `ldo.c`
- bytecode execution in `lvm.c`

This keeps the public API stable and understandable.

## 10. Resource Safety

Lua often anticipates failure in the middle of mutation.

### Table Resize Preserves Old State on Allocation Failure

`src/ltable.c`, `luaH_resize`, has detailed comments describing a two-phase
resize. It creates a new hash part, temporarily exchanges hash parts, then
restores the old hash if array reallocation fails.

The key idea is transactional mutation: do not destroy the old representation
until the new representation is safely installed.

### To-Be-Closed Variables

Lua's stack logic knows about to-be-closed variables. In `lua_settop`, if a pop
would cross a to-be-closed slot, it calls:

```c
newtop = luaF_close(L, newtop, CLOSEKTOP, 0);
```

That means ordinary stack manipulation respects language-level resource
cleanup. This is the kind of detail that prevents subtle leaks.

### Panic Is a Last Resort

If an error reaches `luaD_throw` without any protected boundary, Lua calls the
panic function if one exists, then aborts.

```c
if (g->panic) {
  lua_unlock(L);
  g->panic(L);
}
abort();
```

This preserves a clear contract: recoverable errors must be inside protected
calls. Unprotected errors are fatal unless the host panic handler escapes.

## 11. Standard Library Architecture

The standard libraries are normal C modules that register functions into Lua.

`src/linit.c` lists libraries in a table:

```c
static const luaL_Reg stdlibs[] = {
  {LUA_GNAME, luaopen_base},
  {LUA_LOADLIBNAME, luaopen_package},
  {LUA_COLIBNAME, luaopen_coroutine},
  {LUA_DBLIBNAME, luaopen_debug},
  {LUA_IOLIBNAME, luaopen_io},
  {LUA_MATHLIBNAME, luaopen_math},
  {LUA_OSLIBNAME, luaopen_os},
  {LUA_STRLIBNAME, luaopen_string},
  {LUA_TABLIBNAME, luaopen_table},
  {LUA_UTF8LIBNAME, luaopen_utf8},
  {NULL, NULL}
};
```

`luaL_openselectedlibs` can load or preload selected libraries using bit masks.

This is a clean plugin-like pattern in C:

- each library exposes `luaopen_*`
- the initializer stores names and open functions in data
- policy is handled by the initializer, not duplicated across libraries

## 12. Build System

Lua's build is intentionally simple. The top-level `Makefile` delegates to
`src/Makefile`.

Concrete examples:

- `make linux` builds with `-DLUA_USE_LINUX` and links `-ldl`.
- `make generic` builds without platform-specific extras.
- `make test` runs `./lua -v`.

There is no generated configuration system in this source release. Instead,
platform policy is expressed through make variables and `luaconf.h`.

The tradeoff is clear: fewer moving parts, but configuration is manual compared
with Autotools/CMake projects.

## 13. What To Study First

A good reading order:

1. `lua.h`, `lauxlib.h`, `lualib.h`: public surface.
2. `lua.c`: how an embedding application uses the API.
3. `lapi.c`: how public operations map to internals.
4. `lobject.h`, `lstate.h`: runtime representation.
5. `llex.c`, `lparser.c`, `lcode.c`: source to bytecode.
6. `lopcodes.h`, `lvm.c`: bytecode format and execution.
7. `ldo.c`: calls, protected calls, yields, stack handling.
8. `lgc.h`, `lgc.c`: memory management and barriers.
9. `ltable.c`, `lstring.c`: core data structures.
10. Standard libraries such as `lstrlib.c`, `ltablib.c`, and `lmathlib.c`.

## 14. Engineering Lessons

1. Keep the public API small and opaque.
   Concrete example: `lua_State` is incomplete in `lua.h`; users manipulate
   values through stack operations.

2. Centralize dangerous mechanisms.
   Concrete example: non-local error jumps are concentrated in `ldo.c`, while
   public callers receive status codes.

3. Make invariants explicit.
   Concrete example: GC barriers in `lgc.h` are called at mutation sites such
   as `lua_rawset`.

4. Separate fast paths from completion paths.
   Concrete example: `luaH_psetshortstr` handles common table updates quickly
   but returns encoded states when metamethods, barriers, or rehashing are
   required.

5. Treat portability as architecture.
   Concrete example: `luaconf.h` and `llimits.h` isolate platform and ABI
   choices.

6. Use comments to explain hard invariants.
   Concrete example: `lopcodes.h` documents bit layouts before defining
   instruction macros.

7. Embedder policy should be configurable.
   Concrete example: `lua_lock` and `lua_unlock` are no-ops unless the host
   defines them.

8. Recover from errors by restoring state, not just returning an error.
   Concrete example: `luaD_pcall` restores call info, closes variables, sets
   the error object, and shrinks the stack after failures.

9. Keep modules small enough to understand.
   Concrete example: the parser, VM, GC, API, tables, strings, and libraries are
   separate files with clear prefixes.

10. Prefer data-driven registration.
    Concrete example: `linit.c` registers standard libraries from a `luaL_Reg`
    array instead of hard-coding each library in separate control flow.

## 15. Questions To Keep Asking While Reading

- What invariant is this function preserving?
- Is this public API, auxiliary API, or internal runtime code?
- Does this mutation need a GC barrier?
- Can this function allocate, and what happens if allocation fails?
- Can this function yield?
- Is the stack shape restored on error?
- Is this fast path allowed to skip metamethods, or must it fall back?
- Is this behavior part of Lua semantics or only an implementation detail?

These questions match the way Lua is written. Most difficult parts of the code
are difficult because they preserve several invariants at once: stack shape,
debug hooks, coroutines, GC color/age, metatables, and API compatibility.
