# Changelog

All notable changes to the FHIR Validator Wrapper will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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