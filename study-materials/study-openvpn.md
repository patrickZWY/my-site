# OpenVPN Codebase Study

This document studies how this repository designs, organizes, tests, observes,
and protects a large C codebase. It is based on the local source tree, with
examples drawn from the code and some smaller abstracted examples that show the
same design ideas.

## Executive Summary

OpenVPN gets its engineering quality from a few repeated habits:

- It centralizes dangerous operations behind narrow APIs.
- It uses explicit lifecycle phases instead of letting initialization and cleanup
  happen opportunistically.
- It keeps parsing, mutation, validation, and runtime behavior separate.
- It wraps unsafe C primitives in project-specific helpers.
- It treats logs and management output as APIs, not as incidental strings.
- It uses compatibility layers where platform differences are real, but avoids
  hiding important differences behind fake uniformity.
- It tests low-level primitives directly, because most safety depends on those
  primitives being correct.

The important lesson is not "write many wrappers". The lesson is: identify the
small set of operations that can hurt you, make them explicit, and force the
rest of the codebase through those choke points.

## Repository Shape

The core implementation lives mostly in `src/openvpn/`. The major areas are:

- `openvpn.c`: top-level process lifecycle and event-loop dispatch.
- `init.c`: context initialization, teardown, scripts, management callbacks.
- `forward.c`: packet/control-channel processing and scheduling.
- `multi.*`: server-mode multi-client state.
- `options*.c`: configuration parsing, canonicalization, verification.
- `buffer.*`: safe buffer handling, scoped allocation, string helpers.
- `error.*`: logging, fatal/usage errors, syslog, mute behavior.
- `argv.*`, `env_set.*`, `run_command.*`: safe command and environment handling.
- `ssl*`, `crypto*`, `tls_crypt.*`: TLS and data-channel crypto.
- `plugin.*` and `include/openvpn-plugin.h.in`: plugin ABI.
- `platform.*`, `networking*`, `dco*`, `tun*`, `socket*`: OS integration.
- `tests/`: unit and system tests.
- `.github/workflows/`: CI for formatting, platforms, sanitizers, and tests.

The organization is not purely "one file per object". It is closer to
"one ownership boundary per operational concern". That matters in C because
the language does not give strong module boundaries by default; the project
creates them through headers, naming, and disciplined call paths.

## Lifecycle Design

The main process lifecycle is explicit in `src/openvpn/openvpn.c`.

The key shape is:

1. Initialize global/static process state.
2. Enter an outer loop that restarts on SIGHUP.
3. Rebuild the main `struct context`.
4. Parse config and command-line options.
5. Let early plugin and provider initialization happen.
6. Post-process and validate options.
7. Initialize management, daemonization, environment, and tunnel context.
8. Enter an inner loop that restarts on SIGUSR1.
9. Dispatch to point-to-point or server event loop.
10. Tear down in reverse order.

From `openvpn.c`, the code documents this structure directly:

```c
/*
 * This function contains the two outer OpenVPN loops.  Its structure is
 * as follows:
 *  - Once-per-process initialization.
 *  - Outer loop, run at startup and then once per SIGHUP:
 *    - Level 1 initialization
 *    - Inner loop, run at startup and then once per SIGUSR1:
 *      - Call event loop function depending on client or server mode:
 *        - tunnel_point_to_point()
 *        - tunnel_server()
 *    - Level 1 cleanup
 *  - Once-per-process cleanup.
 */
```

The strong practice here is that restart semantics are architectural. They are
not buried in random error paths. Some state is process-wide, some survives a
SIGUSR1 restart, and some is destroyed on SIGHUP. The `context` structure
captures this instead of relying on unrelated globals.

Abstracted example:

```c
int
program_main(int argc, char **argv)
{
    struct app_context ctx;

    init_process_state();

    do {
        clear_context_preserving_process_state(&ctx);
        parse_config(&ctx.options, argc, argv);
        postprocess_options(&ctx.options);
        init_runtime(&ctx);

        do {
            run_event_loop(&ctx);
            report_signal(&ctx);
        } while (reset_signal(ctx.sig, SOFT_RESTART));

        cleanup_runtime(&ctx);
    } while (reset_signal(ctx.sig, HARD_RESTART));

    cleanup_process_state();
    return 0;
}
```

The reusable idea is not the exact signal names. It is the separation between
process lifetime, configuration lifetime, connection lifetime, and loop
lifetime.

