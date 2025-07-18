const FhirValidator = require('./fhir-validator');
const fs = require('fs');

// Get JAR path from environment variable or use default
const getJarPath = () => {
  const jarPath = process.env.FHIR_VALIDATOR_JAR_PATH || './validator_cli.jar';
  
  // Check if JAR file exists for integration tests
  if (process.env.INTEGRATION_TESTS && !fs.existsSync(jarPath)) {
    console.warn(`Warning: JAR file not found at ${jarPath}. Set FHIR_VALIDATOR_JAR_PATH environment variable.`);
  }
  
  return jarPath;
};

describe('FhirValidator', () => {
  let validator;
  const jarPath = getJarPath();
  
  beforeAll(() => {
    validator = new FhirValidator(jarPath);
  });

  afterAll(async () => {
    if (validator.isRunning()) {
      await validator.stop();
    }
  });

  describe('Constructor', () => {
    test('should create validator instance with jar path', () => {
      const testValidator = new FhirValidator('./test.jar');
      expect(testValidator.validatorJarPath).toBe('./test.jar');
      expect(testValidator.isRunning()).toBe(false);
    });
  });

  describe('Configuration validation', () => {
    test('should reject start with missing required config', async () => {
      await expect(validator.start({})).rejects.toThrow('version, txServer, and txLog are required');
    });

    test('should reject start with partial config', async () => {
      await expect(validator.start({
        version: '5.0.0'
      })).rejects.toThrow('version, txServer, and txLog are required');
    });
  });

  describe('Validation methods', () => {
    test('should reject validation when service not ready', async () => {
      await expect(validator.validate('{}')).rejects.toThrow('Validator service is not ready');
    });

    test('should validate resource types for validateBytes', async () => {
      await expect(validator.validateBytes('not-a-buffer')).rejects.toThrow('resourceBytes must be a Buffer');
    });

    test('should validate resource types for validateObject', async () => {
      await expect(validator.validateObject(null)).rejects.toThrow('resourceObject must be an object');
      await expect(validator.validateObject('string')).rejects.toThrow('resourceObject must be an object');
    });
  });

  describe('Edge cases', () => {
    test('should handle double start gracefully', async () => {
      // Mock a running process
      validator.process = { mock: true };
      
      await expect(validator.start({
        version: '5.0.0',
        txServer: 'http://tx.fhir.org/r5',
        txLog: './txlog.txt'
      })).rejects.toThrow('Validator service is already running');

      // Clean up mock
      validator.process = null;
    });

    test('should handle stop when not running', async () => {
      // Should not throw
      await expect(validator.stop()).resolves.not.toThrow();
    });
  });
});

// Integration tests - these require actual validator.jar and network access
describe('FhirValidator Integration Tests', () => {
  let validator;
  const jarPath = getJarPath();
  
  // Skip these tests unless INTEGRATION_TESTS env var is set
  const skipIntegration = !process.env.INTEGRATION_TESTS;

  beforeAll(async () => {
    if (skipIntegration) {
      console.log('Skipping integration tests. Set INTEGRATION_TESTS=1 to run them.');
      return;
    }
    
    if (!fs.existsSync(jarPath)) {
      throw new Error(`JAR file not found at ${jarPath}. Set FHIR_VALIDATOR_JAR_PATH environment variable.`);
    }
    
    console.log('Starting FHIR validator service... this may take a while');
    validator = new FhirValidator(jarPath);
    
    // Start the validator service with longer timeout
    await validator.start({
      version: '5.0.0',
      txServer: 'http://tx.fhir.org/r5',
      txLog: './test-txlog.txt',
      port: 8081,
      timeout: 120000  // 2 minutes for initial startup
    });
  }, 150000);  // 2.5 minute timeout for Jest beforeAll hook

  afterAll(async () => {
    if (validator && validator.isRunning()) {
      await validator.stop();
    }
  });

  test('should start validator service', async () => {
    if (skipIntegration) return;
    expect(validator.isRunning()).toBe(true);
  });

  test('should validate valid patient resource', async () => {
    if (skipIntegration) return;

    const validPatient = {
      resourceType: 'Patient',
      id: 'test-patient',
      active: true,
      name: [{
        use: 'official',
        family: 'Doe',
        given: ['John']
      }],
      gender: 'male',
      birthDate: '1974-12-25'
    };

    const result = await validator.validate(validPatient);
    expect(result).toHaveProperty('resourceType', 'OperationOutcome');
    expect(result).toHaveProperty('issue');
    expect(Array.isArray(result.issue)).toBe(true);
  });

  test('should handle validation errors gracefully', async () => {
    if (skipIntegration) return;

    const invalidResource = {
      resourceType: 'Patient',
      // Missing required fields, invalid field
      invalidField: 'should not be here'
    };

    const result = await validator.validate(invalidResource);
    expect(result).toHaveProperty('resourceType', 'OperationOutcome');
    expect(result.issue.some(issue => 
      issue.severity === 'error' || issue.severity === 'warning'
    )).toBe(true);
  });

  test('should validate with profiles', async () => {
    if (skipIntegration) return;

    const patient = {
      resourceType: 'Patient',
      id: 'us-core-patient',
      active: true,
      name: [{
        use: 'official',
        family: 'Doe',
        given: ['Jane']
      }],
      gender: 'female',
      birthDate: '1980-05-15'
    };

    const result = await validator.validate(patient, {
      profiles: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient'],
      resourceIdRule: 'OPTIONAL'
    });

    expect(result).toHaveProperty('resourceType', 'OperationOutcome');
  });
});
