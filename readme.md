# FHIR Validator Service for Node.js

A Node.js wrapper for the FHIR Java Validator using the NativeHostServices interface. This allows you to integrate FHIR validation capabilities directly into your Node.js applications.

## Prerequisites

- **Node.js**: Version 14.0.0 or higher
- **Java**: JDK 11 or higher (required for the FHIR validator)
- **Memory**: At least 4GB available RAM (validator is memory-intensive)

## Installation

1. **Install Node.js dependencies:**
   ```bash
   npm install
   ```

2. **Download required FHIR validator files:**

   Create the necessary directories:
   ```bash
   mkdir -p lib definitions igs cache logs profiles
   ```

   **Get the FHIR Validator JAR:**
   ```bash
   # Download the latest validator CLI JAR
   curl -L -o lib/validator_cli.jar https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar
   ```

   **Get FHIR definitions:**
   ```bash
   # Download FHIR R4 definitions
   curl -L -o definitions/definitions.xml.zip http://hl7.org/fhir/R4/definitions.xml.zip
   
   # Or for R5
   curl -L -o definitions/definitions.xml.zip http://hl7.org/fhir/R5/definitions.xml.zip
   ```

   **Get Implementation Guides (optional):**
   ```bash
   # Example: US Core IG
   curl -L -o igs/us-core-ig.tgz https://packages.fhir.org/us.core/6.1.0
   ```

## Basic Usage

```javascript
const FHIRValidatorService = require('./validator-service');

async function validateResource() {
  const validator = new FHIRValidatorService();
  
  try {
    // Configure Java environment
    await validator.configureJava('./lib/validator_cli.jar', {
      javaOptions: '-Xmx4g'
    });
    
    // Initialize with FHIR definitions
    await validator.initialize('./definitions/definitions.xml.zip');
    
    // Connect to terminology server
    await validator.connectToTerminologyServer('http://tx.fhir.org/r4');
    
    // Validate a resource
    const patientJson = {
      "resourceType": "Patient",
      "id": "example",
      "active": true,
      "name": [{"family": "Doe", "given": ["John"]}]
    };
    
    const resourceBytes = Buffer.from(JSON.stringify(patientJson));
    const result = await validator.validateResource(resourceBytes, 'JSON');
    
    const operationOutcome = JSON.parse(result.toString());
    console.log('Validation result:', operationOutcome);
    
  } finally {
    await validator.shutdown();
  }
}

validateResource().catch(console.error);
```

## Express.js Integration

```javascript
const express = require('express');
const FHIRValidatorService = require('./validator-service');

const app = express();
app.use(express.json());

let validator;

// Initialize validator on startup
async function initializeValidator() {
  validator = new FHIRValidatorService();
  await validator.configureJava('./lib/validator_cli.jar');
  await validator.initialize('./definitions/definitions.xml.zip');
  await validator.connectToTerminologyServer('http://tx.fhir.org/r4');
  console.log('FHIR Validator ready');
}

// Validation endpoint
app.post('/validate', async (req, res) => {
  try {
    const { resource } = req.body;
    const resourceBytes = Buffer.from(JSON.stringify(resource));
    
    const result = await validator.validateResource(resourceBytes, 'JSON');
    const operationOutcome = JSON.parse(result.toString());
    
    res.json({
      operationOutcome,
      isValid: !operationOutcome.issue?.some(i => i.severity === 'error')
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
initializeValidator().then(() => {
  app.listen(3000, () => {
    console.log('FHIR validation server running on port 3000');
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await validator.shutdown();
  process.exit(0);
});
```

## API Reference

### FHIRValidatorService

#### Methods

**`configureJava(jarPath, options)`**
- Configure the Java environment and load the validator JAR
- `jarPath`: Path to validator_cli.jar
- `options.javaOptions`: JVM options (default: '-Xmx4g')
- `options.classpath`: Additional classpath entries