## Configuration And API Control

OpenVPN has a large public configuration surface. The repo controls that API by
splitting work into clear phases:

1. Parse tokens and inline blocks.
2. Store user intent in `struct options`.
3. Expand helper options into canonical options.
4. Apply compatibility defaults.
5. Verify semantic consistency.
6. Check filesystem/script prerequisites.
7. Save pre-connect state for options that can later be changed by server push.

The final phase function in `src/openvpn/options.c` is compact:

```c
void
options_postprocess(struct options *options, struct env_set *es)
{
    options_postprocess_mutate(options, es);
    options_postprocess_verify(options);
#ifndef ENABLE_SMALL
    options_postprocess_filechecks(options);
#endif
}
```

That separation is important. Mutation and validation are different jobs:

- Mutation says: "Given older syntax, helper syntax, or defaults, what is the
  canonical internal state?"
- Validation says: "Is this final state legal?"
- File checks say: "Can this state actually run on this machine?"

Example from `options_postprocess_verify_ce()`:

```c
if (ce->proto == PROTO_TCP)
{
    msg(M_USAGE, "--proto tcp is ambiguous in this context. Please specify "
                 "--proto tcp-server or --proto tcp-client");
}

if (options->ce.tun_mtu_defined && options->ce.link_mtu_defined)
{
    msg(M_USAGE, "only one of --tun-mtu or --link-mtu may be defined");
}
```

This code rejects ambiguity early. It does not let ambiguous state drift into
the runtime path.

Another example is management-interface safety:

```c
if (options->management_addr && !(options->management_flags & MF_UNIX_SOCK)
    && (!options->management_user_pass))
{
    msg(M_WARN, "WARNING: Using --management on a TCP port WITHOUT "
                "passwords is STRONGLY discouraged and considered insecure");
}
```

This is a deliberate API stance: not every unsafe-looking configuration is
fatal, because compatibility and operational reality matter. But dangerous
configurations are named clearly and consistently.

Abstracted option pipeline:

```c
bool
load_config(struct options *o)
{
    parse_options(o);

    /* Convert shorthand and compatibility flags into one internal form. */
    mutate_options(o);

    /* Reject impossible or unsafe combinations. */
    if (!verify_options(o))
    {
        return false;
    }

    /* Check machine-local prerequisites last. */
    return check_files_and_permissions(o);
}
```

This pattern prevents a common C-project failure mode: every caller doing its
own interpretation of config flags.

## Handling Deprecated And Dangerous Features

The project has to keep long-term compatibility, so it does not simply delete
all old features immediately. Instead it grades behavior:

- Removed options can be fatal.
- Deprecated options can warn.
- Dangerous options can warn loudly.
- Some deprecated insecure modes require explicit opt-in.

Example from `options.c`:

```c
if (!options->tls_server && !options->tls_client && !options->test_crypto)
{
    msglvl_t msglevel = M_USAGE;
    if (options->allow_deprecated_insecure_static_crypto)
    {
        msglevel = M_INFO;
    }

    msg(msglevel, "DEPRECATION: No tls-client or tls-server option in "
                  "configuration detected. OpenVPN 2.8 will remove the "
                  "functionality to run a VPN without TLS. "
                  "... move to a proper configuration using TLS as soon as possible.");
}
```

This is a good example of controlled migration:

- The default path fails or warns strongly.
- A compatibility escape hatch exists.
- The warning names the future removal.
- The message gives users a migration direction.

Another example:

```c
if (options->ssl_flags & (SSLF_CLIENT_CERT_NOT_REQUIRED | SSLF_CLIENT_CERT_OPTIONAL))
{
    msg(M_WARN, "WARNING: POTENTIALLY DANGEROUS OPTION "
                "--verify-client-cert none|optional "
                "may accept clients which do not present a certificate");
}
```

The practice here is precise language. It explains the operational consequence,
not just that something is "bad".

## Error Handling And Observability

OpenVPN uses `msg()` as the central logging and error-reporting API. This is
defined in `src/openvpn/error.h` and implemented in `src/openvpn/error.c`.

The message flags encode:

- verbosity level,
- fatal/nonfatal behavior,
- warning behavior,
- errno inclusion,
- usage errors,
- prefix/timestamp behavior,
- virtual-output forwarding,
- mute category.

Representative definitions:

