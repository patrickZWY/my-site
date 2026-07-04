# OpenSSH Portable Architecture Study

This note studies `openssh-portable` as an example of security-first C
engineering.  The central lesson is that OpenSSH does not rely on one large
trusted program behaving perfectly.  It breaks work into privilege domains,
turns policy into explicit dispatch tables, serializes state through narrow
channels, validates untrusted bytes before use, and keeps platform-specific
danger behind small interfaces.

The files I used most heavily:

- `README.md`
- `README.privsep`
- `log.c`
- `monitor.c`
- `monitor_wrap.c`
- `monitor_fdpass.c`
- `sandbox-seccomp-filter.c`
- `ssherr.c`
- `packet.c`
- `regress/README.regress`

## 1. What This Repo Is Optimizing For

OpenSSH is network-facing cryptographic infrastructure.  The design therefore
optimizes for:

- damage containment after a parser, protocol, or authentication bug;
- explicit control over which code may perform privileged work;
- portability without lowering the security model to the weakest platform;
- stable behavior under hostile network input;
- diagnosability without leaking secrets or letting logging become another
  attack surface.

The portable tree is also a long-lived C project.  Its coding practices favor
small files, simple ownership, explicit error returns, local abstractions, and
OpenBSD-origin helper APIs such as `sshbuf`, `xmalloc`, `recallocarray`,
`strlcpy`, `strnvis`, and the `fatal_f`/`debug_f` logging family.

## 2. Top-Level Shape

The repository is organized around programs and shared protocol/security
modules:

- `ssh.c`, `sshd.c`, `sshd-session.c`, `sshd-auth.c`: process entry points.
- `auth*.c`, `auth2*.c`: authentication flows.
- `monitor.c`, `monitor_wrap.c`, `monitor_fdpass.c`: privilege separation RPC.
- `packet.c`, `dispatch.c`, `channels.c`: SSH transport/session protocol.
- `kex*.c`, `cipher*.c`, `mac.c`, `sshkey*.c`: crypto and key material.
- `sandbox-*.c`: OS-specific sandbox backends.
- `openbsd-compat/`: portability layer that imports or emulates OpenBSD APIs.
- `regress/`: integration-heavy regression tests and protocol behavior tests.

The split is not purely by feature.  It is also by trust boundary.  For
example, authentication is not only "auth code"; it is divided between the
network-facing unprivileged child and the privileged monitor that owns sensitive
operations.

## 3. The Core Architectural Pattern: Privilege Separation

`README.privsep` is the architectural key.  OpenSSH daemon operation is split
into cooperating processes:

- Listener `sshd`: privileged, reads configuration, listens on sockets, handles
  connection rate limiting, and avoids direct processing of untrusted protocol
  data.
- `sshd-session`: per-connection privileged pre-auth monitor.
- `sshd-auth`: unprivileged network-facing pre-auth process, often chrooted and
  sandboxed.
- Post-auth session child: runs with the authenticated user's privileges.

The model is intentionally asymmetric:

- the child sees the network and parses protocol messages;
- the monitor keeps privilege and secrets;
- the child can ask for privileged services only through a small request
  protocol;
- the monitor validates request type, phase, and one-shot semantics before
  executing anything.

This is stronger than "check inputs carefully".  The architecture assumes that
input-handling code may fail and reduces what that failure can reach.

### Abstracted Control Flow

```text
listener sshd
  accepts TCP connection
  forks/execs sshd-session

sshd-session
  owns privileged state
  forks/execs sshd-auth
  waits for monitor RPC messages

sshd-auth
  drops privilege / chroots / enters sandbox
  parses SSH transport and auth packets
  asks monitor for privileged decisions:
    - load/sign with host key
    - check password or account policy
    - allocate PTY
    - read allowed key data

monitor
  permits only phase-appropriate requests
  disables one-shot requests after use
  logs child messages
  receives serialized protocol state after auth

post-auth
  session child runs as target user
  privileged monitor remains for operations still requiring privilege
```

## 4. API Control: Monitor Dispatch Tables

`monitor.c` turns privilege policy into data.  The request table contains:

```c
struct mon_table {
	enum monitor_reqtype type;
	int flags;
	int (*f)(struct ssh *, int, struct sshbuf *);
};
```

The flags encode policy:

- `MON_ISAUTH`: request participates in authentication.
- `MON_AUTHDECIDE`: request can decide authentication success.
- `MON_ONCE`: request is disabled after first use.
- `MON_ALOG`: request should log auth attempt.
- `MON_PERMIT`: request is currently allowed.

Pre-auth and post-auth have separate tables:

