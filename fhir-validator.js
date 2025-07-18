const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Node.js wrapper for the FHIR Validator HTTP Service
 */
class FhirValidator {
  constructor(validatorJarPath) {
    this.validatorJarPath = validatorJarPath;
    this.process = null;
    this.port = null;
    this.baseUrl = null;
    this.isReady = false;
  }

  /**
   * Start the FHIR validator service
   * @param {Object} config - Configuration object
   * @param {string} config.version - FHIR version (e.g., "5.0.0")
   * @param {string} config.txServer - Terminology server URL (e.g., "http://tx.fhir.org/r5")
   * @param {string} config.txLog - Path to transaction log file
   * @param {string[]} [config.igs] - Array of implementation guide packages (e.g., ["hl7.fhir.us.core#6.0.0"])
   * @param {number} [config.port=8080] - Port to run the service on
   * @param {number} [config.timeout=30000] - Timeout in ms to wait for service to be ready
   * @returns {Promise<void>}
   */
  async start(config) {
    if (this.process) {
      throw new Error('Validator service is already running');
    }

    const { version, txServer, txLog, igs = [], port = 8080, timeout = 30000 } = config;

    if (!version || !txServer || !txLog) {
      throw new Error('version, txServer, and txLog are required');
    }

    this.port = port;
    this.baseUrl = `http://localhost:${port}`;

    // Build command line arguments
    const args = [
      '-jar', this.validatorJarPath,
      '-server', port.toString(),
      '-tx', txServer,
      '-txlog', txLog,
      '-version', version
    ];

    // Add implementation guides
    for (const ig of igs) {
      args.push('-ig', ig);
    }

    console.log(`Starting FHIR validator with command: java ${args.join(' ')}`);

    // Spawn the Java process
    this.process = spawn('java', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Handle process events
    this.process.on('error', (error) => {
      console.error('Failed to start validator process:', error);
      throw error;
    });

    this.process.on('exit', (code, signal) => {
      console.log(`Validator process exited with code ${code} and signal ${signal}`);
      this.cleanup();
    });

    // Capture stdout and stderr for debugging
    this.process.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        // Remove ANSI escape sequences (color codes, etc.)
        const cleanLine = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
        if (cleanLine.length > 1) { // Only log non-empty lines
          console.log(`Validator: ${cleanLine}`);
        }
      });
    });

    this.process.stderr.on('data', (data) => {
      console.error(`Validator-err: ${data}`);
    });

    // Wait for the service to be ready
    await this.waitForReady(timeout);
    console.log('FHIR validator service is ready');
  }

  /**
   * Wait for the HTTP service to be ready
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<void>}
   */
  async waitForReady(timeout) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        await this.healthCheck();
        this.isReady = true;
        return;
      } catch (error) {
        // Service not ready yet, wait and retry
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    throw new Error(`Validator service did not become ready within ${timeout}ms`);
  }

  /**
   * Perform a health check on the service
   * @returns {Promise<void>}
   */
  healthCheck() {
    return new Promise((resolve, reject) => {
      const req = http.get(`${this.baseUrl}/validateResource`, (res) => {
        // We expect a 405 Method Not Allowed since we're doing GET instead of POST
        if (res.statusCode === 405) {
          resolve();
        } else {
          reject(new Error(`Unexpected status code: ${res.statusCode}`));
        }
      });

      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Health check timeout'));
      });
    });
  }

  /**
   * Validate a FHIR resource
   * @param {string|Buffer|Object} resource - The resource to validate (JSON string, Buffer, or Object)
   * @param {Object} [options] - Validation options
   * @param {string[]} [options.profiles] - Profiles to validate against
   * @param {string} [options.resourceIdRule] - Resource ID rule ("OPTIONAL", "REQUIRED", "PROHIBITED")
   * @param {boolean} [options.anyExtensionsAllowed=true] - Whether any extensions are allowed
   * @param {string} [options.bpWarnings] - Best practice warning level
   * @param {string} [options.displayOption] - Display option for validation
   * @returns {Promise<Object>} - The OperationOutcome as a JavaScript object
   */
  async validate(resource, options = {}) {
    if (!this.isReady) {
      throw new Error('Validator service is not ready');
    }

    // Convert resource to bytes
    let resourceBytes;
    let contentType = 'application/fhir+json';

    if (typeof resource === 'string') {
      // Determine if it's JSON or XML
      const trimmed = resource.trim();
      if (trimmed.startsWith('<')) {
        contentType = 'application/fhir+xml';
      }
      resourceBytes = Buffer.from(resource, 'utf8');
    } else if (Buffer.isBuffer(resource)) {
      resourceBytes = resource;
      // Try to detect format from content
      const content = resource.toString('utf8').trim();
      if (content.startsWith('<')) {
        contentType = 'application/fhir+xml';
      }
    } else if (typeof resource === 'object') {
      resourceBytes = Buffer.from(JSON.stringify(resource), 'utf8');
      contentType = 'application/fhir+json';
    } else {
      throw new Error('Resource must be a string, Buffer, or object');
    }

    // Build query parameters
    const queryParams = new URLSearchParams();
    
    if (options.profiles && options.profiles.length > 0) {
      queryParams.set('profiles', options.profiles.join(','));
    }
    if (options.resourceIdRule) {
      queryParams.set('resourceIdRule', options.resourceIdRule);
    }
    if (options.anyExtensionsAllowed !== undefined) {
      queryParams.set('anyExtensionsAllowed', options.anyExtensionsAllowed.toString());
    }
    if (options.bpWarnings) {
      queryParams.set('bpWarnings', options.bpWarnings);
    }
    if (options.displayOption) {
      queryParams.set('displayOption', options.displayOption);
    }

    const url = `${this.baseUrl}/validateResource?${queryParams.toString()}`;

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const requestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': resourceBytes.length,
          'Accept': 'application/fhir+json'
        }
      };

      const req = http.request(requestOptions, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            resolve(result);
          } catch (error) {
            reject(new Error(`Failed to parse response: ${error.message}\nResponse: ${data}`));
          }
        });
      });

      req.on('error', reject);
      
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Validation request timeout'));
      });

      req.write(resourceBytes);
      req.end();
    });
  }

  /**
   * Validate a FHIR resource with byte array input
   * @param {Buffer} resourceBytes - The resource as bytes
   * @param {string} [format='json'] - The format ('json' or 'xml')
   * @param {Object} [options] - Validation options (same as validate method)
   * @returns {Promise<Object>} - The OperationOutcome as a JavaScript object
   */
  async validateBytes(resourceBytes, format = 'json', options = {}) {
    if (!Buffer.isBuffer(resourceBytes)) {
      throw new Error('resourceBytes must be a Buffer');
    }
    
    return this.validate(resourceBytes, options);
  }

  /**
   * Validate a FHIR resource object
   * @param {Object} resourceObject - The resource as a JavaScript object
   * @param {Object} [options] - Validation options (same as validate method)
   * @returns {Promise<Object>} - The OperationOutcome as a JavaScript object
   */
  async validateObject(resourceObject, options = {}) {
    if (typeof resourceObject !== 'object' || resourceObject === null) {
      throw new Error('resourceObject must be an object');
    }
    
    return this.validate(resourceObject, options);
  }

  /**
   * Stop the validator service
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.process) {
      return;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.warn('Force killing validator process after timeout');
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
        this.cleanup();
        resolve();
      }, 10000); // 10 second total timeout

      // Single exit handler
      const onExit = () => {
        clearTimeout(timeout);
        this.cleanup();
        resolve();
      };

      this.process.once('exit', onExit); // Use 'once' to avoid duplicate listeners

      // Since Java process is blocking on System.in.read(), SIGTERM likely won't work
      // Go straight to SIGKILL for immediate termination
      console.log('Stopping validator process...');
      this.process.kill('SIGKILL');
      
      // Backup: try SIGTERM first, then SIGKILL after 2 seconds
      // this.process.kill('SIGTERM');
      // setTimeout(() => {
      //   if (this.process && !this.process.killed) {
      //     console.log('Escalating to SIGKILL...');
      //     this.process.kill('SIGKILL');
      //   }
      // }, 2000);
    });
  }

  /**
   * Clean up internal state
   * @private
   */
  cleanup() {
    this.process = null;
    this.port = null;
    this.baseUrl = null;
    this.isReady = false;
  }

  /**
   * Check if the validator service is running
   * @returns {boolean}
   */
  isRunning() {
    return this.process !== null && this.isReady;
  }
}

module.exports = FhirValidator;