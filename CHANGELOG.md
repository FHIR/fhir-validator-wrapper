# Changelog

All notable changes to the FHIR Validator Wrapper will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0] - 2026-11-06

### Added
- Terminology test sessions (validator 7.0.4 and later): `txTestSetup()` starts a run against a server and
  fixes its test case version, externals and output folder; `runTxTest({session, suiteName, testName, ...})`
  runs one test in it; `txTestTeardown()` ends it and returns the reports (test-results and a TestReport).
  The older form of `runTxTest()`, with a server and no session, still works - but the validator keeps one
  run per server, set up by the first call, so a later call's `folder` or `externalFile` was quietly ignored,
  and the run's reports were never written
- `verifyJar` on `start()` (`verify` on `ensureValidator()`): check the validator jar against the sha256
  digest GitHub gives for the release asset - a download, and a jar already on disk. Off by default
- `logCommandLine` on `start()`: log the whole validator command line
- `autoLoadPackages` on `start()` (validator 7.0.5 and later): the validator is started with
  `-autoLoadPackages`, and `lookupCanonical()` of a resource it doesn't know (with no version) has it
  find, download and load the package that defines it. Off by default. `lookupCanonical()` waits up to
  5 minutes when it is on

### Security
- A download of the validator jar is only put in place once all of it has arrived - as many bytes as the
  server sent and the release says the jar has. A download cut short used to be renamed into place and its
  version recorded, so it was never downloaded again. A connection that dropped part way left `start()`
  waiting forever; it now fails. Each download has a temporary file of its own, so two starts that share a
  jar can't write into the same one, and a failed download leaves no temporary file behind
- `start()` passes the validator a random `-nonce` (validator 7.0.5 and later; `nonce: false` turns it off), and
  only takes the service as ready when the answer carries it back. A validator left running by an earlier
  process - or anything else on the port - was taken for the new one, and sent the resources to validate
- `validate()` tells the validator (6.9.0 and later) to stop validating at 90% of the request's `timeout`.
  The validator's service handles one request at a time, and went on with a validation the wrapper had
  given up on, holding up everything behind it
- The logged command line hides credentials in URLs, and counts the `extraArgs` rather than showing them
  (see `logCommandLine`), and never shows the nonce
- Validator output is logged with all escape sequences and control characters taken out (and the Unicode
  bidi overrides), not just colour codes: it includes text from terminology servers and from content
- A failed `runTxTest()` reports the validator's message, or the status and size of the response - not the
  whole response. GitHub's answer to the release check is bounded too
- The `-allowNetworkAccess` warning also catches `-allowNetworkAccess=true`, and warns that a validator older
  than 7.0.4 has its terminology test endpoints always on. `extraArgs` that isn't an array is refused

### Changed
- `txTests: true` passes a bare `-txTests` again to validator 7.0.5 and later, which take it after the
  `server` command; `-txTests=true` (the 1.6.3 workaround) is kept for 7.0.4, and for a validator whose
  version isn't known
- Needs Node.js 22 or later (it said 12, but has needed 14 for a while)

### Fixed
- `lookupCanonical()` and its documentation said `/canonical` came with validator 7.0.4; it came with 7.0.5

## [1.6.3] - 2026-11-03

### Fixed
- `txTests: true` didn't turn on the validator's terminology test endpoints with validator 7.0.4, so
  every `runTxTest()` failed with a 404 ("The terminology test endpoints are not enabled on this
  server"). Validator 7.0.4 rewrites a bare `-txTests` anywhere on its command line to the old
  `txTests` command, and the server then read it as a source file. The wrapper now passes
  `-txTests=true`, which isn't rewritten and sets the same option

## [1.6.2] - 2026-11-01

### Added
- `checkFhirPath(type, expression)`: static type checking of a FHIRPath expression, without
  evaluating it (the service's `/fhirpath/check`). Returns the OperationOutcome - errors when the
  expression doesn't parse or check, the checker's warnings, and what the expression returns
- `lookupCanonical(url, version)`: a canonical resource (StructureDefinition, ValueSet,
  CodeSystem...) as the validator's context knows it (the service's `/canonical`), or `null` when
  it doesn't know it
- Both need validator 7.0.4 or later, and reject with a message saying so when the validator
  doesn't have the endpoint

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