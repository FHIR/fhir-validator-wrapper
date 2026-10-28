# Changelog

All notable changes to the FHIR Validator Wrapper will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `loadIG()` sent the package id and version as query parameters with an empty body. The
  validator's HTTP service takes a JSON body, `{"ig": "id#version"}`, and failed every load with
  `Failed to load IG: Error parsing JSON source: Unexpected content at start of JSON: Eof at Line 1`.
  It now posts that body

## [1.6.0]

### Added
- `start()` takes `txTests` (default false), which starts the validator with `-txTests`. From
  validator 7.0.4 the terminology test endpoints that `runTxTest()` uses are off without it, so
  anything that calls `runTxTest()` needs to pass `txTests: true`. Validators before 7.0.4 have
  the endpoints always on and don't know the option, so it isn't passed to them

## [1.5.0]

### Fixed
- `validate()` sent the profiles as one `profiles=a,b` parameter, and best practice and display
  options as `bpWarnings` and `displayOption`. The validator's HTTP service (7.x) takes one
  `profile=` per profile and calls the others `bestPractice` and `checkDisplay`, and refuses
  any parameter it does not know - so every validation that asked for a profile failed with
  `Unable to process param profiles=...`. The right names are sent now; the wrapper's option
  names are unchanged. `anyExtensionsAllowed: true` is sent as `extension=any`
- A validator process that could not be started at all (no `java` on the path, say) emitted an
  `error` event whose handler threw - an uncaught exception that took the host process down.
  `start()` now rejects instead
- `start()` failed when GitHub could not be reached to check for a newer validator, even with a
  perfectly good JAR on disk. It now warns and uses the JAR it has
- The service address is `127.0.0.1`, not `localhost`: the validator listens on the loopback
  address, and `localhost` can resolve to `::1` first

### Security
- The validator JAR - which is then run - is only downloaded over https, and only from GitHub
  (`github.com`, `*.githubusercontent.com`); a redirect anywhere else is refused
- `start()` checks the configuration it turns into command line arguments (`version`,
  `txServer`, `txLog`, `port`, `igs`), so a value that starts with `-` cannot be taken by the
  validator as an option of its own; `loadIG()` checks its package id and version the same way.
  `extraArgs` containing `-allowNetworkAccess` is logged as a warning: the service has no
  authentication, so anything that can reach the port can validate, load packages and stop it
- Responses from the validator service are bounded (64MB), and a response that is not JSON is
  reported by status and size rather than echoed into the error message, which callers tend to
  pass on to their own clients
- The validator process is killed when the process that started it exits, so it does not
  live on holding the port

### Added
- `validate()` options: `extensions`, `checkIpsCodes`, `params` (any other `/validateResource`
  parameter by its validator name), and `timeout` for the request

## [1.4.0]

### Added
- `folder` and `label` on `runTxTest(params)`. `folder` names the directory the run writes its
  expected/actual files into (a name, not a path - it goes under the validator's temp
  directory), instead of the validator taking the name from the terminology server's host.
  `label` is a subfolder of that for one test's output. Without them, a caller that runs the
  same test more than one way - R4 and R5, cached and not - has every run writing the same two
  filenames, so only the last one survives and nothing says which one it was
- `lastOutput`, the tail of everything the validator process wrote, stdout and stderr both.
  `lastStderr` is unchanged and still stderr alone

### Fixed
- A validator that died during startup was reported as `Validator exited with code 1` and nothing
  else, because the wrapper kept only stderr and the validator logs through logback, which writes
  to stdout - so the stack trace saying why it could not start was thrown away. The error now
  carries the tail of the output. Both buffers are now bounded, rather than holding everything a
  long-lived validator ever logged
- `start()` raced the readiness poll against the process dying, but only the race was settled -
  the poll went on running. A validator that failed to start left a one-second timer going for
  the rest of the configured timeout, long after `start()` had rejected: a minute of polling a
  dead port, log lines arriving after the caller had moved on, and a test runner that would not
  exit. The poll now stops when the process does
- Validator output was being logged in fragments, with single lines broken in two at a
  different point every run. A 'data' event carries a chunk, not a line, and each chunk was
  being split on its own; the tail of a chunk is now held until the newline that ends it
  arrives, and flushed when the process closes. This also fixes version detection, which could
  miss when the version string landed either side of a chunk boundary
- The stderr handler was registered twice, so every line from stderr was logged twice
- `runTxTest` sent the externals file as `externalFile`; the validator reads `externals`, so a
  caller that named a messages file was quietly given the default one instead
- The validator is started with `server` rather than `-server`. The dashed form still works but
  the CLI maps it and warns about it on every start

## [v1.3.0] - 2026-08-06

### Added
- `ssrfProtection` option on `start(config)`. Validator 6.10.0 and later enable SSRF protection by
  default, which blocks http:// URLs and connections to localhost and private network addresses.
  Set `ssrfProtection: false` to pass `-ssrf-protection-enabled false` to the validator, for setups
  such as test harnesses that point the validator at a terminology server on the local machine.
  A warning is logged whenever protection is disabled.
- `extraArgs` option on `start(config)`, appending raw arguments to the validator command line for
  options this wrapper does not model explicitly.

## [v1.2.2] - 2026-02-12

### Added
- Better logging when validator fails to load

## [v1.2.1] - 2026-01-31

### Added
- Add jarVersion()

## [v1.2.0] - 2026-01-30

### Added
- Added auto-download functionality
- Added txTests support

## [v1.1.0] - 2025-08-07

### Added
- Add logger support

## [v1.0.0] - 2025-07-??

First release