```c
#define M_FATAL    (1u << 4)
#define M_NONFATAL (1u << 5)
#define M_WARN     (1u << 6)
#define M_ERRNO    (1u << 8)
#define M_USAGE    (M_USAGE_SMALL | M_NOPREFIX | M_OPTERR)
```

The `msg()` macro itself checks whether the message should be emitted, then
enforces fatal behavior:

```c
#define msg(flags, ...)                  \
    do                                   \
    {                                    \
        if (msg_test(flags))             \
        {                                \
            x_msg((flags), __VA_ARGS__); \
        }                                \
        EXIT_FATAL(flags);               \
    } while (false)
```

This gives the project a uniform error vocabulary. A caller does not separately
decide how to format, where to route, whether to add errno, or whether to exit.

`x_msg_va()` then routes messages to syslog, log files, stdout/stderr, management
virtual output, or machine-readable output:

```c
if (machine_readable_output)
{
    fprintf(fp, "%" PRIi64 ".%06ld %x %s%s%s%s",
            (int64_t)tv.tv_sec, (long)tv.tv_usec,
            flags, prefix, prefix_sep, m1, "\n");
}
else if ((flags & M_NOPREFIX) || suppress_timestamps)
{
    fprintf(fp, "%s%s%s%s", prefix, prefix_sep, m1,
            (flags & M_NOLF) ? "" : "\n");
}
else
{
    fprintf(fp, "%s %s%s%s%s", time_string(0, 0, show_usec, &gc),
            prefix, prefix_sep, m1, (flags & M_NOLF) ? "" : "\n");
}
```

Good practice: observability is not just "print more logs". It is:

- consistent severity,
- consistent prefixing,
- support for machine consumers,
- rate/mute behavior,
- redaction of sensitive data,
- output to management/control interfaces where needed.

## Sanitization And Redaction

The code treats logs as a possible data leak. Strings received from peers are
sanitized before printing.

In `misc.c`:

```c
const char *
safe_print(const char *str, struct gc_arena *gc)
{
    return string_mod_const(str, CC_PRINT, CC_CRLF, '.', gc);
}
```

Control messages are redacted:

```c
else if (!check_debug_level(D_SHOW_KEYS) && (c == 'a' && !strncmp(src, "auth-token ", 11)))
{
    /* Unless --verb is 7 or higher (D_SHOW_KEYS), hide
     * the auth-token value coming in the src string
     */
    skip = 10;
    redact = true;
}
```

Peer-provided environment lines are validated and shell-sensitive characters
are replaced:

```c
if (!isprint(c) || isspace(c) || c == '$' || c == '(' || c == '`')
{
    *line = '_';
}
```

The environment API also suppresses password variables from logs:

```c
static inline bool
env_safe_to_print(const char *str)
{
#ifndef UNSAFE_DEBUG
    if (is_password_env_var(str))
    {
        return false;
    }
#endif
    return true;
}
```

The principle is that redaction belongs close to the logging/environment
boundary, not sprinkled around every call site.

## Memory Management And Buffer Safety

The `buffer` abstraction is one of the most important pieces of C discipline in
the codebase.

`struct buffer` stores:

```c
struct buffer
{
    int capacity;
    int offset;
    int len;
    uint8_t *data;
};
```

The design supports:

- content starting at `data + offset`,
- prepend capacity before the content,
- append capacity after the content,
- explicit length tracking,
- easy validity checks.

Instead of ad hoc pointer arithmetic at every call site, helpers like
`buf_safe()`, `buf_inc_len()`, `buf_prepend()`, `buf_advance()`, `buf_printf()`,
and `buf_parse()` define the rules once.

Example:

```c
static inline bool
buf_safe(const struct buffer *buf, size_t len)
{
    return buf_valid(buf) && buf_size_valid(len)
           && buf->offset + buf->len + (int)len <= buf->capacity;
}
```

The code also has scoped allocation with `struct gc_arena`. Temporary strings
and buffers are often allocated into an arena and freed at the end of a
function:

```c
struct gc_arena gc = gc_new();
struct buffer out = alloc_buf_gc(256, &gc);
buf_printf(&out, "%s=%s", name, value);
...
gc_free(&gc);
```

This is not general-purpose garbage collection. It is scoped cleanup for C
functions that need many small temporary allocations. That reduces cleanup-path
complexity without hiding ownership for long-lived objects.

Secret memory is handled separately. `secure_memzero()` intentionally prevents
the compiler from optimizing away the wipe:

```c
#elif defined(__GNUC__) || defined(__clang__)
    memset(data, 0, len);
    __asm__ __volatile__("" : : "r"(data) : "memory");
