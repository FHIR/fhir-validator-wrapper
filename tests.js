const FhirValidator = require('./fhir-validator');

// Mock test - in a real scenario, you'd need the actual validator.jar file
describe('FhirValidator', () => {
  let validator;
  
  beforeAll(() => {
    validator = new FhirValidator('./validator_cli.jar');
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

  // Integration tests - these would require actual validator.jar and network access
  describe('Integration tests', () => {
    // Skip these in CI unless validator.jar is available
    const skipIntegration = !process.env.INTEGRATION_TESTS;

    test.skip('should start validator service', async () => {
      if (skipIntegration) return;
      
      await validator.start({
        version: '5.0.0',
        txServer: 'http://tx.fhir.org/r5',
        txLog: './test-txlog.txt',
        port: 8081,
        timeout: 60000
      });

      expect(validator.isRunning()).toBe(true);
    });

    test.skip('should validate valid patient resource', async () => {
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

    test.skip('should handle validation errors gracefully', async () => {
      if (skipIntegration) return;

      const invalidResource = {
        resourceType: 'Patient',
        // Missing required fields
        invalidField: 'should not be here'
      };

      const result = await validator.validate(invalidResource);
      expect(result).toHaveProperty('resourceType', 'OperationOutcome');
      expect(result.issue.some(issue => 
        issue.severity === 'error' || issue.severity === 'warning'
      )).toBe(true);
    });

    test.skip('should validate with profiles', async () => {
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

    test.skip('should load additional IGs', async () => {
      if (skipIntegration) return;

      const result = await validator.loadIG('hl7.fhir.uv.ips', '1.1.0');
      expect(result).toHaveProperty('resourceType', 'OperationOutcome');
    });

    test.skip('should stop validator service', async () => {
      if (skipIntegration) return;

      await validator.stop();
      expect(validator.isRunning()).toBe(false);
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

// Helper function for manual testing
async function manualTest() {
  if (process.env.MANUAL_TEST) {
    console.log('Running manual test...');
    
    const validator = new FhirValidator('./validator_cli.jar');
    
    try {
      await validator.start({
        version: '5.0.0',
        txServer: 'http://tx.fhir.org/r5',
        txLog: './manual-test-txlog.txt',
        port: 8082
      });

      const testPatient = {
        resourceType: 'Patient',
        id: 'manual-test',
        active: true,
        name: [{ family: 'Test', given: ['Manual'] }]
      };

      const result = await validator.validate(testPatient);
      console.log('Manual test result:', JSON.stringify(result, null, 2));
      
    } catch (error) {
      console.error('Manual test failed:', error.message);
    } finally {
      await validator.stop();
      console.log('Manual test completed');
    }
  }
}

// Run manual test if requested
manualTest().catch(console.error);