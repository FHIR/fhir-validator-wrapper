const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/**
 * Node.js wrapper for the FHIR Validator HTTP Service
 */
// How much of the validator's output to keep for reporting a failed start
const MAX_OUTPUT_TAIL = 8000;
// Where the validator jar may be downloaded from (the GitHub release and its asset storage)
const DOWNLOAD_HOSTS = ['github.com', 'githubusercontent.com'];
// How much of a response from the validator service to accept
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

// The first validator release with the -txTests option. Before it, the /txTest endpoints were
// always on, and the option is unknown (so passing it stops the validator starting)
const TX_TESTS_OPTION_VERSION = '7.0.4';

/**
 * Whether a validator version is older than another: x.y.z, compared numerically, ignoring
 * anything after the numbers (-SNAPSHOT, say). False if either can't be read.
 */
function versionBefore(version, than) {
  const parse = v => (typeof v === 'string' ? v.match(/^(\d+)\.(\d+)\.(\d+)/) : null);
  const a = parse(version);
  const b = parse(than);
  if (!a || !b) {
    return false;
  }
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) !== Number(b[i])) {
      return Number(a[i]) < Number(b[i]);
    }
  }
  return false;
}

/** A command line argument for the validator must match the pattern, or start() refuses it. */
function checkArgument(name, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${name} is not acceptable: ${JSON.stringify(value)}`);
  }
}

/**
 * Collect a response body, as a string, up to MAX_RESPONSE_BYTES.
 * @returns {Promise<string>}
 */
function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        res.destroy();
        reject(new Error(`The validator's response is bigger than ${MAX_RESPONSE_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

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
    // The tail of what the validator process wrote: lastStderr is stderr alone, lastOutput is
    // stdout and stderr interleaved as they arrived. The validator logs to stdout, so lastOutput
    // is the one with anything in it - see start().
    this.lastStderr = '';
    this.lastOutput = '';
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
        // What is downloaded here is run with java -jar, so it only comes over TLS, and only
        // from GitHub: a redirect to http, or to somewhere else, is refused rather than followed
        if (parsedUrl.protocol !== 'https:') {
          reject(new Error(`Refusing to download the validator over ${parsedUrl.protocol.replace(':', '')}: ${downloadUrl}`));
          return;
        }
        if (!DOWNLOAD_HOSTS.some(h => parsedUrl.hostname === h || parsedUrl.hostname.endsWith('.' + h))) {
          reject(new Error(`Refusing to download the validator from ${parsedUrl.hostname}: not a GitHub host`));
          return;
        }

        const req = https.get(downloadUrl, {
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

    // Check for latest version. If GitHub can't be reached and there is a jar, use it: an
    // outage there should not stop a server that has everything it needs from starting
    this.log('info', 'Checking for latest FHIR validator release...');
    let latest;
    try {
      latest = await this.getLatestRelease();
    } catch (error) {
      if (jarExists) {
        this.log('warn', `Could not check for a newer validator (${error.message}); using the existing JAR (${installedVersion || 'unknown version'})`);
        return { version: installedVersion || 'unknown', updated: false, downloaded: false };
      }
      throw error;
    }
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
   * The command line arguments for the txTests setting.
   * @param {boolean} txTests - whether runTxTest() is to be used
   * @param {string|null} jarVersion - the validator's version, if known
   * @returns {string[]} ['-txTests'], or nothing when the tests aren't wanted, or the validator
   *   predates the option (its endpoints are always on). An unknown version gets the option.
   */
  txTestsArgs(txTests, jarVersion) {
    if (!txTests) {
      return [];
    }
    if (versionBefore(jarVersion, TX_TESTS_OPTION_VERSION)) {
      this.log('info', `Validator ${jarVersion} predates -txTests (${TX_TESTS_OPTION_VERSION}); its terminology test endpoints are always on`);
      return [];
    }
    return ['-txTests'];
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
   * @param {boolean} [config.ssrfProtection=true] - Server-Side Request Forgery protection in the validator.
   *   When true (the default) the validator refuses http:// URLs and refuses to connect to non-public
   *   addresses such as localhost or private network ranges. Set to false only when the validator must
   *   reach a terminology server (or other resource) on the local machine or a private network, AND no
   *   untrusted party can influence the content being validated - e.g. a test harness running its own
   *   terminology server on localhost. Requires validator 6.10.0 or later.
   * @param {boolean} [config.txTests=false] - Turn on the validator's terminology test endpoints, which
   *   runTxTest() uses. From validator 7.0.4 they are off unless the validator is started with -txTests:
   *   they connect to whatever server the caller names and write output files on this machine, so they
   *   are meant for a build pipeline, not a validator other people can reach. Older validators have the
   *   endpoints always on and don't know the option, so it is not passed to them.
   * @param {string[]} [config.extraArgs] - Additional raw command line arguments appended to the validator
   *   invocation. Escape hatch for validator options this wrapper does not model explicitly.
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
      skipUpdateCheck = false,
      ssrfProtection = true,
      txTests = false,
      extraArgs = []
    } = config;

    if (!version || !txServer || !txLog) {
      throw new Error('version, txServer, and txLog are required');
    }
    // The arguments go to spawn() as an array, so there is no shell to inject into, but a
    // value starting with '-' would be read by the validator as an option of its own
    // (-allowNetworkAccess, say). Configuration is trusted, but it is also edited by hand.
    checkArgument('version', version, /^[0-9][0-9A-Za-z.\-]*$/);
    checkArgument('txServer', txServer, /^(n\/a|https?:\/\/\S+)$/);
    checkArgument('txLog', txLog, /^[^-]/);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`port must be an integer from 1 to 65535, not ${JSON.stringify(port)}`);
    }
    if (typeof txTests !== 'boolean') {
      throw new Error(`txTests must be true or false, not ${JSON.stringify(txTests)}`);
    }
    if (!Array.isArray(igs)) {
      throw new Error('igs must be an array of package ids (id#version)');
    }
    for (const ig of igs) {
      checkArgument('igs', ig, /^[A-Za-z0-9][A-Za-z0-9.\-]*(#[A-Za-z0-9][A-Za-z0-9.\-+]*)?$/);
    }

    // Ensure validator is downloaded if autoDownload is enabled
    if (autoDownload) {
      await this.ensureValidator({ skipUpdateCheck });
    } else if (!fs.existsSync(this.validatorJarPath)) {
      throw new Error(`Validator JAR not found at ${this.validatorJarPath}. Set autoDownload: true or download manually.`);
    }

    this.port = port;
    // 127.0.0.1, not localhost: the validator binds the loopback address (unless started with
    // -allowNetworkAccess), and 'localhost' can resolve to ::1 first on a dual-stack machine,
    // which makes every request fail or wait for a fallback
    this.baseUrl = `http://127.0.0.1:${port}`;

    // Build command line arguments
    const args = [
      '-jar', this.validatorJarPath,
      // 'server', not '-server': the CLI still accepts the dashed form but maps it and warns
      'server', port.toString(),
      '-tx', txServer,
      '-txLog', txLog,
      '-version', version
    ];

    // Add implementation guides
    for (const ig of igs) {
      args.push('-ig', ig);
    }

    // SSRF protection is on by default in the validator; only pass the option when turning it off,
    // so that fhir-settings.json remains in control when the caller has no opinion.
    if (ssrfProtection === false) {
      args.push('-ssrf-protection-enabled', 'false');
      this.log('warn', 'SSRF protection is disabled for this validator instance. The validator will accept http:// URLs and connect to localhost / private network addresses. Only do this where no untrusted party can influence the content being validated.');
    }

    args.push(...this.txTestsArgs(txTests, this.getInstalledVersion()));

    // Escape hatch for validator options this wrapper does not model explicitly
    if (extraArgs.length > 0) {
      if (extraArgs.some(a => typeof a !== 'string')) {
        throw new Error('extraArgs must be strings');
      }
      if (extraArgs.includes('-allowNetworkAccess')) {
        this.log('warn', 'The validator service will listen on all network interfaces (-allowNetworkAccess). It has no authentication: anything that can reach the port can validate, load packages, and stop it.');
        if (txTests) {
          this.log('warn', 'The terminology test endpoints are on (txTests) and the validator is reachable from the network: callers can run tests against servers configured in fhir-settings and write output files on this machine.');
        }
      }
      args.push(...extraArgs);
    }

    this.log('info', `Starting FHIR validator with command: java ${args.join(' ')}`);

    // Spawn the Java process
    this.process = spawn('java', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Handle process events. 'error' is emitted asynchronously (no java on the path, say) -
    // throwing from the handler would be an uncaught exception that takes the host process
    // down, so it is turned into a rejection of start() below instead
    let spawnError = null;
    this.process.on('error', (error) => {
      this.log('error', 'Failed to start validator process:', error);
      spawnError = error;
      this.cleanup();
    });

    // the validator must not outlive the process that started it: an orphaned validator
    // keeps the port, and keeps answering
    this.killOnExit = () => {
      if (this.process && !this.process.killed) {
        this.process.kill('SIGKILL');
      }
    };
    process.on('exit', this.killOnExit);

    this.process.on('exit', (code, signal) => {
      this.log('info', `Validator process exited with code ${code} and signal ${signal}`);
    });

    this.process.on('close', (code, signal) => {
      this.log('info', `Validator process closed`);
      this.cleanup();
    });

    // Capture stdout and stderr for debugging.
    //
    // A 'data' event carries a chunk, not a line: the boundary falls wherever the pipe happened
    // to fill, which is usually mid-line and in a different place every run. Splitting each
    // chunk on its own therefore broke single log lines into two - and broke the version
    // detection below with them, since the version can land either side of the split. Hold the
    // tail of each chunk until the newline that ends it arrives, and flush whatever is left
    // when the process closes.
    const lineBuffers = { stdout: '', stderr: '' };

    const consumeLines = (stream, data, emit) => {
      lineBuffers[stream] += data.toString();
      const lines = lineBuffers[stream].split('\n');
      lineBuffers[stream] = lines.pop(); // no newline yet: it is the start of the next line
      lines.forEach(emit);
    };

    const flushLines = (stream, emit) => {
      const rest = lineBuffers[stream];
      lineBuffers[stream] = '';
      if (rest) {
        emit(rest);
      }
    };

    // Remove ANSI escape sequences (color codes, etc.)
    const clean = (line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim();

    const emitOut = (line) => {
      const cleanLine = clean(line);
      if (cleanLine.length > 1) {
        this.checkForVersion(cleanLine);
        this.log('info', `Validator: ${cleanLine}`);
      }
    };

    const emitErr = (line) => {
      const cleanLine = clean(line);
      if (cleanLine.length > 0) {
        this.log('error', `Validator-err: ${cleanLine}`);
      }
    };

    // What gets reported if the process dies during startup. It has to include stdout: the
    // validator logs everything through logback, whose console appender writes to stdout, so
    // the stack trace behind a failed start is there and stderr is empty. Kept raw and unsplit,
    // and bounded, since a validator that runs for hours should not accumulate its whole log
    // here.
    this.lastStderr = '';
    this.lastOutput = '';

    const keepTail = (text) => (text.length > MAX_OUTPUT_TAIL ? text.slice(-MAX_OUTPUT_TAIL) : text);

    this.process.stdout.on('data', (data) => {
      this.lastOutput = keepTail(this.lastOutput + data.toString());
      consumeLines('stdout', data, emitOut);
    });

    this.process.stderr.on('data', (data) => {
      const text = data.toString();
      this.lastStderr = keepTail(this.lastStderr + text);
      this.lastOutput = keepTail(this.lastOutput + text);
      consumeLines('stderr', data, emitErr);
    });

    this.process.on('close', () => {
      flushLines('stdout', emitOut);
      flushLines('stderr', emitErr);
    });

    // Wait for the service to be ready
    const child = this.process;
    await Promise.race([
      this.waitForReady(timeout).catch(e => {
        throw spawnError ? new Error(`Failed to start the validator process: ${spawnError.message}`) : e;
      }),
      new Promise((_, reject) => {
        child.on('error', (error) => reject(new Error(`Failed to start the validator process: ${error.message}`)));
        child.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`Validator exited with code ${code}:\n${this.lastOutput.slice(-2000)}`));
          }
        });
      })
    ]);

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
      // The Promise.race in start() settles on whichever finishes first, but it does not stop
      // the other one. Without this check, a validator that dies during startup leaves this
      // loop polling a dead port for the rest of the timeout, holding a timer long after
      // start() has already rejected - which is what keeps a test runner alive after its tests
      // have finished, and what logs 'process closed' into a test that is over. cleanup()
      // clears this.process when the process closes, so that is the signal to stop.
      if (this.process === null) {
        throw new Error('Validator process exited before the service was ready');
      }
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
   * @param {string} [options.bpWarnings] - Best practice warning level ("Ignore", "Hint", "Warning", "Error")
   * @param {string} [options.displayOption] - How displays are checked ("Ignore", "Check", "CheckCaseAndSpace", ...)
   * @param {boolean} [options.checkIpsCodes] - Run the validator's IPS code checks
   * @param {string[]} [options.extensions] - Extension domains that are allowed ("any" for all)
   * @param {Object<string, string|boolean|number|string[]>} [options.params] - Any other
   *   parameter of the validator's /validateResource (ParamNames in org.hl7.fhir.validation),
   *   as name -> value; an array value is sent once per element
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

    // Build query parameters - with the names the validator's service uses
    // (org.hl7.fhir.validation.http.ParamNames); it refuses any it doesn't know. Profiles and
    // extensions are repeated parameters, not comma separated lists
    const queryParams = new URLSearchParams();

    for (const p of options.profiles || []) {
      queryParams.append('profile', p);
    }
    for (const e of options.extensions || []) {
      queryParams.append('extension', e);
    }
    if (options.resourceIdRule) {
      queryParams.set('resourceIdRule', options.resourceIdRule);
    }
    if (options.bpWarnings) {
      queryParams.set('bestPractice', options.bpWarnings);
    }
    if (options.displayOption) {
      queryParams.set('checkDisplay', options.displayOption);
    }
    if (options.checkIpsCodes !== undefined) {
      queryParams.set('checkIpsCodes', String(options.checkIpsCodes));
    }
    if (options.anyExtensionsAllowed !== undefined) {
      // the old name for extensions: ['any']
      if (options.anyExtensionsAllowed) {
        queryParams.append('extension', 'any');
      }
    }
    for (const [name, value] of Object.entries(options.params || {})) {
      for (const v of (Array.isArray(value) ? value : [value])) {
        queryParams.append(name, String(v));
      }
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
        readBody(res).then((data) => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            // the body is the validator's, not the caller's: keep it out of the message, which
            // callers tend to pass on to their own clients
            reject(new Error(`The validator returned HTTP ${res.statusCode} with a response that is not JSON (${data.length} bytes)`));
          }
        }, reject);
      });

      req.on('error', reject);

      req.setTimeout(options.timeout || 30000, () => {
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

    checkArgument('packageId', packageId, /^[A-Za-z0-9][A-Za-z0-9.\-]*$/);
    checkArgument('version', version, /^[A-Za-z0-9][A-Za-z0-9.\-+]*$/);
    // the service (LoadIGHTTPHandler) takes a JSON body, {"ig": "id#version"} - not query
    // parameters: without a body it fails, parsing nothing as JSON
    const body = Buffer.from(JSON.stringify({ ig: `${packageId}#${version}` }), 'utf8');

    const url = `${this.baseUrl}/loadIG`;

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const requestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'Accept': 'application/fhir+json'
        }
      };

      const req = http.request(requestOptions, (res) => {
        readBody(res).then((data) => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error(`The validator returned HTTP ${res.statusCode} with a response that is not JSON (${data.length} bytes)`));
          }
        }, reject);
      });

      req.on('error', reject);

      req.setTimeout(300000, () => {
        req.destroy();
        reject(new Error('Load IG request timeout'));
      });

      req.end(body);
    });
  }

  /**
   * Run a terminology server test
   * @param {Object} params - Test parameters
   * Needs the service to have been started with txTests: true (validator 7.0.4 and later).
   * @param {string} params.server - The address of the terminology server to test
   * @param {string} params.suiteName - The suite name that contains the test to run
   * @param {string} params.testName - The test name to run
   * @param {string} params.version - What FHIR version to use for the test
   * @param {string} [params.externalFile] - Optional name of messages file
   * @param {string} [params.modes] - Optional comma delimited string of modes
   * @param {string} [params.folder] - Optional name for the folder the run writes its
   *   expected/actual files into, under the validator's temp directory. A name, not a path.
   *   Defaults to the terminology server's host name
   * @param {string} [params.label] - Optional subfolder of that folder for this test's output.
   *   Without it, a caller that runs the same test more than one way - R4 and R5, cached and
   *   not - has each run write over the last one's diffs
   * @returns {Promise<{result: boolean, message?: string}>}
   */
  async runTxTest(params) {
    if (!this.isReady) {
      throw new Error('Validator service is not ready');
    }

    const { server, suiteName, testName, version, externalFile, modes, folder, label } = params;

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
      // 'externals' is what the validator reads; this was sent as 'externalFile' and so was
      // never picked up - the validator quietly used its default messages file instead
      queryParams.set('externals', externalFile);
    }
    if (modes) {
      queryParams.set('modes', modes);
    }
    if (folder) {
      queryParams.set('folder', folder);
    }
    if (label) {
      queryParams.set('label', label);
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
        readBody(res).then((data) => {
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
        }, (error) => resolve({ result: false, message: `Request failed: ${error.message}` }));
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
    if (this.killOnExit) {
      process.removeListener('exit', this.killOnExit);
      this.killOnExit = null;
    }
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