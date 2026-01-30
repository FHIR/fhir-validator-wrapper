const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/**
 * Node.js wrapper for the FHIR Validator HTTP Service
 */
class FhirValidator {
  /**
   * Create a new FHIR Validator instance
   * @param {string} validatorJarPath - Path to the validator JAR file
   * @param {Object} [logger] - Winston logger instance (optional)
   */
  constructor(validatorJarPath, logger = null) {
    this.validatorJarPath = validatorJarPath;
    this.logger = logger;
    this.process = null;
    this.port = null;
    this.baseUrl = null;
    this.isReady = false;

    // Version tracking file sits alongside the JAR
    this.versionFilePath = validatorJarPath + '.version';
    this.version = undefined;
  }

  /**
   * @returns what version the validator jar reports that it is
   */
  jarVersion() {
    return this.version;
  }

  /**
   * Set a logger after initialization
   * @param {Object} logger - Winston logger instance
   */
  setLogger(logger) {
    this.logger = logger;
  }

  /**
   * Log a message with the appropriate level
   * @private
   * @param {string} level - Log level ('info', 'error', 'warn')
   * @param {string} message - Message to log
   * @param {Object} [meta] - Optional metadata
   */
  log(level, message, meta = {}) {
    if (this.logger) {
      this.logger[level](message, meta);
    } else {
      if (level === 'error') {
        console.error(message, meta);
      } else if (level === 'warn') {
        console.warn(message, meta);
      } else {
        console.log(message, meta);
      }
    }
  }

  /**
   * Get the latest release information from GitHub
   * @returns {Promise<{version: string, downloadUrl: string}>}
   */
  async getLatestRelease() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.github.com',
        path: '/repos/hapifhir/org.hl7.fhir.core/releases/latest',
        method: 'GET',
        headers: {
          'User-Agent': 'fhir-validator-node',
          'Accept': 'application/vnd.github.v3+json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API returned status ${res.statusCode}: ${data}`));
            return;
          }

