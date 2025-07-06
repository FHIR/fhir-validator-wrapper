const java = require('java');
const path = require('path');
const { promisify } = require('util');

/**
 * Node.js wrapper for FHIR Java Validator using NativeHostServices
 */
class FHIRValidatorService {
  constructor() {
    this.nativeHostServices = null;
    this.initialized = false;
    this.javaConfigured = false;
  }

  /**
   * Configure Java environment and load the FHIR validator JAR
   * @param {string} validatorJarPath - Path to the FHIR validator JAR file
   * @param {Object} options - Configuration options
   * @param {string[]} options.classpath - Additional classpath entries
   * @param {string} options.javaOptions - JVM options (e.g., '-Xmx4g')
   */
  async configureJava(validatorJarPath, options = {}) {
    if (this.javaConfigured) {
      throw new Error('Java environment already configured');
    }

    try {
      // Configure JVM options
      if (options.javaOptions) {
        java.options.push(options.javaOptions);
      } else {
        // Default JVM options for FHIR validation
        java.options.push('-Xmx4g');
        java.options.push('-Xms1g');
      }

      // Add the validator JAR to classpath
      java.classpath.push(validatorJarPath);

      // Add additional classpath entries if provided
      if (options.classpath && Array.isArray(options.classpath)) {
        options.classpath.forEach(cp => java.classpath.push(cp));
      }

      this.javaConfigured = true;
      console.log('Java environment configured successfully');
    } catch (error) {
      throw new Error(`Failed to configure Java environment: ${error.message}`);
    }
  }

  /**
   * Initialize the FHIR validator
   * @param {string} definitionsPackPath - Path to definitions pack (e.g., definitions.xml.zip)
   */
  async initialize(definitionsPackPath) {
    if (!this.javaConfigured) {
      throw new Error('Java environment must be configured before initialization');
    }

    try {
      // Create instance of NativeHostServices
      const NativeHostServicesClass = java.import('org.hl7.fhir.validation.NativeHostServices');
      this.nativeHostServices = new NativeHostServicesClass();

      // Initialize with definitions pack
      const initPromise = promisify(this.nativeHostServices.init.bind(this.nativeHostServices));
      await initPromise(definitionsPackPath);

      this.initialized = true;
      console.log('FHIR validator initialized successfully');
    } catch (error) {
      throw new Error(`Failed to initialize FHIR validator: ${error.message}`);
    }
  }

  /**
   * Load an Implementation Guide
   * @param {string} igPackPath - Path to IG pack file (validator.pack or igpack.zip)
   */
  async loadIG(igPackPath) {
    if (!this.initialized) {
      throw new Error('Validator must be initialized before loading IGs');
    }

    try {
      const loadPromise = promisify(this.nativeHostServices.load.bind(this.nativeHostServices));
      await loadPromise(igPackPath);
      console.log(`IG loaded successfully: ${igPackPath}`);
    } catch (error) {
      throw new Error(`Failed to load IG: ${error.message}`);
    }
  }

  /**
   * Connect to terminology server
   * @param {string} txServerUrl - Terminology server URL (e.g., 'http://tx.fhir.org/r4')
   * @param {string} logPath - Path for logging (optional, can be null)
   * @param {string} txCache - Terminology cache path (optional)
   */
  async connectToTerminologyServer(txServerUrl, logPath = null, txCache = null) {
    if (!this.initialized) {
      throw new Error('Validator must be initialized before connecting to terminology server');
    }

    try {
      let connectPromise;
      if (txCache) {
        connectPromise = promisify(this.nativeHostServices.connectToTxSvc.bind(this.nativeHostServices));
        await connectPromise(txServerUrl, logPath, txCache);
      } else {
        connectPromise = promisify(this.nativeHostServices.connectToTxSvc.bind(this.nativeHostServices));
        await connectPromise(txServerUrl, logPath);
      }
      console.log(`Connected to terminology server: ${txServerUrl}`);
    } catch (error) {
      throw new Error(`Failed to connect to terminology server: ${error.message}`);
    }
  }

  /**
   * Validate a FHIR resource
   * @param {Buffer} resourceBytes - The FHIR resource as bytes
   * @param {string} format - Format type ('JSON', 'XML', or 'TURTLE')
   * @param {string} location - Description of validation context
   * @param {Object} options - Validation options
   * @param {string} options.idRule - 'id-optional', 'id-required', or 'id-prohibited'
   * @param {string} options.extensionRule - 'any-extensions' or 'strict-extensions'
   * @param {string} options.bestPractice - 'bp-ignore', 'bp-hint', 'bp-warning', or 'bp-error'
   * @param {string} options.displayCheck - 'display-ignore', 'display-check', 'display-case-space', etc.
   * @returns {Promise<Buffer>} OperationOutcome as bytes
   */
  async validateResource(resourceBytes, format, location = 'Unknown', options = {}) {
    if (!this.initialized) {
      throw new Error('Validator must be initialized before validation');
    }

    try {
      // Build options string
      const optionParts = [];
      if (options.idRule) optionParts.push(options.idRule);
      if (options.extensionRule) optionParts.push(options.extensionRule);
      if (options.bestPractice) optionParts.push(options.bestPractice);
      if (options.displayCheck) optionParts.push(options.displayCheck);
      
      const optionsString = optionParts.join(' ');

      // Convert Node.js Buffer to Java byte array
      const javaByteArray = java.newArray('byte', Array.from(resourceBytes));

      // Perform validation
      const validatePromise = promisify(this.nativeHostServices.validateResource.bind(this.nativeHostServices));
      const resultBytes = await validatePromise(location, javaByteArray, format.toUpperCase(), optionsString);

      // Convert Java byte array back to Node.js Buffer
      return Buffer.from(resultBytes);
    } catch (error) {
      throw new Error(`Validation failed: ${error.message}`);
    }
  }