```

Important lesson: normal zeroing and secret zeroing are different operations.
This code names that difference.

## Command Execution Safety

The project avoids shell command construction for execution. It builds `argv`
arrays and calls `execve()`.

`run_command.c` says this directly:

```c
/*
 * Run execve() inside a fork(). Designed to replicate the semantics of system()
 * but in a safer way that doesn't require the invocation of a shell or the risks
 * associated with formatting and parsing a command line.
 */
```

Execution is also gated:

```c
bool
openvpn_execve_allowed(const unsigned int flags)
{
    if (flags & S_SCRIPT)
    {
        return script_security() >= SSEC_SCRIPTS;
    }
    else
    {
        return script_security() >= SSEC_BUILT_IN;
    }
}
```

The actual execution path makes a controlled environment array:

```c
const char *cmd = a->argv[0];
char *const *argv = a->argv;
char *const *envp = (char *const *)make_env_array(es, true, &gc);

pid = fork();
if (pid == (pid_t)0)
{
    execve(cmd, argv, envp);
    exit(OPENVPN_EXECVE_FAILURE);
}
```

Command construction goes through `argv.c`. `argv_printf()` is a printf-like API
that builds separate arguments instead of a single command string:

```c
bool
argv_printf(struct argv *argres, const char *format, ...)
```

Internally it replaces spaces in the format with a delimiter, uses `vsnprintf()`,
then splits back into argv entries. If user data smuggles the delimiter, it
detects the argument count mismatch and fails.

Abstracted safe command pattern:

```c
struct argv a = argv_new();

if (!argv_printf(&a, "%s %s %d", helper_path, interface_name, mtu))
{
    msg(M_WARN, "could not build helper argv");
    goto done;
}

if (!openvpn_execve_check(&a, env, S_SCRIPT | S_FATAL, "--up failed"))
{
    goto done;
}

done:
argv_free(&a);
```

The key rule: user input may become an argv element, but it should not become a
shell program.

## Public Plugin API

The plugin interface is intentionally conservative:

- It defines `OPENVPN_PLUGIN_VERSION`.
- It defines event types as integer constants.
- It exposes a versioned v3 struct layout.
- It includes a changelog for struct version changes.
- It gives plugins callbacks for logging, secure zeroing, and base64 helpers.
- It tells plugins what SSL backend OpenVPN is using.
- It documents allocation ownership.
- It distinguishes global plugin context and per-client context.

Example from `include/openvpn-plugin.h.in`:

```c
#define OPENVPN_PLUGINv3_STRUCTVER 5