          try {
            const release = JSON.parse(data);
            const version = release.tag_name;

            // Find the validator_cli.jar asset
            const asset = release.assets.find(a => a.name === 'validator_cli.jar');
            if (!asset) {
              reject(new Error('validator_cli.jar not found in latest release assets'));
              return;
            }

            resolve({
              version,
              downloadUrl: asset.browser_download_url,
              publishedAt: release.published_at
            });
          } catch (error) {
            reject(new Error(`Failed to parse GitHub response: ${error.message}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('GitHub API request timeout'));
      });

      req.end();
    });
  }

  /**
   * Get the currently installed version
   * @returns {string|null} - The installed version or null if not installed
   */
  getInstalledVersion() {
    try {
      if (fs.existsSync(this.versionFilePath)) {
        const versionInfo = JSON.parse(fs.readFileSync(this.versionFilePath, 'utf8'));
        return versionInfo.version;
      }
    } catch (error) {
      this.log('warn', `Failed to read version file: ${error.message}`);
    }
    return null;
  }

  /**
   * Save version information
   * @param {string} version - The version string
   * @param {string} downloadUrl - The URL it was downloaded from
   */
  saveVersionInfo(version, downloadUrl) {
    const versionInfo = {
      version,
      downloadUrl,
      downloadedAt: new Date().toISOString()
    };
    fs.writeFileSync(this.versionFilePath, JSON.stringify(versionInfo, null, 2));
  }

  /**
   * Download a file from a URL, following redirects
   * @param {string} url - The URL to download from
   * @param {string} destPath - The destination file path
   * @returns {Promise<void>}
   */
  async downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
      const downloadWithRedirects = (downloadUrl, redirectCount = 0) => {
        if (redirectCount > 5) {
          reject(new Error('Too many redirects'));
          return;
        }

        const parsedUrl = new URL(downloadUrl);
        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        const req = protocol.get(downloadUrl, {
          headers: {
            'User-Agent': 'fhir-validator-node'
          }
        }, (res) => {
          // Handle redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            this.log('info', `Following redirect to ${res.headers.location}`);
            downloadWithRedirects(res.headers.location, redirectCount + 1);
            return;
          }

          if (res.statusCode !== 200) {
            reject(new Error(`Download failed with status ${res.statusCode}`));
            return;
          }

          // Ensure directory exists
          const dir = path.dirname(destPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }

          // Download to a temp file first, then rename
          const tempPath = destPath + '.download';
          const fileStream = fs.createWriteStream(tempPath);

          const contentLength = parseInt(res.headers['content-length'], 10);
          let downloadedBytes = 0;
          let lastLoggedPercent = 0;

          res.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            if (contentLength) {
              const percent = Math.floor((downloadedBytes / contentLength) * 100);
              if (percent >= lastLoggedPercent + 10) {
                this.log('info', `Download progress: ${percent}% (${Math.round(downloadedBytes / 1024 / 1024)}MB / ${Math.round(contentLength / 1024 / 1024)}MB)`);
                lastLoggedPercent = percent;
              }
            }
          });

          res.pipe(fileStream);

          fileStream.on('finish', () => {
            fileStream.close(() => {
              // Rename temp file to final destination
              fs.renameSync(tempPath, destPath);
              resolve();
            });
          });

          fileStream.on('error', (err) => {
            // Clean up temp file on error
            if (fs.existsSync(tempPath)) {
              fs.unlinkSync(tempPath);
            }
            reject(err);
          });
        });

        req.on('error', reject);
        req.setTimeout(300000, () => { // 5 minute timeout for large file
          req.destroy();
          reject(new Error('Download timeout'));
        });
      };

      downloadWithRedirects(url);
    });
  }

  /**
   * Ensure the validator JAR is downloaded and up to date
   * @param {Object} [options] - Options for the update check
   * @param {boolean} [options.force=false] - Force download even if current version is up to date
   * @param {boolean} [options.skipUpdateCheck=false] - Skip checking for updates if JAR exists
   * @returns {Promise<{version: string, updated: boolean, downloaded: boolean}>}
   */
  async ensureValidator(options = {}) {
    const { force = false, skipUpdateCheck = false } = options;

    const jarExists = fs.existsSync(this.validatorJarPath);
    const installedVersion = this.getInstalledVersion();

    // If JAR exists and we're skipping update checks, we're done
    if (jarExists && skipUpdateCheck && !force) {
      this.log('info', `Using existing validator JAR (version check skipped)`);
      return {
        version: installedVersion || 'unknown',
        updated: false,
        downloaded: false
      };
    }

    // Check for latest version
    this.log('info', 'Checking for latest FHIR validator release...');
    const latest = await this.getLatestRelease();
    this.log('info', `Latest version: ${latest.version}`);

    // Determine if we need to download
    const needsDownload = force ||
      !jarExists ||
      !installedVersion ||
      installedVersion !== latest.version;

    if (!needsDownload) {
      this.log('info', `Validator is up to date (${installedVersion})`);
      return {
        version: installedVersion,
        updated: false,
        downloaded: false
      };
    }

    // Download the JAR
    if (installedVersion && jarExists) {
      this.log('info', `Updating validator from ${installedVersion} to ${latest.version}...`);
    } else {
      this.log('info', `Downloading validator ${latest.version}...`);
    }

    await this.downloadFile(latest.downloadUrl, this.validatorJarPath);
    this.saveVersionInfo(latest.version, latest.downloadUrl);

    this.log('info', `Validator ${latest.version} downloaded successfully`);

    return {
      version: latest.version,
      updated: installedVersion !== null && installedVersion !== latest.version,
      downloaded: true
    };
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
   * @param {boolean} [config.autoDownload=true] - Automatically download/update validator JAR
   * @param {boolean} [config.skipUpdateCheck=false] - Skip checking for updates if JAR exists
   * @returns {Promise<void>}
   */
  async start(config) {
    if (this.process) {
      throw new Error('Validator service is already running');
    }

    const {
      version,
      txServer,
      txLog,
      igs = [],
      port = 8080,
      timeout = 30000,
      autoDownload = true,
      skipUpdateCheck = false
    } = config;

    if (!version || !txServer || !txLog) {
      throw new Error('version, txServer, and txLog are required');
    }

    // Ensure validator is downloaded if autoDownload is enabled
    if (autoDownload) {
      await this.ensureValidator({ skipUpdateCheck });
    } else if (!fs.existsSync(this.validatorJarPath)) {
      throw new Error(`Validator JAR not found at ${this.validatorJarPath}. Set autoDownload: true or download manually.`);
    }

    this.port = port;
    this.baseUrl = `http://localhost:${port}`;

    // Build command line arguments
    const args = [
      '-jar', this.validatorJarPath,
      '-server', port.toString(),
      '-tx', txServer,
      '-txLog', txLog,
      '-version', version
    ];

    // Add implementation guides
    for (const ig of igs) {
      args.push('-ig', ig);
    }

    this.log('info', `Starting FHIR validator with command: java ${args.join(' ')}`);

    // Spawn the Java process
    this.process = spawn('java', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Handle process events
    this.process.on('error', (error) => {
      this.log('error', 'Failed to start validator process:', error);
      throw error;
    });

    this.process.on('exit', (code, signal) => {
      this.log('info', `Validator process exited with code ${code} and signal ${signal}`);
      this.cleanup();
    });

    // Capture stdout and stderr for debugging
    this.process.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        // Remove ANSI escape sequences (color codes, etc.)
        const cleanLine = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
        if (cleanLine.length > 1) {
          this.checkForVersion(cleanLine);
          this.log('info', `Validator: ${cleanLine}`);
        }
      });
    });