  /**
   * Add a resource to the validator context (profiles, valuesets, etc.)
   * @param {Buffer} resourceBytes - The resource as bytes
   * @param {string} format - Format type ('JSON' or 'XML')
   */
  async seeResource(resourceBytes, format) {
    if (!this.initialized) {
      throw new Error('Validator must be initialized before adding resources');
    }

    try {
      // Import FhirFormat enum
      const FhirFormat = java.import('org.hl7.fhir.r5.elementmodel.Manager$FhirFormat');
      const formatEnum = format.toUpperCase() === 'JSON' ? FhirFormat.JSON : FhirFormat.XML;

      const javaByteArray = java.newArray('byte', Array.from(resourceBytes));
      
      const seeResourcePromise = promisify(this.nativeHostServices.seeResource.bind(this.nativeHostServices));
      await seeResourcePromise(javaByteArray, formatEnum);
    } catch (error) {
      throw new Error(`Failed to add resource: ${error.message}`);
    }
  }

  /**
   * Remove a resource from the validator context
   * @param {string} resourceType - The resource type
   * @param {string} resourceId - The resource ID
   */
  async dropResource(resourceType, resourceId) {
    if (!this.initialized) {
      throw new Error('Validator must be initialized before removing resources');
    }

    try {
      const dropResourcePromise = promisify(this.nativeHostServices.dropResource.bind(this.nativeHostServices));
      await dropResourcePromise(resourceType, resourceId);
    } catch (error) {
      throw new Error(`Failed to remove resource: ${error.message}`);
    }
  }

  /**
   * Get validator status information
   * @returns {Promise<Object>} Status object with validation counts, memory usage, etc.
   */
  async getStatus() {
    if (!this.initialized) {
      throw new Error('Validator must be initialized to get status');
    }

    try {
      const statusPromise = promisify(this.nativeHostServices.status.bind(this.nativeHostServices));
      const statusJson = await statusPromise();
      return JSON.parse(statusJson);
    } catch (error) {
      throw new Error(`Failed to get status: ${error.message}`);
    }
  }

  /**
   * Convert resource from one FHIR version to R5
   * @param {Buffer} resourceBytes - The resource as bytes
   * @param {string} format - Format type ('JSON', 'XML', or 'TURTLE')
   * @param {string} sourceVersion - Source FHIR version ('r2', 'r3', 'r4')
   * @returns {Promise<Buffer>} Converted resource as bytes
   */
  async convertResource(resourceBytes, format, sourceVersion) {
    if (!this.initialized) {
      throw new Error('Validator must be initialized before conversion');
    }

    try {
      const javaByteArray = java.newArray('byte', Array.from(resourceBytes));
      
      const convertPromise = promisify(this.nativeHostServices.convertResource.bind(this.nativeHostServices));
      const resultBytes = await convertPromise(javaByteArray, format.toUpperCase(), sourceVersion);

      return Buffer.from(resultBytes);
    } catch (error) {
      throw new Error(`Conversion failed: ${error.message}`);
    }
  }

  /**
   * Convert resource from R5 to specified FHIR version
   * @param {Buffer} resourceBytes - The R5 resource as bytes
   * @param {string} format - Format type ('JSON', 'XML', or 'TURTLE')
   * @param {string} targetVersion - Target FHIR version ('r2', 'r3', 'r4')
   * @returns {Promise<Buffer>} Converted resource as bytes
   */
  async unConvertResource(resourceBytes, format, targetVersion) {
    if (!this.initialized) {
      throw new Error('Validator must be initialized before conversion');
    }

    try {
      const javaByteArray = java.newArray('byte', Array.from(resourceBytes));
      
      const unConvertPromise = promisify(this.nativeHostServices.unConvertResource.bind(this.nativeHostServices));
      const resultBytes = await unConvertPromise(javaByteArray, format.toUpperCase(), targetVersion);

      return Buffer.from(resultBytes);
    } catch (error) {
      throw new Error(`Unconversion failed: ${error.message}`);
    }
  }

  /**
   * Shutdown the validator and cleanup resources
   */
  async shutdown() {
    if (this.nativeHostServices) {
      // The Java validator doesn't have an explicit shutdown method,
      // but we can clear our references
      this.nativeHostServices = null;
    }
    this.initialized = false;
    console.log('FHIR validator service shutdown');
  }

  /**
   * Check if the service is ready for validation
   * @returns {boolean} True if initialized and ready
   */
  isReady() {
    return this.initialized && this.nativeHostServices !== null;
  }
}

module.exports = FHIRValidatorService;