**`initialize(definitionsPath)`**
- Initialize the validator with FHIR definitions
- `definitionsPath`: Path to definitions.xml.zip

**`loadIG(igPath)`**
- Load an Implementation Guide
- `igPath`: Path to IG package (.tgz file)

**`connectToTerminologyServer(url, logPath, txCache)`**
- Connect to a terminology server
- `url`: Terminology server URL
- `logPath`: Optional log file path
- `txCache`: Optional terminology cache directory

**`validateResource(resourceBytes, format, location, options)`**
- Validate a FHIR resource
- `resourceBytes`: Resource as Buffer
- `format`: 'JSON', 'XML', or 'TURTLE'
- `location`: Description for error context
- `options`: Validation options object
- Returns: OperationOutcome as Buffer

**`seeResource(resourceBytes, format)`**
- Add a resource to validator context (profiles, valuesets, etc.)

**`getStatus()`**
- Get validator status and statistics

**`shutdown()`**
- Clean up and shutdown the validator

#### Validation Options

```javascript
const options = {
  idRule: 'id-optional',        // 'id-optional', 'id-required', 'id-prohibited'
  extensionRule: 'any-extensions', // 'any-extensions', 'strict-extensions'
  bestPractice: 'bp-warning',   // 'bp-ignore', 'bp-hint', 'bp-warning', 'bp-error'
  displayCheck: 'display-ignore' // 'display-ignore', 'display-check', etc.
};
```

## Configuration

### Memory Settings

The FHIR validator is memory-intensive. Adjust JVM settings based on your needs:

```javascript
await validator.configureJava('./lib/validator_cli.jar', {
  javaOptions: '-Xmx8g -Xms2g'  // 8GB max, 2GB initial
});
```

### Terminology Server Options

```javascript
// Public terminology server
await validator.connectToTerminologyServer('http://tx.fhir.org/r4');

// Local terminology server
await validator.connectToTerminologyServer('http://localhost:8080/fhir');

// With caching
await validator.connectToTerminologyServer(
  'http://tx.fhir.org/r4',
  './logs/terminology.log',
  './cache/terminology-cache'
);
```

### Multiple Implementation Guides

```javascript
// Load multiple IGs
await validator.loadIG('./igs/us-core-6.1.0.tgz');
await validator.loadIG('./igs/qicore-4.1.1.tgz');
await validator.loadIG('./igs/cqfm-measures-4.0.0.tgz');
```

## Troubleshooting

### Common Issues

**"Java heap space" errors:**
- Increase JVM heap size: `-Xmx8g` or higher
- Ensure you have sufficient system RAM

**"Class not found" errors:**
- Verify the validator JAR path is correct
- Check that all required JARs are in the classpath

**Validation is slow:**
- Use terminology caching
- Consider running a local terminology server
- Pre-load all required IGs at startup

**"Address already in use" (terminology server):**
- Check if another process is using the terminology server
- Use a different port or server URL

### Performance Tips

1. **Initialize once**: Create the validator service once and reuse it
2. **Use caching**: Enable terminology caching for better performance
3. **Preload resources**: Load all IGs and profiles at startup
4. **Monitor memory**: Check validator status regularly

### Debugging

Enable detailed logging:

```javascript
// Add logging to terminology operations
await validator.connectToTerminologyServer(
  'http://tx.fhir.org/r4',
  './logs/detailed-terminology.log'
);

// Check validator status
const status = await validator.getStatus();
console.log('Memory usage:', status['mem-used'], 'MB');
console.log('Validation count:', status['validation-count']);
```

## Testing

Run the included test suite:

```bash
npm test
```

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

## Support

For issues related to:
- **This Node.js wrapper**: Open an issue in this repository
- **FHIR Validator itself**: Check the [FHIR Validator repository](https://github.com/hapifhir/org.hl7.fhir.core)
- **FHIR Specification**: Visit [HL7 FHIR](http://hl7.org/fhir/)