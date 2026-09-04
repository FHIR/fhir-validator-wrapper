# Changelog

All notable changes to the FHIR Validator Wrapper will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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