struct openvpn_plugin_callbacks
{
    plugin_log_t plugin_log;
    plugin_vlog_t plugin_vlog;
    plugin_secure_memzero_t plugin_secure_memzero;
    plugin_base64_encode_t plugin_base64_encode;
    plugin_base64_decode_t plugin_base64_decode;
};
```

The API also avoids giving plugins direct access to OpenVPN internals. It passes
structured arguments:

```c
struct openvpn_plugin_args_open_in
{
    const int type_mask;
    const char **const argv;
    const char **const envp;
    struct openvpn_plugin_callbacks *callbacks;
    const ovpnSSLAPI ssl_api;
    const char *ovpn_version;
    const unsigned int ovpn_version_major;
    const unsigned int ovpn_version_minor;
    const char *const ovpn_version_patch;
};
```

Good API practice: the plugin boundary has explicit versioning, explicit memory
ownership, explicit callbacks, and no accidental exposure of internal structs.

## Platform Abstraction And Reuse

OpenVPN does not pretend all platforms are the same. It abstracts where useful,
but keeps real differences visible.

Examples:

- `platform.*` wraps file, process, UID/GID, chroot, sleep, and access calls.
- `networking.h` selects SITNL, iproute2, FreeBSD, or stub types.
- `dco.h` exposes data-channel offload as a feature-gated API, with no-op stubs
  when not compiled.
- `crypto_backend.h` selects OpenSSL or mbed TLS backend types and functions.

This style gives callers one broad API while still letting each backend express
its constraints. For example, DCO has explicit option checks:

```c
bool dco_check_option(msglvl_t msglevel, const struct options *o);
bool dco_check_startup_option(msglvl_t msglevel, const struct options *o);
bool dco_check_pull_options(msglvl_t msglevel, const struct options *o);
```

The code does not blindly enable DCO. During option mutation:

```c
if (dco_enabled(o))
{
    o->disable_dco = !dco_check_option(D_DCO, o)
                     || !dco_check_startup_option(D_DCO, o);
}
```

The reuse rule here is practical:

- Reuse the interface when callers need the same conceptual operation.
- Do not reuse implementation when the OS, crypto library, or feature has
  materially different semantics.

## When They Reuse Code

OpenVPN reuses code when the invariant is shared across the system.

Examples:

- All logging goes through `msg()`.
- Temporary allocation uses `gc_arena`.
- Buffer operations use `struct buffer`.
- Script execution uses `argv`, `env_set`, and `run_command`.
- Option parsing uses `parse_line()`, `VERIFY_PERMISSION`, constrained integer
  helpers, and `options_postprocess()`.
- Sensitive strings use `secure_memzero()` and redaction helpers.

This kind of reuse makes bugs easier to fix. If buffer overflow checks improve,
all buffer users benefit. If environment filtering improves, script/plugin paths
benefit.

## When They Do Not Reuse Code

They avoid reuse where it would flatten important distinctions:

- OpenSSL and mbed TLS have separate backend files.
- Windows service code is separate from Unix daemonization.
- Management interface logic is not treated as normal logging.
- Plugin ABI structs are separate from internal context structs.
- DCO platform implementations are separate.
- Tests often compile specific source files with mocks rather than forcing all
  internal helpers to become public APIs.

This is good restraint. Reuse is not the goal. Reduced risk and clearer
ownership are the goals.

## Testing Strategy

The tests are layered:

- Unit tests for low-level primitives and parsers.
- Mocked unit tests for modules that depend on global project services.
- System shell tests for real client/server behavior.
- CI tests across compilers, OSes, crypto libraries, sanitizers, and build
  systems.

`tests/unit_tests/openvpn/Makefile.am` lists many focused drivers:

```make
test_binaries = argv_testdriver \
    auth_token_testdriver \
    buffer_testdriver \
    crypto_testdriver \
    dhcp_testdriver \
    ncp_testdriver \
    mbuf_testdriver \
    misc_testdriver \
    options_parse_testdriver \
    packet_id_testdriver \
    pkt_testdriver \
    provider_testdriver \
    push_update_msg_testdriver \
    socket_testdriver \
    ssl_testdriver \
    user_pass_testdriver
```

The parser tests are concrete and boundary-heavy. From
`test_options_parse.c`, they cover:

- normal tokenization,
- single and double quotes,
- escaped quotes,
- missing quotes,
- Windows-style backslashes,
- comments,
- maximum parameter length,
- too-long parameters,
- maximum parameter count,
- too many parameters.

Example:

```c
PARSE_LINE_TST("--some-opt 'first parm' \"second' 'parm\"");
assert_int_equal(res, 3);
assert_string_equal(p[0], "--some-opt");
assert_string_equal(p[1], "first parm");
assert_string_equal(p[2], "second' 'parm");
```

That is exactly where C projects should spend test effort: small parsers,
buffers, crypto-adjacent logic, packet IDs, and option validation.

## CI And Quality Gates

The GitHub workflow enforces:

- `clang-format` via pre-commit.
- Android CMake build.
- MinGW x86/x64 release/debug builds.
- MinGW unit tests on Windows.
- Ubuntu Autotools builds with `--enable-werror`.
- `make check`.
- Clang ASan/UBSan builds.
- macOS normal and sanitizer builds.
- MSVC builds.
- Several SSL library compatibility workflows.

Examples from `.github/workflows/build.yaml`:

```yaml
clang-format:
  name: Check code style with clang-format
```

```yaml
configure:
  run: ./configure --with-crypto-library=${{matrix.ssllib}} ${{matrix.extraconf}} --enable-werror
```

```yaml
configure:
  run: CFLAGS="-fsanitize=address,undefined -fno-sanitize-recover=all ..."