- pre-auth permits state transfer, moduli, compatibility, signing, selected
  authentication requests, and optional PAM/GSS/audit flows;
- post-auth permits a different set, such as PTY operations and termination.

The monitor loop does not trust the child to follow protocol order.  It reads a
message, parses the request type with `sshbuf`, looks up the request in the
current table, checks `MON_PERMIT`, invokes the handler, and disables
`MON_ONCE` entries.

Abstracted example:

```c
if (!(entry->flags & MON_PERMIT))
	fatal_f("unpermitted request %d", type);

ret = entry->handler(ssh, monitor_fd, message);

if (entry->flags & MON_ONCE)
	entry->flags &= ~MON_PERMIT;
```

This is good API design in C: the API boundary is not just a set of functions;
it is a state machine enforced at the call site.

## 5. State Transfer Instead Of Shared Mutable Privilege

After successful authentication, `sshd-auth` cannot simply continue with its
network-parsed state and regain privilege.  Instead, state is serialized back
to the privileged process.  The monitor validates the child exit status, drains
logs, and only then proceeds to post-auth state.

That design keeps the dangerous phase change explicit:

- pre-auth child handles hostile input and is disposable;
- successful authentication produces serialized state;
- the privileged parent resumes with known state and a different permission
  table.

This avoids a common C-server failure mode: a process that starts untrusted,
accumulates complex state, and later receives broader authority.

## 6. Handling Dangerous Operations

OpenSSH treats danger as something to isolate, not merely document.

### 6.1 Network Input

Network input is parsed through protocol-specific buffers such as `sshbuf`.
Errors are returned as `SSH_ERR_*` codes, mapped by `ssherr.c` to stable
messages.  This keeps parser failures structured:

```c
if ((r = sshbuf_get_u8(m, &type)) != 0)
	fatal_fr(r, "parse type");
```

The common pattern is:

- parse using a checked helper;
- test the return value immediately;
- attach operation context in the log;
- fail closed if the monitor protocol is corrupted.

### 6.2 Privileged Signing And Key Access

Signing with host keys is a privileged monitor operation.  The child can request
a signature, but it does not own the key.  This narrows key exposure even if a
pre-auth protocol parser is compromised.

### 6.3 PTY Allocation

PTY handling is only permitted post-auth and only if the authorization options
allow it.  In `monitor_child_postauth`, the monitor enables PTY requests only
under `auth_opts->permit_pty_flag`.

### 6.4 Sandbox Backends

OpenSSH uses per-OS sandbox files:

- `sandbox-seccomp-filter.c`
- `sandbox-rlimit.c`
- `sandbox-capsicum.c`
- `sandbox-darwin.c`
- `sandbox-solaris.c`
- `sandbox-null.c`

This is a good reuse decision: the higher-level sandbox API is reused, but the
policy mechanism is not forced through one fake portable abstraction.  The
platform differences are real, so the repo isolates them behind a common shape.

## 7. Seccomp Example: Policy As Data

`sandbox-seccomp-filter.c` builds a BPF allowlist for the pre-auth child.

Important practices:

- check the syscall architecture before applying rules;
- default to killing the process for unexpected syscalls;
- explicitly deny some syscalls with ordinary `errno` values when libraries may
  probe for them;
- allow only tightly constrained operations such as selected `futex`, `mmap`,
  `mprotect`, `read`, `write`, `poll`, `clock_gettime`, and socket metadata
  calls;
- encode argument-level restrictions, not just syscall names.

Abstracted example:

```c
allow(read);
allow(write);
allow_arg(madvise, advice == MADV_DONTNEED);
deny(openat, EACCES);
kill(default);
```

The important lesson is that the sandbox is not "no filesystem access" as a
comment.  It is executable policy installed by the process.

## 8. Error Handling Style

OpenSSH uses a few distinct error modes:

- recoverable internal/library errors return integer `SSH_ERR_*` codes;
- monitor protocol corruption calls `fatal_f`;
- impossible allocation in critical monitor paths calls `fatal`;
- user-facing authentication failure is logged and counted, not always fatal;
- system call failures are logged with `strerror(errno)` and operation context.

The distinction matters.  An invalid password is not a process bug.  A
pre-auth child sending an unpermitted monitor request is a security boundary
violation and the process exits.

Example from `ssherr.c`: error codes are centralized, so callers do not invent
ad hoc strings for cryptographic or parser failures.  This improves API
stability and logging consistency.

## 9. Logging And Observability

`log.c` shows several mature practices:

