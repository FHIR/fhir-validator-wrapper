[![npm version](https://badge.fury.io/js/fhir-validator-wrapper.svg)](https://badge.fury.io/js/fhir-validator-wrapper)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-yellow.svg)]
[![Downloads](https://img.shields.io/npm/dm/fhir-validator-wrapper.svg)](https://www.npmjs.com/package/fhir-validator-wrapper)

# FHIR Validator Wrapper

A Node.js wrapper for the HL7 FHIR Validator CLI that provides a simple, promise-based API for validating FHIR resources.

## FHIR Foundation Project Statement

* Maintainers: Grahame Grieve (looking for volunteers)
* Issues / Discussion: https://github.com/FHIR/fhir-validator-wrapper/issues / https://chat.fhir.org/#narrow/channel/179169-javascript
* License: Apache 2.0
* Contribution Policy: See [Contributing](#contributing).
* Security Information: To report a security issue, please use the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/FHIR/fhir-validator-wrapper/security/advisories/new) tab.

## Contributing

There are many ways to contribute:
* [Submit bugs](https://github.com/FHIR/fhir-validator-wrapper/issues) and help us verify fixes as they are checked in.
* Review the [source code changes](https://github.com/FHIR/fhir-validator-wrapper/pulls).
* Engage with users and developers on the [dotnet stream on FHIR Zulip](https://chat.fhir.org/#narrow/channel/179169-javascript)
* Contribute features or bug fixes via PRs:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## Overview

This library manages the lifecycle of the FHIR Validator Java service and provides a clean Node.js interface for validation operations. It handles automatic downloading of the validator JAR, process management, HTTP communication, and provides typed validation options.

## Features

- **Automatic JAR Management**: Automatically downloads and updates the FHIR Validator CLI JAR from GitHub releases
- **Version Tracking**: Tracks installed version and checks for updates
- **Resource Validation**: Validate FHIR resources in JSON or XML format
- **Profile Validation**: Validate against specific FHIR profiles
- **Implementation Guide Support**: Load IGs at startup or runtime
- **Terminology Testing**: Run terminology server tests with `runTxTest`

## Prerequisites

- Node.js 12.0.0 or higher
- Java 8 or higher
- Internet connection (for automatic JAR download, or manually download from [GitHub releases](https://github.com/hapifhir/org.hl7.fhir.core/releases))

## Installation

```bash
npm install fhir-validator-wrapper
```

## Quick Start

```javascript
const FhirValidator = require('fhir-validator-wrapper');

async function validateResource() {
  // The JAR will be automatically downloaded if not present
  const validator = new FhirValidator('./validator_cli.jar');
  
  try {
    // Start the validator service (auto-downloads JAR if needed)
    await validator.start({
      version: '5.0.0',
      txServer: 'http://tx.fhir.org/r5',
      txLog: './txlog.txt',
      igs: ['hl7.fhir.us.core#6.0.0']
    });
    
    // Validate a resource
    const patient = {
      resourceType: 'Patient',
      id: 'example',
      active: true,
      name: [{ family: 'Doe', given: ['John'] }]
    };
    
    const result = await validator.validate(patient);
    console.log('Validation result:', result);
    
  } finally {
    await validator.stop();
  }
}
```

## API Reference

### Constructor

#### `new FhirValidator(validatorJarPath, logger)`

Creates a new FHIR validator instance.

- `validatorJarPath` (string): Path to the FHIR validator CLI JAR file (will be downloaded here if not present)
- `logger` (Object, optional): Winston logger instance for custom logging

### Methods

#### `ensureValidator(options)`

Checks for and downloads/updates the validator JAR as needed. This is called automatically by `start()` when `autoDownload` is enabled.

**Parameters:**
- `options` (Object, optional): Configuration object
  - `force` (boolean): Force download even if current version is up to date (default: false)
  - `skipUpdateCheck` (boolean): Skip checking for updates if JAR exists (default: false)

**Returns:** `Promise<{version: string, updated: boolean, downloaded: boolean}>`

**Example:**
```javascript
const validator = new FhirValidator('./validator_cli.jar');

// Check for updates and download if needed
const result = await validator.ensureValidator();
console.log(`Version: ${result.version}`);
console.log(`Downloaded: ${result.downloaded}`);
console.log(`Updated: ${result.updated}`);

// Force re-download
await validator.ensureValidator({ force: true });

// Skip update check (use existing JAR)
await validator.ensureValidator({ skipUpdateCheck: true });
```

#### `getLatestRelease()`

Fetches the latest release information from GitHub.

**Returns:** `Promise<{version: string, downloadUrl: string, publishedAt: string}>`

**Example:**
```javascript
const latest = await validator.getLatestRelease();
console.log(`Latest version: ${latest.version}`);
console.log(`Published: ${latest.publishedAt}`);
```

#### `getInstalledVersion()`

Gets the currently installed validator version.

**Returns:** `string|null` - The installed version or null if not installed

#### `start(config)`

Starts the FHIR validator service with the specified configuration.

**Parameters:**
- `config` (Object): Configuration object
  - `version` (string): FHIR version (e.g., "5.0.0", "4.0.1")
  - `txServer` (string): Terminology server URL (e.g., "http://tx.fhir.org/r5")
  - `txLog` (string): Path to transaction log file
  - `igs` (string[], optional): Array of implementation guide packages
  - `port` (number, optional): Port to run the service on (default: 8080)
  - `timeout` (number, optional): Startup timeout in milliseconds (default: 30000)
  - `autoDownload` (boolean, optional): Automatically download/update validator JAR (default: true)
  - `skipUpdateCheck` (boolean, optional): Skip checking for updates if JAR exists (default: false)
  - `ssrfProtection` (boolean, optional): SSRF protection in the validator (default: true). See [SSRF Protection](#ssrf-protection) below
  - `extraArgs` (string[], optional): Additional raw command line arguments appended to the validator invocation

**Returns:** `Promise<void>`

**Example:**
```javascript
await validator.start({
  version: '5.0.0',
  txServer: 'http://tx.fhir.org/r5',
  txLog: './txlog.txt',
  igs: [
    'hl7.fhir.us.core#6.0.0',
    'hl7.fhir.uv.sdc#3.0.0'
  ],
  port: 8080,
  autoDownload: true,      // Download JAR if missing (default)
  skipUpdateCheck: true    // Don't check for updates every time
});
```

##### SSRF Protection

From version 6.10.0 the FHIR validator enables Server-Side Request Forgery protection by default. With
protection on, the validator refuses `http://` URLs, and refuses to connect to non-public addresses -
`localhost`, `127.0.0.1`, and private network ranges. This protects against content under an attacker's
control directing the validator at internal network resources.

That default breaks any setup where the validator is deliberately pointed at a terminology server on the
local machine, which is typical of test harnesses:

```javascript
await validator.start({
  version: '4.0',
  txServer: 'http://localhost:9095/r5',  // blocked when SSRF protection is on
  txLog: './txlog.txt',
  port: 9096,
  ssrfProtection: false
});
```

Setting `ssrfProtection: false` passes `-ssrf-protection-enabled false` to the validator, which turns off
both the https requirement and the non-public address check, globally, for that validator process. This
also applies to servers the validator is asked to reach later - for example the `server` parameter of
`runTxTest()`.

Only do this where no untrusted party can influence any of the content being processed, or where the
validator runs somewhere internal network access poses no risk. The wrapper logs a warning whenever
protection is disabled.

When `ssrfProtection` is not set, the wrapper passes no option at all, leaving the validator to use its own
default and any `ssrfProtectionEnabled` setting in `fhir-settings.json`.

##### Extra arguments

`extraArgs` appends raw arguments to the validator command line, for options this wrapper does not model:

```javascript
await validator.start({
  version: '5.0.0',
  txServer: 'https://tx.fhir.org/r5',
  txLog: './txlog.txt',
  extraArgs: ['-fhir-settings', '/path/to/fhir-settings.json']
});
```

Arguments are passed through unquoted via `spawn()`, so no shell escaping is needed or applied.

#### `validate(resource, options)`

Validates a FHIR resource against the loaded implementation guides and profiles.

**Parameters:**
- `resource` (string|Buffer|Object): The resource to validate
  - String: JSON or XML resource
  - Buffer: Raw bytes of resource
  - Object: JavaScript object representing the resource
- `options` (Object, optional): Validation options
  - `profiles` (string[]): Profiles to validate against
  - `resourceIdRule` (string): Resource ID rule ("OPTIONAL", "REQUIRED", "PROHIBITED")
  - `anyExtensionsAllowed` (boolean): Whether any extensions are allowed (default: true)
  - `bpWarnings` (string): Best practice warning level
  - `displayOption` (string): Display option for validation

**Returns:** `Promise<Object>` - OperationOutcome as JavaScript object

**Examples:**
```javascript
// Basic validation
const result = await validator.validate(patientResource);

// Validation with options
const result = await validator.validate(patientResource, {
  profiles: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient'],
  resourceIdRule: 'REQUIRED',
  bpWarnings: 'Warning'
});
```

#### `validateBytes(resourceBytes, format, options)`

Validates a FHIR resource from raw bytes.

**Parameters:**
- `resourceBytes` (Buffer): The resource as bytes
- `format` (string, optional): The format ("json" or "xml", default: "json")
- `options` (Object, optional): Same as `validate()` method

**Returns:** `Promise<Object>` - OperationOutcome as JavaScript object

#### `validateObject(resourceObject, options)`

Validates a FHIR resource object.

**Parameters:**
- `resourceObject` (Object): The resource as a JavaScript object
- `options` (Object, optional): Same as `validate()` method

**Returns:** `Promise<Object>` - OperationOutcome as JavaScript object

#### `loadIG(packageId, version)`

Loads an additional implementation guide at runtime.

**Parameters:**
- `packageId` (string): The package ID (e.g., "hl7.fhir.us.core")
- `version` (string): The version (e.g., "6.0.0")

**Returns:** `Promise<Object>` - OperationOutcome as JavaScript object

**Example:**
```javascript
await validator.loadIG('hl7.fhir.uv.ips', '1.1.0');
```

#### `runTxTest(params)`

Runs a single terminology service test case against a terminology server. The test cases are the ones
published by the [tx-ecosystem IG](https://hl7.org/fhir/uv/tx-ecosystem/testcases.html); the validator
fetches them itself, so there is nothing to download.

One call runs one test, which is the point: your own test framework gets one result per test - what is
newly failing, and why - rather than the whole run reduced to a single pass or fail. The test cases and
the server's setup resources are loaded once, on the first call for a given server, and reused.

**Parameters:**
- `params` (Object): Test parameters
  - `server` (string, required): The address of the terminology server to test
  - `suiteName` (string, required): The suite that contains the test to run
  - `testName` (string, required): The test to run, within that suite
  - `version` (string, required): The FHIR version of the test cases to load, e.g. `'5.0'` or `'4.0'`
  - `externalFile` (string, optional): The name of the messages file in the test package that lets your
    server use its own wording for messages. Defaults to `messages-tx.fhir.org.json`; `.json` is
    appended if you leave it off
  - `modes` (string, optional): Comma delimited list of modes - see [Modes](#modes) below
  - `folder` (string, optional): The directory the test's output is written to, as a simple name rather
    than a path - see [Test output](#test-output) below. Requires validator 6.10.5 or later
  - `label` (string, optional): A subfolder of `folder` for this test's output. Requires validator
    6.10.5 or later

**Returns:** `Promise<{result: boolean, message?: string}>` - `result` is true if the test passed.
When it is false, `message` says why: the first difference between the expected response and the one
the server gave, or the transport or HTTP error that stopped the test running at all.

**Example:**
```javascript
// Run a terminology server test
const result = await validator.runTxTest({
  server: 'http://tx-dev.fhir.org',
  suiteName: 'metadata',
  testName: 'metadata',
  version: '5.0'
});

if (result.result) {
  console.log('Test passed!');
} else {
  console.log('Test failed:', result.message);
}
```

##### Modes

Many of the test cases only apply to servers with particular characteristics, and are gated on a mode:
`general` (the tests every server is expected to pass), `snomed`, `omop`, `icd-11`, `mimetypes`, `flat`
for servers that return flat expansions, and `tx.fhir.org` for tests specific to that one server. The
[Modes](https://hl7.org/fhir/uv/tx-ecosystem/testcases.html#modes) section of the IG has the current list.

`modes` replaces the mode set for that call, so pass every mode your server supports:

```javascript
const result = await validator.runTxTest({
  server: 'http://localhost:9095/r5',
  suiteName: 'expansions',
  testName: 'expand-simple',
  version: '5.0',
  modes: 'general,snomed,icd-11'
});
```

If a test is gated on a mode you did not pass, it does not run, and the wrapper returns
`result: false` with a message naming the mode that would have run it and the modes you asked for. It
is not a failure of your server, but it is not a pass either, and reporting it as one would hide a
whole suite that never ran.

Omitting `modes` altogether does not mean "just the general tests": the validator falls back to a
default set that includes `tx.fhir.org`, and no server other than tx.fhir.org is expected to pass those.
Pass the modes you mean.

##### Test output

For each **failing** test the validator writes the expected response and the response the server actually
gave, as a pair of files with the same name, so they can be compared with a diff tool. They go under the
validator's temporary directory, in `{folder}/{label}/expected` and `{folder}/{label}/actual`. `folder`
defaults to the terminology server's host name, and there is no subfolder if `label` is not given.

`folder` and `label` must each be a simple name - `[A-Za-z0-9][A-Za-z0-9._-]*`, not a path, and not a
Windows device name. An invalid one is rejected rather than being written somewhere unexpected.

`label` matters if you run the same tests more than one way. Every run of a test writes the same two
filenames, so a suite run against R4 and R5, with and without server caching, has each run overwriting
the last one's output - and a test that fails in only one of those variants can leave nothing behind
to look at. Give each variant its own label:

```javascript
const result = await validator.runTxTest({
  server: txServerUrl,
  suiteName: suite,
  testName: test,
  version: '4.0',
  modes: 'general,snomed',
  folder: 'my-server',
  label: 'r4-cached'
});
```

#### `stop()`

Stops the validator service and cleans up resources.

**Returns:** `Promise<void>`

#### `isRunning()`

Checks if the validator service is currently running.

**Returns:** `boolean`

#### `healthCheck()`

Performs a health check on the running service.

**Returns:** `Promise<void>`

## Automatic JAR Download

The library automatically manages the FHIR Validator CLI JAR file:

### Default Behavior
When you call `start()`, the library will:
1. Check if the JAR file exists at the specified path
2. If missing, download the latest version from GitHub releases
3. Track the version in a `.version` file alongside the JAR

### Version Tracking
Version information is stored in `{jarPath}.version`:
```json
{
  "version": "6.3.4",
  "downloadUrl": "https://github.com/hapifhir/org.hl7.fhir.core/releases/...",
  "downloadedAt": "2024-01-15T10:30:00.000Z"
}
```

### Update Strategies

```javascript
// Always check for updates (default)
await validator.start({
  version: '5.0.0',
  txServer: 'http://tx.fhir.org/r5',
  txLog: './txlog.txt'
});

// Skip update check for faster startup
await validator.start({
  version: '5.0.0',
  txServer: 'http://tx.fhir.org/r5',
  txLog: './txlog.txt',
  skipUpdateCheck: true
});

// Disable auto-download entirely (JAR must exist)
await validator.start({
  version: '5.0.0',
  txServer: 'http://tx.fhir.org/r5',
  txLog: './txlog.txt',
  autoDownload: false
});
```

### Manual Download Management

```javascript
const validator = new FhirValidator('./validator_cli.jar');

// Check what's available vs installed
const latest = await validator.getLatestRelease();
const installed = validator.getInstalledVersion();

console.log(`Latest: ${latest.version}`);
console.log(`Installed: ${installed || 'not installed'}`);

// Download/update without starting service
const result = await validator.ensureValidator();

// Force re-download
await validator.ensureValidator({ force: true });
```

### Download-Only Mode

```bash
# Use the example script to just download/update the JAR
node example.js --download-only
```

## Implementation Guide Loading

Implementation guides can be loaded in two ways:

1. **At startup** (recommended for known dependencies):
```javascript
await validator.start({
  version: '5.0.0',
  txServer: 'http://tx.fhir.org/r5',
  txLog: './txlog.txt',
  igs: [
    'hl7.fhir.us.core#6.0.0',
    'hl7.fhir.uv.sdc#3.0.0'
  ]
});
```

2. **At runtime** (for dynamic loading):
```javascript
await validator.loadIG('hl7.fhir.uv.ips', '1.1.0');
```

For IG package format documentation, see: [Using the FHIR Validator - Loading Implementation Guides](https://confluence.hl7.org/spaces/FHIR/pages/35718580/Using+the+FHIR+Validator#UsingtheFHIRValidator-LoadinganimplementationGuide)

## Error Handling

The library throws descriptive errors for various failure scenarios:

```javascript
try {
  await validator.validate(invalidResource);
} catch (error) {
  if (error.message.includes('Validation failed')) {
    // Handle validation errors
    console.log('Resource is invalid:', error.message);
  } else if (error.message.includes('not ready')) {
    // Handle service not ready
    console.log('Service not started:', error.message);
  } else {
    // Handle other errors
    console.log('Unexpected error:', error.message);
  }
}
```

## Best Practices

1. **Resource Management**: Always call `stop()` when done to clean up the Java process:
```javascript
try {
  await validator.start(config);
  // ... validation operations
} finally {
  await validator.stop();
}
```

2. **Process Termination Handling**: Handle graceful shutdown:
```javascript
process.on('SIGINT', async () => {
  await validator.stop();
  process.exit(0);
});
```

3. **Reuse Validator Instance**: Start the validator once and reuse for multiple validations:
```javascript
const validator = new FhirValidator('./validator_cli.jar');
await validator.start(config);

// Validate multiple resources
const result1 = await validator.validate(resource1);
const result2 = await validator.validate(resource2);
const result3 = await validator.validate(resource3);

await validator.stop();
```

4. **Timeout Configuration**: Set appropriate timeouts for startup in production:
```javascript
await validator.start({
  // ... other config
  timeout: 120000 // 2 minutes for production environments
});
```

5. **Skip Update Checks in CI/CD**: For faster builds, skip update checks:
```javascript
await validator.start({
  // ... other config
  skipUpdateCheck: true
});
```

## Testing

The library includes comprehensive tests. You can run them in different ways depending on your setup:

### Unit Tests Only
```bash
npm run test:unit
```

### GitHub API Tests (requires network)
```bash
GITHUB_API_TESTS=1 npm test
```

### Download Tests (downloads ~300MB JAR)
```bash
DOWNLOAD_TESTS=1 npm test
```

### Integration Tests (requires JAR file and network)
```bash
# With auto-download
INTEGRATION_TESTS=1 npm test

# With specific JAR path
FHIR_VALIDATOR_JAR_PATH=./your-validator.jar INTEGRATION_TESTS=1 npm test
```

### Manual Testing
```bash
# Quick manual test (auto-downloads JAR if needed)
INTEGRATION_TESTS=1 npm run test:manual
```

## Troubleshooting

### Common Issues

1. **Java not found**: Ensure Java is installed and available in PATH
2. **JAR download fails**: Check internet connection and GitHub accessibility
3. **Port conflicts**: Change the port if 8080 is already in use
4. **Memory issues**: Add JVM options by modifying the spawn command if needed
5. **Network timeouts**: Increase timeout values for slow networks
6. **GitHub rate limits**: Use `skipUpdateCheck: true` to avoid repeated API calls

### Debug Logging

The library logs validator stdout/stderr for debugging. You can provide a Winston logger for custom logging:

```javascript
const winston = require('winston');
const logger = winston.createLogger({
  level: 'debug',
  transports: [new winston.transports.Console()]
});

const validator = new FhirValidator('./validator_cli.jar', logger);
// Or set later:
validator.setLogger(logger);
```

## Support

For issues with this wrapper, please file a GitHub issue.
For FHIR validator issues, see the [official FHIR validator documentation](https://confluence.hl7.org/spaces/FHIR/pages/35718580/Using+the+FHIR+Validator).

## Release Process

Releases are cut from `main`. The bump, the commit and the tag all come from a single `npm version`
command, so the steps are shorter than they look.

**Do not edit `version` in package.json by hand.** `npm version` derives the new version from whatever
is in package.json already, so a hand-edited version makes it overshoot — leave package.json at the
*last released* version and let step 2 move it.

1. **Land everything, including the changelog.** Add the entry for the version about to be released to
   CHANGELOG.md, and commit it with the rest of the release. `npm version` refuses to run against a
   dirty working tree.

2. **Bump, commit and tag** — one command, pick the one that matches the change:

   ```
   npm version minor    # new features, e.g. 1.2.2 -> 1.3.0
   npm version patch    # fixes only,   e.g. 1.2.2 -> 1.2.3
   ```

   This is the step that does the work. It rewrites `version` in package.json, makes a commit whose
   message is the bare version number (`1.3.0`), and creates the matching git tag (`v1.3.0`). It prints
   the new version when it's done.

3. **Push the commit and the tag** — `git push` alone does not push tags:

   ```
   git push && git push --tags
   ```

4. **Publish to npm:**

   ```
   npm whoami           # if this errors, run `npm login` first - it is not needed every release
   npm publish
   ```

   `npm version` does *not* publish. Skip this and the tag exists but nothing reaches npm. Confirm with:

   ```
   npm view fhir-validator-wrapper version
   ```