```

There is also `dev-tools/run-cppcheck.sh`, configured with project suppressions,
platform settings, OpenSSL modeling, and exhaustive checking.

The practice is mature because the project does not rely on one happy-path
Linux build. It checks many combinations where portability bugs actually appear.

## C Best Practices Illustrated By This Repo

### Prefer Project-Specific Safe Primitives

Do not repeatedly write:

```c
char buf[256];
sprintf(buf, "%s/%s", dir, file);
```

Prefer:

```c
struct gc_arena gc = gc_new();
struct buffer path = alloc_buf_gc(PATH_MAX, &gc);
if (!buf_printf(&path, "%s/%s", dir, file))
{
    msg(M_WARN, "path too long");
}
gc_free(&gc);
```

### Separate Fatal Programmer Errors From User Errors

OpenVPN uses `ASSERT()` for internal invariants and `msg(M_USAGE, ...)` for
invalid user configuration.

Abstracted:

```c
ASSERT(connection_list != NULL);          /* programmer invariant */

if (!user_supplied_remote)
{
    msg(M_USAGE, "--remote is required"); /* user/config error */
}
```

### Use Constrained Parsing

Instead of `atoi()` everywhere, parse with bounds and names:

```c
if (!atoi_constrained(p[1], &value, "max-clients", 1, MAX_PEER_ID - 1, msglevel))
{
    goto err;
}
```

This gives better diagnostics and prevents invalid values from entering runtime
state.

### Canonicalize Before Runtime

The forwarding path should not ask, "Did the user specify shorthand A, old
option B, or helper C?" That should be resolved during post-processing.

Bad:

```c
if (o->server || o->server_bridge || o->helper_mode)
{
    ...
}
```

Better:

```c
helper_client_server(o);
helper_setdefault_topology(o);
options_postprocess_verify(o);

/* Runtime sees canonical mode. */
if (o->mode == MODE_SERVER)
{
    tunnel_server(c);
}
```

### Keep Shells Out Of Data Paths

Bad:

```c
snprintf(cmd, sizeof(cmd), "%s %s %d", script, dev, mtu);
system(cmd);
```

Better:

```c
struct argv a = argv_new();
argv_printf(&a, "%s %s %d", script, dev, mtu);
openvpn_execve_check(&a, es, S_SCRIPT | S_FATAL, "--up");
argv_free(&a);
```

### Redact At Boundaries

Bad:

```c
msg(M_INFO, "received control message: %s", msg);
```

Better:

```c
struct gc_arena gc = gc_new();
msg(M_INFO, "received control message: %s",
    sanitize_control_message(msg, &gc));
gc_free(&gc);
```

### Make Compile-Time Optional Features Have Stubs

The project often defines no-op stubs when a feature is not compiled. That lets
callers stay simple while preserving feature boundaries.

Abstracted:

```c
#ifdef ENABLE_FEATURE
bool feature_available(void);
#else
static inline bool
feature_available(void)
{
    return false;
}
#endif
```

### Test The Small Dangerous Parts

Do not only test full end-to-end VPN sessions. Test parsers, buffer boundaries,
integer constraints, packet IDs, and redaction directly. OpenVPN's unit tests
show this well.

## What To Copy Into Other C Projects

Useful practices to copy:

- A central `msg()`-style logging/error API with severity, errno, fatal, and
  machine-readable modes.
- A `buffer` abstraction that tracks capacity and length explicitly.
- Scoped allocation arenas for temporary data.
- A strict option pipeline: parse, mutate, verify, file-check.
- A command-execution wrapper that uses argv arrays and controlled env arrays.
- Redaction helpers for logs and environment printing.
- Versioned external APIs with explicit callback tables and ownership rules.
- Platform backends with stubs for unsupported features.
- Unit tests for parsers and low-level helpers.
- CI that covers compilers, platforms, sanitizers, and formatting.

Practices to be careful with:

- The arena allocator is useful, but only if ownership rules are clear.
- Global state exists in the repo, especially for logging and process state;
  this works because access is mostly funneled through wrappers.
- Direct inclusion of `.c` files in tests can be pragmatic in C, but should not
  become a reason to blur production module boundaries.
- Backward compatibility creates complexity. The repo manages it deliberately,
  but a smaller project should not copy compatibility shims it does not need.

## Final Takeaway

OpenVPN's code quality comes from repeatedly turning dangerous C behavior into
small, named, reviewable interfaces:

- bytes go through buffers,
- logs go through `msg()`,
- temporary allocations go through arenas,
- commands go through argv/env wrappers,
- config goes through post-processing and validation,
- plugins go through a versioned ABI,
- platform differences go through backend interfaces.

That is the central lesson. The project does not make C safe by pretending C is
safe. It makes unsafe operations visible, centralized, and testable.
