const FhirValidator = require('./fhir-validator');
const fs = require('fs');
const path = require('path');

// Get JAR path from environment variable or use default
const getJarPath = () => {
  const jarPath = process.env.FHIR_VALIDATOR_JAR_PATH || './validator_cli.jar';
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
      expect(testValidator.versionFilePath).toBe('./test.jar.version');
      expect(testValidator.isRunning()).toBe(false);
    });
  });

  describe('Configuration validation', () => {
    test('should reject start with missing required config', async () => {
      const testValidator = new FhirValidator('./test.jar');
      await expect(testValidator.start({ autoDownload: false })).rejects.toThrow('version, txServer, and txLog are required');
    });

    test('should reject start with partial config', async () => {
      const testValidator = new FhirValidator('./test.jar');
      await expect(testValidator.start({
        version: '5.0.0',
        autoDownload: false
      })).rejects.toThrow('version, txServer, and txLog are required');
    });

    test('should reject start when JAR missing and autoDownload disabled', async () => {
      const testValidator = new FhirValidator('./nonexistent.jar');
      await expect(testValidator.start({
        version: '5.0.0',
        txServer: 'http://tx.fhir.org/r5',
        txLog: './txlog.txt',
        autoDownload: false
      })).rejects.toThrow('Validator JAR not found');
    });
  });

  describe('Validation methods', () => {
    test('should reject validation when service not ready', async () => {
      await expect(validator.validate('{}')).rejects.toThrow('Validator service is not ready');
    });

    test('should reject runTxTest when service not ready', async () => {
      await expect(validator.runTxTest({
        server: 'http://tx.fhir.org',
        suiteName: 'test',
        testName: 'test',
        version: '5.0'
      })).rejects.toThrow('Validator service is not ready');
    });

    test('should reject runTxTest with missing required params', async () => {
      // Mock ready state
      validator.isReady = true;
      validator.baseUrl = 'http://localhost:8080';

      await expect(validator.runTxTest({})).rejects.toThrow('server, suiteName, testName, and version are required');
      await expect(validator.runTxTest({ server: 'http://tx.fhir.org' })).rejects.toThrow('server, suiteName, testName, and version are required');

      // Clean up mock
      validator.isReady = false;
      validator.baseUrl = null;
    });

    test('should know validator version once started', async () => {
      await validator.start({
        version: '5.0.0',
        txServer: 'http://tx.fhir.org/r5',
        txLog: './txlog.txt',
        autoDownload: false
      });
      expect(validator.jarVersion()).toBeDefined();
    }, 30000);

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
        txLog: './txlog.txt',
        autoDownload: false
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

describe('FhirValidator Version Management', () => {
  const testDir = './test-validator-downloads';
  const testJarPath = path.join(testDir, 'validator_cli.jar');
  let validator;

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
    validator = new FhirValidator(testJarPath);
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('Version file management', () => {
    test('should return null when no version file exists', () => {
      expect(validator.getInstalledVersion()).toBeNull();
    });

    test('should save and read version info', () => {
      validator.saveVersionInfo('6.0.0', 'https://example.com/validator.jar');

      expect(validator.getInstalledVersion()).toBe('6.0.0');

      const versionFile = JSON.parse(fs.readFileSync(testJarPath + '.version', 'utf8'));
      expect(versionFile.version).toBe('6.0.0');
      expect(versionFile.downloadUrl).toBe('https://example.com/validator.jar');
      expect(versionFile.downloadedAt).toBeDefined();
    });

    test('should handle corrupt version file gracefully', () => {
      fs.writeFileSync(testJarPath + '.version', 'not valid json');
      expect(validator.getInstalledVersion()).toBeNull();
    });
  });
});

// GitHub API tests - these require network access
describe('FhirValidator GitHub API', () => {
  let validator;

  // Skip these tests unless GITHUB_API_TESTS env var is set
  const skipGithubTests = !process.env.GITHUB_API_TESTS;

  beforeAll(() => {
    if (skipGithubTests) {
      console.log('Skipping GitHub API tests. Set GITHUB_API_TESTS=1 to run them.');
      return;
    }
    validator = new FhirValidator('./test-validator.jar');
  });

  test('should fetch latest release info from GitHub', async () => {
    if (skipGithubTests) return;

    const release = await validator.getLatestRelease();

    expect(release).toHaveProperty('version');
    expect(release).toHaveProperty('downloadUrl');
    expect(release).toHaveProperty('publishedAt');
    expect(release.version).toMatch(/^\d+\.\d+\.\d+/); // Version format like 6.3.4
    expect(release.downloadUrl).toContain('validator_cli.jar');
  }, 30000);
});

// Download tests - these download the actual JAR file
describe('FhirValidator Download', () => {
  const testDir = './test-validator-downloads';
  const testJarPath = path.join(testDir, 'validator_cli.jar');
  let validator;

  // Skip these tests unless DOWNLOAD_TESTS env var is set
  const skipDownloadTests = false; // !process.env.DOWNLOAD_TESTS;

  beforeAll(() => {
    if (skipDownloadTests) {
      console.log('Skipping download tests. Set DOWNLOAD_TESTS=1 to run them.');
      return;
    }
  });

  beforeEach(() => {
    if (skipDownloadTests) return;

    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
    validator = new FhirValidator(testJarPath);
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  test('should download validator JAR when missing', async () => {
    if (skipDownloadTests) return;

    const result = await validator.ensureValidator();

    expect(result.downloaded).toBe(true);
    expect(result.version).toBeDefined();
    expect(fs.existsSync(testJarPath)).toBe(true);
    expect(fs.existsSync(testJarPath + '.version')).toBe(true);

    // Verify JAR file is reasonable size (should be > 200MB)
    const stats = fs.statSync(testJarPath);
    expect(stats.size).toBeGreaterThan(150 * 1024 * 1024);
  }, 600000); // 10 minute timeout for download

  test('should skip download when JAR is up to date', async () => {
    if (skipDownloadTests) return;

    // First download
    const result1 = await validator.ensureValidator();
    expect(result1.downloaded).toBe(true);

    // Second call should skip
    const result2 = await validator.ensureValidator();
    expect(result2.downloaded).toBe(false);
    expect(result2.updated).toBe(false);
    expect(result2.version).toBe(result1.version);
  }, 600000);

  test('should skip update check when skipUpdateCheck is true', async () => {
    if (skipDownloadTests) return;

    // First download
    await validator.ensureValidator();

    // Create a new validator instance and skip update check
    const validator2 = new FhirValidator(testJarPath);
    const result = await validator2.ensureValidator({ skipUpdateCheck: true });

    expect(result.downloaded).toBe(false);
  }, 600000);

  test('should force download when force is true', async () => {
    if (skipDownloadTests) return;

    // First download
    await validator.ensureValidator();

    // Force re-download
    const result = await validator.ensureValidator({ force: true });
    expect(result.downloaded).toBe(true);
  }, 600000);
});

// Integration tests - these require actual validator.jar and network access
describe('FhirValidator Integration Tests', () => {
  let validator;
  const jarPath = getJarPath();

  // Skip these tests unless INTEGRATION_TESTS env var is set
  const skipIntegration = false; // !process.env.INTEGRATION_TESTS;

  beforeAll(async () => {
    if (skipIntegration) {
      console.log('Skipping integration tests. Set INTEGRATION_TESTS=1 to run them.');
      return;
    }

    console.log('Starting FHIR validator service... this may take a while');
    validator = new FhirValidator(jarPath);

    // Start the validator service with longer timeout
    // autoDownload will fetch the JAR if needed
    await validator.start({
      version: '5.0.0',
      txServer: 'http://tx.fhir.org/r5',
      txLog: './test-txlog.txt',
      port: 8081,
      timeout: 120000,  // 2 minutes for initial startup
      autoDownload: true,
      skipUpdateCheck: true  // Don't check for updates every test run
    });
  }, 300000);  // 5 minute timeout for Jest beforeAll hook (includes potential download)

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

  test('should load additional IGs', async () => {
    if (skipIntegration) return;

    const result = await validator.loadIG('hl7.fhir.uv.ips', '1.1.0');
    expect(result).toHaveProperty('resourceType', 'OperationOutcome');
  });

  test('should run tx test successfully', async () => {
    if (skipIntegration) return;

    const result = await validator.runTxTest({
      server: 'http://tx-dev.fhir.org',
      suiteName: 'metadata',
      testName: 'metadata',
      version: '5.0'
    });

    expect(result).toHaveProperty('result', true);
    expect(result.message).toBeUndefined();
  });

  test('should return failure for invalid tx test server', async () => {
    if (skipIntegration) return;

    const result = await validator.runTxTest({
      server: 'http://tx-dev.fhir.orgX',
      suiteName: 'metadata',
      testName: 'metadata',
      version: '5.0'
    });

    expect(result).toHaveProperty('result', false);
    expect(result.message).toBeDefined();
  });

  test('should return failure for invalid tx test suite', async () => {
    if (skipIntegration) return;

    const result = await validator.runTxTest({
      server: 'http://tx-dev.fhir.org',
      suiteName: 'metadataX',
      testName: 'metadata',
      version: '5.0'
    });

    expect(result).toHaveProperty('result', false);
    expect(result.message).toBeDefined();
  });

  test('should return failure for invalid tx test name', async () => {
    if (skipIntegration) return;

    const result = await validator.runTxTest({
      server: 'http://tx-dev.fhir.org',
      suiteName: 'metadata',
      testName: 'metadataX',
      version: '5.0'
    });

    expect(result).toHaveProperty('result', false);
    expect(result.message).toBeDefined();
  });
});