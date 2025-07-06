# FHIR Validator Wrapper

A Node.js wrapper for the HL7 FHIR Validator CLI that provides a simple, promise-based API for validating FHIR resources.

## Overview

This library manages the lifecycle of the FHIR Validator Java service and provides a clean Node.js interface for validation operations. It handles process management, HTTP communication, and provides typed validation options.

## FHIR Foundation Project Statement

* Maintainers: Grahame Grieve
* Issues / Discussion: https://github.com/FHIR/node-fhir-validator/issues / https://chat.fhir.org/#narrow/channel/179169-javascript
* License: MIT
* Contribution Policy: Normal open source rules - all contributions through public channels
* Security Information: Use normal GitHub security channels to report security issues

## Prerequisites

- Node.js 12.0.0 or higher
- Java 8 or higher
- FHIR Validator CLI JAR file (download from [GitHub releases](https://github.com/hapifhir/org.hl7.fhir.core/releases))

## Installation

```bash
npm install fhir-validator-wrapper
```

## Quick Start

```javascript
const FhirValidator = require('fhir-validator-wrapper');

async function validateResource() {
  const validator = new FhirValidator('./validator_cli.jar');
  
  try {
    // Start the validator service
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

#### `new FhirValidator(validatorJarPath)`

Creates a new FHIR validator instance.

- `validatorJarPath` (string): Path to the FHIR validator CLI JAR file

### Methods

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
  port: 8080
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

#### `stop()`

Stops the validator service and cleans up resources.

**Returns:** `Promise<void>`

#### `isRunning()`

Checks if the validator service is currently running.

**Returns:** `boolean`

#### `healthCheck()`

Performs a health check on the running service.

**Returns:** `Promise<void>`

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

## Troubleshooting

### Common Issues

1. **Java not found**: Ensure Java is installed and available in PATH
2. **JAR file not found**: Verify the validator JAR path is correct
3. **Port conflicts**: Change the port if 8080 is already in use
4. **Memory issues**: Add JVM options by modifying the spawn command if needed
5. **Network timeouts**: Increase timeout values for slow networks

### Debug Logging

The library logs validator stdout/stderr for debugging. Check console output for Java process messages.

## License

MIT

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## Support

For issues with this wrapper, please file a GitHub issue.
For FHIR validator issues, see the [official FHIR validator documentation](https://confluence.hl7.org/spaces/FHIR/pages/35718580/Using+the+FHIR+Validator).
