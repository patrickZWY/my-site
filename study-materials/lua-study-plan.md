---
tags: Compiler · Beginner
---

### Beginner Roadmap

This plan assumes no previous experience with compiler or virtual-machine
design. The goal is to replace abstract names with small programs, diagrams,
and exact changes to Lua's runtime state.

#### What Kind of Program Is Lua?

Consider this Lua source:

~~~lua
local x = 41
return x + 1
~~~

The computer's processor cannot directly execute those characters. Lua handles
the program in two broad stages:

~~~text
Stage 1: compilation

source text
    ↓
Lua compiler
    ↓
Lua bytecode

Stage 2: execution

Lua bytecode
    ↓
Lua virtual machine
    ↓
result
~~~

Lua's compiler does not normally produce native x86 or ARM machine code. It
produces instructions for Lua's own imaginary processor: the Lua virtual
machine, or VM.

Conceptually, those instructions might say:

~~~text
put 41 in register 0
add 1 to register 0
return register 0
~~~

Those are not the exact Lua instructions, but they give us the right starting
picture. The codebase provides everything needed to represent values, compile
source, execute instructions, call functions, report errors, reclaim memory,
and communicate with C programs.

### Study Plan

#### 1. Values, the Stack, and Call Frames

Files: src/lobject.h, src/lstate.h, and selected parts of src/lapi.c.

We first learn how Lua represents values such as 42, “hello,” a table, or a
function. We then see where those values live while code runs and how Lua keeps
one function call separate from another.

#### 2. One Function Call From Beginning to End

Files: src/lapi.c, src/ldo.c, and src/lvm.c.

We follow a tiny function through the complete runtime path:

~~~text
lua_pcall
    ↓
luaD_pcall
    ↓
luaD_call
    ↓
luaD_precall
    ↓
luaV_execute
    ↓
luaD_poscall
~~~

This shows how Lua prepares arguments, creates a call frame, executes bytecode,
and returns results.

#### 3. Bytecode Execution

Files: src/lopcodes.h, src/lopcodes.c, src/lvm.c, and src/luac.c.

Bytecode is the smaller language understood by Lua's virtual machine. We learn
what an opcode is, what operands such as A, B, and C mean, and how a register
instruction such as ADD reads and writes stack slots.

#### 4. Tables and Metamethods

Files: src/ltable.c, src/ltable.h, src/ltm.c, and src/ltm.h.

Lua tables contain both an array part and a hash part. We study how keys are
found and then how metamethods such as __index, __add, and __call provide custom
behavior when the VM's normal fast operation does not apply.

#### 5. Closures, Upvalues, and Coroutines

Files: src/lfunc.c, src/lobject.h, src/ldo.c, src/lstate.c, and
src/lcorolib.c.

Closures let a function remember variables from its surrounding scope.
Coroutines let an execution pause and later resume. Both features depend on
understanding stacks and call frames first.

#### 6. The Compiler Pipeline

Files: src/lzio.c, src/llex.c, src/lparser.c, src/lcode.c, and src/lobject.h.

We follow source through five concrete steps:

~~~text
characters
    ↓
tokens
    ↓
parsed language structures
    ↓
bytecode instructions
    ↓
Proto (the compiled function recipe)
~~~

Lua connects parsing and bytecode generation closely instead of building a
large permanent syntax tree first.

#### 7. Garbage Collection

Files: src/lmem.c, src/lgc.h, and src/lgc.c.

We learn how Lua begins from known live values, follows their references, and
reclaims objects that can no longer be reached. This comes later because the
collector only makes sense once tables, closures, stacks, and upvalues are
familiar.

#### 8. Embedding and Standard Libraries

Files: src/lua.h, src/lapi.c, src/lauxlib.c, src/linit.c, and one small
standard library such as src/lmathlib.c.

Lua is primarily an embeddable library. We study how a C program creates a Lua
state, pushes arguments, runs Lua code, retrieves results, and exposes new C
functions to Lua.

### First Lesson: Values, the Stack, and Call Frames

This lesson answers:

> How does Lua represent a value, and where does it put values while a program
> runs?

#### TValue: Lua's Universal Value

In Lua, one variable can hold values of several different types:

~~~lua
x = 10
x = "hello"
x = true
x = {}
~~~

C normally uses a different type for each of those values. Lua therefore needs
one C structure that can represent all of them. That structure is TValue,
defined in src/lobject.h.

Think of a TValue as a labeled box:

~~~text
┌─────────────────────┐
│ label: integer      │
│ contents: 42        │
└─────────────────────┘
~~~

Or:

~~~text
┌─────────────────────┐
│ label: string       │
│ contents: pointer ──────→ "hello"
└─────────────────────┘
~~~

The label is the type tag. It tells Lua how to interpret the contents. Without
the tag, the same group of bits might be interpreted as an integer, a
floating-point number, or a memory address.

The core definition is approximately:

~~~c
typedef union Value {
    struct GCObject *gc;
    void *p;
    lua_CFunction f;
    lua_Integer i;
    lua_Number n;
    lu_byte ub;
} Value;

typedef struct TValue {
    Value value_;
    lu_byte tt_;
} TValue;
~~~

