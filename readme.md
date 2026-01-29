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

Runs a terminology server test against a specified server.

**Parameters:**
- `params` (Object): Test parameters
  - `server` (string): The address of the terminology server to test
  - `suiteName` (string): The suite name that contains the test to run
  - `testName` (string): The test name to run
  - `version` (string): What FHIR version to use for the test
  - `externalFile` (string, optional): Name of messages file
  - `modes` (string, optional): Comma delimited string of modes

**Returns:** `Promise<{result: boolean, message?: string}>`

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

// With optional parameters
const result = await validator.runTxTest({
  server: 'http://tx-dev.fhir.org',
  suiteName: 'expand',
  testName: 'expand-test-1',
  version: '5.0',
  modes: 'lenient,tx-resource-cache'
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