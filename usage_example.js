const FHIRValidatorService = require('./validator-service');
const fs = require('fs').promises;

async function example() {
  const validator = new FHIRValidatorService();

  try {
    // Step 1: Configure Java environment and load validator JAR
    console.log('Configuring Java environment...');
    await validator.configureJava('./lib/validator_cli.jar', {
      javaOptions: '-Xmx4g',
      classpath: [] // Add any additional JARs here if needed
    });

    // Step 2: Initialize with FHIR definitions
    console.log('Initializing FHIR validator...');
    await validator.initialize('./definitions/definitions.xml.zip');

    // Step 3: Connect to terminology server
    console.log('Connecting to terminology server...');
    await validator.connectToTerminologyServer(
      'http://tx.fhir.org/r4', 
      './logs/terminology.log',
      './cache/terminology-cache'
    );

    // Step 4: Load Implementation Guides
    console.log('Loading IGs...');
    await validator.loadIG('./igs/us-core-ig.tgz');
    await validator.loadIG('./igs/some-other-ig.tgz');

    // Step 5: Validate a FHIR resource
    console.log('Validating resource...');
    
    // Example FHIR Patient resource
    const patientResource = {
      "resourceType": "Patient",
      "id": "example-patient",
      "active": true,
      "name": [{
        "use": "official",
        "family": "Doe",
        "given": ["John"]
      }],
      "gender": "male",
      "birthDate": "1990-01-01"
    };

    const resourceBytes = Buffer.from(JSON.stringify(patientResource), 'utf8');
    
    const operationOutcomeBytes = await validator.validateResource(
      resourceBytes,
      'JSON',
      'Example Patient Resource',
      {
        idRule: 'id-optional',
        extensionRule: 'any-extensions',
        bestPractice: 'bp-warning',
        displayCheck: 'display-ignore'
      }
    );

    // Parse the OperationOutcome result
    const operationOutcome = JSON.parse(operationOutcomeBytes.toString('utf8'));
    console.log('Validation result:', JSON.stringify(operationOutcome, null, 2));

    // Step 6: Get validator status
    const status = await validator.getStatus();
    console.log('Validator status:', status);

    // Step 7: Add a custom profile or resource to the validator context
    console.log('Adding custom profile...');
    const customProfile = await fs.readFile('./profiles/custom-patient-profile.json');
    await validator.seeResource(customProfile, 'JSON');

    // Validate again with the new profile
    const secondValidation = await validator.validateResource(
      resourceBytes,
      'JSON',
      'Patient with Custom Profile',
      { bestPractice: 'bp-error' }
    );
    
    console.log('Second validation complete');

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    // Step 8: Shutdown
    console.log('Shutting down validator...');
    await validator.shutdown();
  }
}

// Function to validate a bundle (common use case)
async function validateBundle(validator, bundleJson) {
  try {
    const bundleBytes = Buffer.from(JSON.stringify(bundleJson), 'utf8');
    
    const result = await validator.validateResource(
      bundleBytes,
      'JSON',
      'FHIR Bundle',
      {
        idRule: 'id-optional',
        extensionRule: 'any-extensions',
        bestPractice: 'bp-warning'
      }
    );

    const operationOutcome = JSON.parse(result.toString('utf8'));
    
    // Extract validation results
    const issues = operationOutcome.issue || [];
    const errors = issues.filter(issue => issue.severity === 'error');
    const warnings = issues.filter(issue => issue.severity === 'warning');
    
    return {
      isValid: errors.length === 0,
      errorCount: errors.length,
      warningCount: warnings.length,
      issues: issues,
      operationOutcome: operationOutcome
    };
  } catch (error) {
    return {
      isValid: false,
      error: error.message,
      operationOutcome: null
    };
  }
}

// Express.js integration example
function setupExpressEndpoints(app, validator) {
  // Validation endpoint
  app.post('/validate', async (req, res) => {
    try {
      const { resource, format = 'JSON', options = {} } = req.body;
      
      if (!resource) {
        return res.status(400).json({ error: 'Resource is required' });
      }

      const resourceBytes = Buffer.from(
        typeof resource === 'string' ? resource : JSON.stringify(resource),
        'utf8'
      );

      const result = await validator.validateResource(
        resourceBytes,
        format,
        'HTTP API Validation',
        options
      );

      const operationOutcome = JSON.parse(result.toString('utf8'));
      
      res.json({
        operationOutcome: operationOutcome,
        isValid: !operationOutcome.issue?.some(issue => issue.severity === 'error')
      });

    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Status endpoint
  app.get('/status', async (req, res) => {
    try {
      const status = await validator.getStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: validator.isReady() ? 'ready' : 'not ready',
      timestamp: new Date().toISOString()
    });
  });
}

// Run the example
if (require.main === module) {
  example().catch(console.error);
}

module.exports = {
  example,
  validateBundle,
  setupExpressEndpoints
};