The union provides space for one possible payload. The tt_ field says which
payload is currently valid.

Small scalar values fit directly in the TValue:

- nil
- booleans
- integers
- floating-point numbers
- light userdata pointers
- light C functions

Larger objects are allocated elsewhere, and the TValue holds a pointer to them:

- strings
- tables
- Lua closures
- C closures with upvalues
- full userdata
- threads

#### Garbage-Collected Objects

Every collectable object starts with a common header:

~~~c
struct GCObject *next;
lu_byte tt;
lu_byte marked;
~~~

next links the object into a garbage-collector list. tt identifies its object
type. marked records information used while the collector decides whether the
object is still reachable.

This common beginning lets the collector handle different objects uniformly:

~~~text
GCObject
├── TString
├── Table
├── LClosure
├── Proto
├── Udata
├── UpVal
└── lua_State
~~~

#### The Lua Stack

Lua needs somewhere to keep:

- function arguments
- local variables
- temporary calculation results
- function return values

It keeps these values in an array called the Lua stack. The entries are
StackValue objects, which normally contain a TValue.

For this call:

~~~lua
add(10, 20)
~~~

part of the stack could look like:

~~~text
lower addresses                       higher addresses

┌──────────────┬────┬────┬────────────────────────┐
│ add function │ 10 │ 20 │ free stack slots ...   │
└──────────────┴────┴────┴────────────────────────┘
       ↑                   ↑
     function            L->top
~~~

L->top points to the first unused slot, not the final occupied slot.

Pushing an integer is therefore conceptually:

~~~c
put the integer and integer tag in the slot at L->top;
move L->top forward by one slot;
~~~

The real lua_pushinteger function performs those steps with internal macros:

~~~c
setivalue(s2v(L->top.p), n);
api_incr_top(L);
~~~

#### Stack Indices in the C API

C code using Lua does not receive raw pointers into the stack. It refers to
stack values with integer indices:

- 1 means the first visible value in the current call.
- 2 means the second visible value.
- -1 means the occupied value nearest the top.
- -2 means the value immediately below that.

Suppose the current frame is:

~~~text
function       +1       +2       +3          top
   ↓            ↓        ↓        ↓           ↓
┌──────────┬────────┬────────┬────────┬────────────┐
│ function │  "a"   │   20   │  true  │ free slot  │
└──────────┴────────┴────────┴────────┴────────────┘
~~~

The same values can be addressed from either direction:

| API index | Value |
|---:|---|
| 1 | “a” |
| 2 | 20 |
| 3 | true |
| -1 | true |
| -2 | 20 |
| -3 | “a” |

Positive indices are calculated relative to the current function. Negative
indices are calculated relative to L->top. src/lapi.c centralizes this
translation in index2value.

#### CallInfo: One Active Function Call

When one function calls another, the stack contains values belonging to both
functions:

~~~lua
function outer()
    local x = 10
    return inner(x)
end
~~~

Conceptually:

~~~text
Lua stack
┌─────────────────────┐
│ outer's function    │ ← outer CallInfo begins
│ outer's local x     │
│ inner's function    │ ← inner CallInfo begins
│ inner's argument    │
│ inner's temporaries │
└─────────────────────┘
~~~

A CallInfo structure describes one active call. Its most important jobs are to
remember:

- where the called function sits on the stack
- the stack limit for this function
- the previous and next call frames
- the next bytecode instruction for a Lua function
- continuation information for a yieldable C function
- how many results the caller expects

CallInfo does not contain a separate array of local variables. It describes the
part of the shared stack that belongs to the function.

#### Where Stack Slots Become VM Registers

The C API presents values as a stack because C programs naturally push
arguments and receive results. Compiled Lua code uses register names because
instructions can directly identify operands.

Lua uses the same physical stack slots for both views.

When luaV_execute starts a Lua function, it establishes a base immediately
after the function's own stack slot:

~~~c
base = ci->func.p + 1;
~~~

The VM then interprets register R[A] as the stack slot base[A]:

~~~text
VM view

R[0]    R[1]    R[2]
  ↓       ↓       ↓
┌───────┬───────┬───────┐
│ slot 0│ slot 1│ slot 2│
└───────┴───────┴───────┘
    current function's stack area
~~~

This is the important bridge:

~~~text
C-facing view: push and pop stack values
                       ↕
runtime storage: TValue slots in lua_State
                       ↕
VM-facing view: read and write registers
~~~

#### What to Read in the Source

Read only these small areas first:

1. TValue and StackValue in src/lobject.h.
2. CallInfo and lua_State in src/lstate.h.
3. index2value, lua_gettop, and lua_pushinteger in src/lapi.c.
4. luaD_precall in src/ldo.c.
5. The setup at the beginning of luaV_execute in src/lvm.c.

Do not try to understand every macro on the first pass. The first checkpoint is
being able to explain:

- why every value needs a type tag
- why top points to a free slot
- how positive and negative API indices find values
- what one CallInfo represents
- why VM registers can be implemented with stack slots

The next trace will use:

~~~lua
local function f(x)
    return x + 1
end

return f(41)
~~~

That trace will connect Proto, LClosure, CallInfo, stack slots, OP_CALL,
OP_ADDI, and OP_RETURN1.