- logging levels are parsed from names and centralized;
- stderr and syslog paths share formatting rules;
- messages are escaped through `strnvis` before writing to syslog/stderr;
- `errno` is saved and restored across logging;
- forced verbose logging can match file/function/pid tags;
- log handlers are temporarily disabled while called to avoid recursion;
- rate limiting exists for bursty events.

Monitor logging is also architecturally interesting.  The child sends log
messages to the monitor over a separate log fd.  `monitor_read_log` validates
message length, parses level and forced flag, validates the log level, and
re-emits the message annotated with pre-auth/post-auth phase.

That means unprivileged children can report diagnostics without directly owning
the daemon's privileged logging path.

## 10. Testing Strategy

`regress/README.regress` describes two main layers:

- file-based tests driven by the Makefile;
- network/proxycommand tests driven by `test-exec.sh`.

The test suite covers real user workflows:

- simple connect;
- privilege separation connect;
- rekeying;
- ciphers and key exchange;
- agent behavior;
- SFTP/SCP;
- forwarding;
- multiplexing;
- configuration parsing;
- certificate behavior;
- revocation lists;
- forced commands and environment passing.

This is the right test shape for OpenSSH.  Unit tests are useful for parsers
and helpers, but the primary risk is cross-process protocol behavior.  The
regression suite therefore exercises complete programs with generated configs,
keys, network sockets, and shell scripts.

The README also mentions Valgrind support and CI/fuzzing integrations.  That
combination reflects the risk model: memory safety bugs matter, but so do
protocol regressions and platform differences.

## 11. Reuse Decisions

OpenSSH reuses aggressively where the domain is stable:

- `sshbuf` for binary parsing and serialization;
- `ssherr` for error names;
- `log.c` for process-wide logging;
- `atomicio` for short-read/write-safe IO;
- monitor request helpers for RPC;
- OpenBSD compatibility functions for safer C APIs.

It does not over-reuse where security policy differs:

- separate sandbox files per OS;
- pre-auth and post-auth monitor tables are separate;
- auth methods are separate modules;
- platform integration such as PAM, GSSAPI, audit, and sandboxing is guarded by
  compile-time feature checks.

The implicit rule is:

> Reuse mechanics and formats; do not reuse policy when the policy boundary is
> meaningfully different.

## 12. C Practices Worth Copying

- Keep API state explicit with structs and tables.
- Use checked buffer APIs instead of raw pointer parsing.
- Prefer `snprintf`, `strlcpy`, `recallocarray`, and `xcalloc` style helpers.
- Centralize string conversion for enums/error codes.
- Save and restore `errno` in logging utilities.
- Make impossible security states fatal.
- Split platform code by file instead of burying every difference in nested
  conditionals.
- Use one-shot permissions for one-shot protocol messages.
- Annotate logs with phase and operation context.
- Treat child processes as disposable after untrusted parsing.

## 13. Abstract Example Inspired By OpenSSH

Suppose a privileged daemon accepts network requests but only some operations
need root:

```c
enum req_type {
	REQ_GET_PUBLIC_INFO,
	REQ_SIGN_BLOB,
	REQ_OPEN_SESSION,
};

#define REQ_PERMIT 0x01
#define REQ_ONCE   0x02
#define REQ_AUTH   0x04

struct req_entry {
	enum req_type type;
	unsigned flags;
	int (*handler)(struct context *, struct msg *);
};

static struct req_entry preauth[] = {
	{ REQ_GET_PUBLIC_INFO, REQ_PERMIT, handle_public },
	{ REQ_SIGN_BLOB, REQ_PERMIT | REQ_ONCE, handle_sign },
	{ REQ_OPEN_SESSION, 0, handle_open_session },
};

static int
dispatch(struct req_entry *table, struct msg *m)
{
	struct req_entry *e = find_entry(table, m->type);

	if (e == NULL || !(e->flags & REQ_PERMIT))
		fatal("bad privileged request");

	int r = e->handler(ctx, m);
	if (e->flags & REQ_ONCE)
		e->flags &= ~REQ_PERMIT;
	return r;
}
```

The point is not the syntax.  The point is that privilege is granted by a
small, inspectable table, not by scattered `if (authenticated)` checks.

## 14. What To Learn

OpenSSH's good practice is architectural before it is stylistic:

- It narrows trust boundaries until they are visible in process structure.
- It makes allowed privileged operations enumerable.
- It treats parsers and pre-auth code as hostile-risk zones.
- It keeps logs useful but sanitized.
- It embraces platform-specific files where pretending portability would hide
  security differences.
- It tests complete behaviors because the product is a protocol system, not a
  library of isolated functions.