    this.process.stderr.on('data', (data) => {
      this.log('error', `Validator-err: ${data}`);
    });

    // Wait for the service to be ready
    await this.waitForReady(timeout);
    this.log('info', 'FHIR validator service is ready');
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
   * Load an Implementation Guide
   * @param {string} packageId - The package ID (e.g., "hl7.fhir.us.core")
   * @param {string} version - The version (e.g., "6.0.0")
   * @returns {Promise<Object>} - The OperationOutcome as a JavaScript object
   */
  async loadIG(packageId, version) {
    if (!this.isReady) {
      throw new Error('Validator service is not ready');
    }

    const queryParams = new URLSearchParams();
    queryParams.set('packageId', packageId);
    queryParams.set('version', version);

    const url = `${this.baseUrl}/loadIG?${queryParams.toString()}`;

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const requestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
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
        reject(new Error('Load IG request timeout'));
      });

      req.end();
    });
  }

  /**
   * Run a terminology server test
   * @param {Object} params - Test parameters
   * @param {string} params.server - The address of the terminology server to test
   * @param {string} params.suiteName - The suite name that contains the test to run
   * @param {string} params.testName - The test name to run
   * @param {string} params.version - What FHIR version to use for the test
   * @param {string} [params.externalFile] - Optional name of messages file
   * @param {string} [params.modes] - Optional comma delimited string of modes
   * @returns {Promise<{result: boolean, message?: string}>}
   */
  async runTxTest(params) {
    if (!this.isReady) {
      throw new Error('Validator service is not ready');
    }

    const { server, suiteName, testName, version, externalFile, modes } = params;

    if (!server || !suiteName || !testName || !version) {
      throw new Error('server, suiteName, testName, and version are required');
    }

    // Build query parameters
    const queryParams = new URLSearchParams();
    queryParams.set('server', server);
    queryParams.set('suite', suiteName);
    queryParams.set('test', testName);
    queryParams.set('version', version);

    if (externalFile) {
      queryParams.set('externalFile', externalFile);
    }
    if (modes) {
      queryParams.set('modes', modes);
    }

    const url = `${this.baseUrl}/txTest?${queryParams.toString()}`;

    return new Promise((resolve) => {
      const parsedUrl = new URL(url);
      const requestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'Accept': 'application/fhir+json'
        }
      };

      const req = http.request(requestOptions, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          // Handle HTTP errors
          if (res.statusCode >= 400) {
            resolve({
              result: false,
              message: `HTTP error ${res.statusCode}: ${data}`
            });
            return;
          }

          try {
            const outcome = JSON.parse(data);

            // Check if it's a valid OperationOutcome
            if (outcome.resourceType !== 'OperationOutcome') {
              resolve({
                result: false,
                message: `Unexpected response type: ${outcome.resourceType || 'unknown'}`
              });
              return;
            }

            // No issues means success
            if (!outcome.issue || outcome.issue.length === 0) {
              resolve({ result: true });
              return;
            }

            // Check for error severity issues
            const errorIssue = outcome.issue.find(issue => issue.severity === 'error');
            if (errorIssue) {
              resolve({
                result: false,
                message: errorIssue.details?.text || errorIssue.diagnostics || 'Test failed with error'
              });
              return;
            }

            // No error issues, test passed
            resolve({ result: true });

          } catch (error) {
            resolve({
              result: false,
              message: `Failed to parse response: ${error.message}`
            });
          }
        });
      });

      req.on('error', (error) => {
        resolve({
          result: false,
          message: `Request failed: ${error.message}`
        });
      });

      req.setTimeout(60000, () => {
        req.destroy();
        resolve({
          result: false,
          message: 'Request timeout'
        });
      });

      req.end();
    });
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
        this.log('warn', 'Force killing validator process after timeout');
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
        this.cleanup();
        resolve();
      }, 10000);

      const onExit = () => {
        clearTimeout(timeout);
        this.cleanup();
        resolve();
      };

      this.process.once('exit', onExit);

      this.log('info', 'Stopping validator process...');
      this.process.kill('SIGKILL');
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

  checkForVersion(cleanLine) {
    if (!this.version) {
      if (cleanLine.startsWith('FHIR Validation tool Version')) {
        let parts = cleanLine.split(' ');
        this.version = parts[4];
      }
    }
  }
}

module.exports = FhirValidator;