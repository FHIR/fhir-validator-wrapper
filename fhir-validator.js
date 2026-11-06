const { spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { pipeline, Transform } = require('stream');
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
// The first validator release with /txTest/setup and /txTest/teardown (test sessions)
const TX_SESSION_VERSION = '7.0.4';
// The first validator release with -nonce. Given one, the service returns it in an
// X-Validator-Nonce header on every response, so the wrapper can tell the validator it started
// from anything else that answers on the port
const NONCE_OPTION_VERSION = '7.0.5';
const NONCE_HEADER = 'x-validator-nonce';
// The first validator release that takes a bare -txTests after the server command. 7.0.4 rewrote
// it to the old txTests command, so it was given -txTests=true instead
const TX_TESTS_BARE_OPTION_VERSION = '7.0.5';
// The first validator release with /canonical
const CANONICAL_VERSION = '7.0.5';
// The first validator release with -autoLoadPackages: /canonical finds, downloads and loads the
// package that defines a canonical resource the validator doesn't know yet
const AUTO_LOAD_PACKAGES_VERSION = '7.0.5';
// How long to wait for /canonical: a lookup that loads a package can mean downloading it, and
// its dependencies
const CANONICAL_TIMEOUT_MS = 60000;
const CANONICAL_AUTO_LOAD_TIMEOUT_MS = 300000;
// The first validator release whose /validateResource takes validationTimeout
const VALIDATION_TIMEOUT_VERSION = '6.9.0';
// How much of GitHub's description of a release to accept
const MAX_RELEASE_INFO_BYTES = 4 * 1024 * 1024;

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

/** Whether a validator version is known (it starts x.y.z) and is at least min. */
function versionAtLeast(version, min) {
  return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) && !versionBefore(version, min);
}

/**
 * A line of the validator's output, made safe to log: escape sequences (colour, but also cursor
 * movement, window titles, ...) and other control characters are taken out, along with the
 * Unicode bidi overrides. The validator's output includes text from elsewhere - messages from
 * terminology servers, parts of the content being validated - so it can carry sequences meant
 * for whatever terminal or log viewer the log ends up in.
 */
function cleanLogLine(line) {
  return line
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '') // OSC ... BEL or ST
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '') // CSI (SGR colours, cursor movement, ...)
    .replace(/\u001b[ -~]?/g, '') // any other escape
    .replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '') // C0 (but tab), DEL, C1, bidi
    .trim();
}

/** Text of several lines, each made safe as cleanLogLine() does. */
function cleanLogText(text) {
  return text.split('\n').map(cleanLogLine).join('\n');
}

/** Hide the user:password@ part of any URL in the text. */
function hideCredentials(text) {
  return text.replace(/(\/\/)[^/@\s]*@/g, '$1***@');
}

/** The sha256 of a file, as hex. */
function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** The hex sha256 from a GitHub asset digest ('sha256:<hex>'), or null. */
function sha256FromDigest(digest) {
  const m = typeof digest === 'string' ? digest.match(/^sha256:([0-9a-f]{64})$/i) : null;
  return m ? m[1].toLowerCase() : null;
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
    // the nonce the validator was started with (null when it predates -nonce)
    this.nonce = null;
    // whether the validator was started with -autoLoadPackages
    this.autoLoadPackages = false;
    // whether something other than this validator answered on the port while it was starting
    this.portTaken = false;
    // the terminology test sessions started with txTestSetup() and not yet torn down
    this.txSessions = new Set();
  }

  /**
   * @returns what version the validator jar reports that it is
   */
  jarVersion() {
    return this.version;
  }

  /**
   * The validator's version as best known: what it reported when it started, or else what the
   * version file says was downloaded. Null when neither is known (a jar of the caller's own, say)
   * @private
   */
  knownVersion() {
    return this.version || this.getInstalledVersion();
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
        let tooBig = false;

        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > MAX_RELEASE_INFO_BYTES && !tooBig) {
            tooBig = true;
            req.destroy();
            reject(new Error(`GitHub's description of the release is bigger than ${MAX_RELEASE_INFO_BYTES} bytes`));
          }
        });

        res.on('end', () => {
          if (tooBig) {
            return;
          }
          if (res.statusCode !== 200) {
            // GitHub says why (a rate limit, usually); keep that, but not all of it
            reject(new Error(`GitHub API returned status ${res.statusCode}: ${data.slice(0, 500)}`));
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
              publishedAt: release.published_at,
              // the asset's size, and its digest ('sha256:<hex>') when GitHub gives one
              size: asset.size,
              digest: asset.digest || null
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
    const info = this.getVersionInfo();
    return info ? info.version || null : null;
  }

  /**
   * What the version file says about the installed jar: {version, downloadUrl, downloadedAt,
   * digest}, or null if there's no version file (or it can't be read)
   * @private
   */
  getVersionInfo() {
    try {
      if (fs.existsSync(this.versionFilePath)) {
        return JSON.parse(fs.readFileSync(this.versionFilePath, 'utf8'));
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
   * @param {string} [digest] - The release's digest of the jar ('sha256:<hex>'), if it gave one
   */
  saveVersionInfo(version, downloadUrl, digest) {
    const versionInfo = {
      version,
      downloadUrl,
      downloadedAt: new Date().toISOString()
    };
    if (digest) {
      versionInfo.digest = digest;
    }
    fs.writeFileSync(this.versionFilePath, JSON.stringify(versionInfo, null, 2));
  }

  /**
   * Download a file from a URL, following redirects
   * @param {string} url - The URL to download from
   * @param {string} destPath - The destination file path
   * @param {Object} [expected] - What the download must be, or it is not put in place
   * @param {number} [expected.size] - Its size in bytes
   * @param {string} [expected.sha256] - Its sha256, as hex
   * @returns {Promise<void>}
   */
  async downloadFile(url, destPath, expected = {}) {
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
            res.resume(); // nothing in it is wanted, but it has to be read for the socket to be freed
            // the location can be relative
            const next = new URL(res.headers.location, downloadUrl).toString();
            this.log('info', `Following redirect to ${next}`);
            downloadWithRedirects(next, redirectCount + 1);
            return;
          }

          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Download failed with status ${res.statusCode}`));
            return;
          }

          const contentLength = parseInt(res.headers['content-length'], 10) || undefined;
          this.saveDownload(res, destPath, { contentLength, size: expected.size, sha256: expected.sha256 }).then(resolve, reject);
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
   * Write a download to destPath. It goes to a temporary file of its own first, and is renamed
   * into place only once all of it has arrived - as many bytes as the server said it would send,
   * and the release says the jar has - and, when a sha256 is given, it is the right bytes. A
   * download that fails in any way leaves destPath as it was, and no temporary file behind.
   * @param {stream.Readable} res - The response
   * @param {string} destPath - Where it goes
   * @param {Object} [expect]
   * @param {number} [expect.contentLength] - The response's Content-Length
   * @param {number} [expect.size] - What the release says the jar's size is
   * @param {string} [expect.sha256] - The sha256 it must have, as hex
   * @returns {Promise<{bytes: number, sha256: string}>}
   * @private
   */
  saveDownload(res, destPath, expect = {}) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      // A name of its own, and created new ('wx'): two starts that share a jar (two modules of
      // one server, say) don't write into the same temporary file, and a file or link that is
      // already there is never written through
      const tempPath = `${destPath}.download-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      const hash = crypto.createHash('sha256');
      const total = expect.contentLength || expect.size;
      let bytes = 0;
      let lastLoggedPercent = 0;
      const progress = (n) => this.log('info', n);

      const meter = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          hash.update(chunk);
          if (total) {
            const percent = Math.floor((bytes / total) * 100);
            if (percent >= lastLoggedPercent + 10) {
              progress(`Download progress: ${percent}% (${Math.round(bytes / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB)`);
              lastLoggedPercent = percent;
            }
          }
          callback(null, chunk);
        }
      });

      const out = fs.createWriteStream(tempPath, { flags: 'wx' });
      // the temporary file is this download's to remove - unless it was already there
      let ours = true;
      out.on('error', (error) => {
        if (error.code === 'EEXIST') {
          ours = false;
        }
      });

      const fail = (error) => {
        if (ours) {
          fs.rm(tempPath, { force: true }, () => reject(error));
        } else {
          reject(error);
        }
      };

      // pipeline, not pipe: pipe doesn't pass on an error from the response, so a connection
      // that dropped part way left the file stream open and the download waiting forever
      pipeline(res, meter, out, (error) => {
        if (error) {
          fail(new Error(`Download failed: ${error.message}`));
          return;
        }
        const sha256 = hash.digest('hex');
        const problem = FhirValidator.checkDownload(bytes, sha256, expect);
        if (problem) {
          fail(new Error(problem));
          return;
        }
        fs.rename(tempPath, destPath, (renameError) => {
          if (renameError) {
            fail(renameError);
          } else {
            resolve({ bytes, sha256 });
          }
        });
      });
    });
  }

  /**
   * Why a download is not what was expected, or null if it is.
   * @param {number} bytes - How many bytes arrived
   * @param {string} sha256 - Their sha256, as hex
   * @param {Object} expect - contentLength, size, sha256: as saveDownload() takes them
   * @returns {string|null}
   */
  static checkDownload(bytes, sha256, expect) {
    if (expect.contentLength && bytes !== expect.contentLength) {
      return `The download was cut short: ${bytes} of ${expect.contentLength} bytes`;
    }
    if (expect.size && bytes !== expect.size) {
      return `The download is ${bytes} bytes, but the release says the jar is ${expect.size}`;
    }
    if (expect.sha256 && sha256 !== expect.sha256) {
      return `The download's sha256 (${sha256}) is not the one the release gives (${expect.sha256})`;
    }
    return null;
  }

  /**
   * Check the jar on disk against a release's digest.
   * @param {string|null} digest - The digest ('sha256:<hex>')
   * @param {string} what - What the digest is, for the error message
   * @returns {Promise<boolean>} whether it matches. Rejects when there is no digest to check against
   * @private
   */
  async jarMatches(digest, what) {
    const expected = sha256FromDigest(digest);
    if (!expected) {
      throw new Error(`The validator jar can't be verified: there is no sha256 digest for it (${what})`);
    }
    return (await fileSha256(this.validatorJarPath)) === expected;
  }

  /**
   * Ensure the validator JAR is downloaded and up to date
   * @param {Object} [options] - Options for the update check
   * @param {boolean} [options.force=false] - Force download even if current version is up to date
   * @param {boolean} [options.skipUpdateCheck=false] - Skip checking for updates if JAR exists
   * @param {boolean} [options.verify=false] - Check the jar against the sha256 digest GitHub gives
   *   for the release asset: a download that doesn't match is not used, and nor is a jar already on
   *   disk that doesn't match (it is downloaded again when the update check runs, and an error
   *   otherwise). Fails when there is no digest to check against. Whether verifying or not, a
   *   download is only used once all of it has arrived
   * @returns {Promise<{version: string, updated: boolean, downloaded: boolean}>}
   */
  async ensureValidator(options = {}) {
    const { force = false, skipUpdateCheck = false, verify = false } = options;

    const jarExists = fs.existsSync(this.validatorJarPath);
    const installedInfo = this.getVersionInfo();
    const installedVersion = installedInfo ? installedInfo.version || null : null;

    // the jar on disk, checked against the digest recorded when it was downloaded: when there's
    // no update check to compare it with the release's
    const verifyAsRecorded = async () => {
      if (!(await this.jarMatches(installedInfo && installedInfo.digest, 'none was recorded when it was downloaded'))) {
        throw new Error(`The validator jar at ${this.validatorJarPath} does not match the digest recorded when it was downloaded`);
      }
      this.log('info', 'Validator jar verified against the digest recorded when it was downloaded');
    };

    // If JAR exists and we're skipping update checks, we're done
    if (jarExists && skipUpdateCheck && !force) {
      if (verify) {
        await verifyAsRecorded();
      }
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
        if (verify) {
          await verifyAsRecorded();
        }
        return { version: installedVersion || 'unknown', updated: false, downloaded: false };
      }
      throw error;
    }
    this.log('info', `Latest version: ${latest.version}`);

    const expectedSha256 = sha256FromDigest(latest.digest);
    if (verify && !expectedSha256) {
      throw new Error(`The validator jar can't be verified: GitHub gives no sha256 digest for validator_cli.jar in release ${latest.version}`);
    }

    // Determine if we need to download
    let needsDownload = force ||
      !jarExists ||
      !installedVersion ||
      installedVersion !== latest.version;

    if (!needsDownload && verify) {
      if (await this.jarMatches(latest.digest, `release ${latest.version}`)) {
        this.log('info', `Validator jar verified against release ${latest.version}`);
      } else {
        this.log('warn', `The validator jar at ${this.validatorJarPath} does not match release ${latest.version}; downloading it again`);
        needsDownload = true;
      }
    }

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

    await this.downloadFile(latest.downloadUrl, this.validatorJarPath, {
      size: latest.size,
      sha256: verify ? expectedSha256 : undefined
    });
    this.saveVersionInfo(latest.version, latest.downloadUrl, latest.digest);

    this.log('info', `Validator ${latest.version} downloaded successfully${verify ? ' and verified' : ''}`);

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
   * @returns {string[]} ['-txTests'] (['-txTests=true'] for validator 7.0.4, or a validator whose
   *   version isn't known), or nothing when the tests aren't wanted, or the validator predates the
   *   option (its endpoints are always on). An unknown version gets the option.
   */
  txTestsArgs(txTests, jarVersion) {
    if (!txTests) {
      return [];
    }
    if (versionBefore(jarVersion, TX_TESTS_OPTION_VERSION)) {
      this.log('info', `Validator ${jarVersion} predates -txTests (${TX_TESTS_OPTION_VERSION}); its terminology test endpoints are always on`);
      return [];
    }
    if (versionAtLeast(jarVersion, TX_TESTS_BARE_OPTION_VERSION)) {
      return ['-txTests'];
    }
    // validator 7.0.4 rewrites a bare '-txTests' anywhere on the command line to the old txTests
    // command, so 'server ... -txTests' never turned the endpoints on (the server read 'txTests' as
    // a source file). The '=true' form isn't rewritten, and sets the same option - and it is what an
    // unknown version gets, since every validator that has the option takes it
    return ['-txTests=true'];
  }

  /**
   * The command line arguments for the autoLoadPackages setting, and this.autoLoadPackages set to
   * match.
   * @param {boolean} wanted - whether package auto-loading is wanted (config.autoLoadPackages)
   * @param {string|null} jarVersion - the validator's version, if known
   * @returns {string[]} ['-autoLoadPackages'], or nothing when it isn't wanted, or the validator
   *   predates the option (which would stop it starting). An unknown version gets the option.
   */
  autoLoadPackagesArgs(wanted, jarVersion) {
    this.autoLoadPackages = false;
    if (!wanted) {
      return [];
    }
    if (versionBefore(jarVersion, AUTO_LOAD_PACKAGES_VERSION)) {
      this.log('warn', `Validator ${jarVersion} predates -autoLoadPackages (${AUTO_LOAD_PACKAGES_VERSION}); lookupCanonical() will only find what the validator already has loaded`);
      return [];
    }
    this.autoLoadPackages = true;
    return ['-autoLoadPackages'];
  }

  /**
   * The command line arguments for the nonce, and this.nonce set to match.
   * @param {boolean} wanted - whether a nonce is wanted (config.nonce)
   * @param {string|null} jarVersion - the validator's version, if known
   * @returns {string[]} ['-nonce', <nonce>], or nothing when it isn't wanted or the validator
   *   predates the option (which would stop it starting). An unknown version gets the option.
   */
  nonceArgs(wanted, jarVersion) {
    this.nonce = null;
    if (!wanted || versionBefore(jarVersion, NONCE_OPTION_VERSION)) {
      return [];
    }
    this.nonce = crypto.randomBytes(16).toString('hex');
    return ['-nonce', this.nonce];
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
   * @param {boolean} [config.autoLoadPackages=false] - Let lookupCanonical() find, download and load
   *   the package that defines a canonical resource the validator doesn't know yet (when no version is
   *   asked for) - the way the validator does for canonical URLs it meets while validating. The
   *   package is loaded into the engine every request uses, for good. Needs validator 7.0.5 or later;
   *   it isn't passed to older validators (they don't know the option)
   * @param {string[]} [config.extraArgs] - Additional raw command line arguments appended to the validator
   *   invocation. Escape hatch for validator options this wrapper does not model explicitly.
   * @param {boolean} [config.verifyJar=false] - Check the validator jar against the sha256 digest GitHub
   *   gives for the release (see ensureValidator's verify option). Only applies with autoDownload
   * @param {boolean} [config.nonce=true] - Start the validator with a random nonce, and only accept
   *   answers on the port that carry it back - so that a validator left running by an earlier process,
   *   or anything else that has the port, isn't mistaken for this one. Needs validator 7.0.5 or later;
   *   it isn't passed to older validators (they don't know the option)
   * @param {boolean} [config.logCommandLine=false] - Log the whole validator command line when it
   *   starts. Otherwise the log has it with credentials in URLs hidden, and the extraArgs counted
   *   rather than shown
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
      autoLoadPackages = false,
      extraArgs = [],
      verifyJar = false,
      nonce = true,
      logCommandLine = false
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
    for (const [name, value] of Object.entries({ txTests, autoLoadPackages, verifyJar, nonce, logCommandLine })) {
      if (typeof value !== 'boolean') {
        throw new Error(`${name} must be true or false, not ${JSON.stringify(value)}`);
      }
    }
    if (!Array.isArray(extraArgs)) {
      throw new Error('extraArgs must be an array of strings');
    }
    if (extraArgs.some(a => typeof a !== 'string')) {
      throw new Error('extraArgs must be strings');
    }
    if (!Array.isArray(igs)) {
      throw new Error('igs must be an array of package ids (id#version)');
    }
    for (const ig of igs) {
      checkArgument('igs', ig, /^[A-Za-z0-9][A-Za-z0-9.\-]*(#[A-Za-z0-9][A-Za-z0-9.\-+]*)?$/);
    }

    // Ensure validator is downloaded if autoDownload is enabled
    if (autoDownload) {
      await this.ensureValidator({ skipUpdateCheck, verify: verifyJar });
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

    const installedVersion = this.getInstalledVersion();
    args.push(...this.txTestsArgs(txTests, installedVersion));
    args.push(...this.autoLoadPackagesArgs(autoLoadPackages, installedVersion));

    // the nonce the service will return in a header: see healthCheck()
    this.portTaken = false;
    args.push(...this.nonceArgs(nonce, installedVersion));

    // Escape hatch for validator options this wrapper does not model explicitly
    if (extraArgs.length > 0) {
      // picocli takes the flag on its own, or with =true
      if (extraArgs.some(a => /^-allowNetworkAccess(=true)?$/i.test(a))) {
        this.log('warn', 'The validator service will listen on all network interfaces (-allowNetworkAccess). It has no authentication: anything that can reach the port can validate, load packages, and stop it.');
        if (txTests) {
          this.log('warn', 'The terminology test endpoints are on (txTests) and the validator is reachable from the network: callers can run tests against servers configured in fhir-settings and write output files on this machine.');
        } else if (versionBefore(installedVersion, TX_TESTS_OPTION_VERSION)) {
          this.log('warn', `Validator ${installedVersion} predates ${TX_TESTS_OPTION_VERSION}, so its terminology test endpoints are always on, and it is reachable from the network: anyone who can reach the port can have it connect to any server they name, and write output files on this machine. Use validator ${TX_TESTS_OPTION_VERSION} or later.`);
        }
        if (this.autoLoadPackages) {
          this.log('warn', 'Package auto-loading is on (autoLoadPackages) and the validator is reachable from the network: callers can make it download packages and load them into the engine every request uses.');
        }
      }
      args.push(...extraArgs);
    }

    this.log('info', `Starting FHIR validator with command: ${this.describeCommand(args, extraArgs.length, logCommandLine)}`);

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

    const emitOut = (line) => {
      const cleanLine = cleanLogLine(line);
      if (cleanLine.length > 1) {
        this.checkForVersion(cleanLine);
        this.log('info', `Validator: ${cleanLine}`);
      }
    };

    const emitErr = (line) => {
      const cleanLine = cleanLogLine(line);
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
            const taken = this.portTaken ? ` (port ${port} is in use: something other than this validator answered on it - a validator left running by an earlier process?)` : '';
            reject(new Error(`Validator exited with code ${code}${taken}:\n${cleanLogText(this.lastOutput.slice(-2000))}`));
          }
        });
      })
    ]);

    this.log('info', 'FHIR validator service is ready');
  }

  /**
   * The validator's command line, for the log. The nonce is never shown (it is no use to anyone
   * reading the log). Unless full is asked for, credentials in URLs are hidden, and the extra
   * arguments - which are whatever the caller put there - are counted, not shown.
   * @param {string[]} args - The arguments to java
   * @param {number} extraCount - How many of them, at the end, are extraArgs
   * @param {boolean} full - Show them all
   * @returns {string}
   * @private
   */
  describeCommand(args, extraCount, full) {
    const shown = args.map((a, i) => (i > 0 && args[i - 1] === '-nonce' ? '***' : a));
    if (full) {
      return `java ${shown.join(' ')}`;
    }
    const base = shown.slice(0, shown.length - extraCount).map(hideCredentials);
    const extra = extraCount > 0 ? ` (and ${extraCount} more argument${extraCount === 1 ? '' : 's'}: start with logCommandLine: true to see them)` : '';
    return `java ${base.join(' ')}${extra}`;
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
        if (this.process === null) {
          throw new Error('Validator process exited before the service was ready');
        }
        this.isReady = true;
        return;
      } catch (error) {
        if (this.process === null) {
          throw new Error('Validator process exited before the service was ready');
        }
        if (error.foreign && !this.portTaken) {
          this.portTaken = true;
          this.log('warn', `Something other than the validator being started is answering on port ${this.port} (no nonce, or the wrong one) - a validator left running by an earlier process? It isn't used; the new one will fail if it can't get the port`);
        }
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
        res.resume();
        // We expect a 405 Method Not Allowed since we're doing GET instead of POST - and, when the
        // validator was given a nonce, the nonce back: without it, whatever answered is not the
        // validator this started
        if (res.statusCode === 405 && this.nonce && res.headers[NONCE_HEADER] !== this.nonce) {
          const error = new Error(`What answered on port ${this.port} is not the validator that was started (no nonce, or the wrong one)`);
          error.foreign = true;
          reject(error);
        } else if (res.statusCode === 405) {
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
   * @param {number} [options.timeout=30000] - How long to wait for the outcome, in ms. The validator
   *   (6.9.0 and later) is told to stop validating a little before that - see below
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

    // The validator's service works on one request at a time, and goes on with a validation after
    // this end has given up on it, holding up everything queued behind it. So it is told to stop
    // when the request would time out - a little before, so that the outcome, with its timeout
    // issue, gets back in time. A validationTimeout in params is left as it is.
    const timeout = options.timeout || 30000;
    if (!queryParams.has('validationTimeout') && versionAtLeast(this.knownVersion(), VALIDATION_TIMEOUT_VERSION)) {
      queryParams.set('validationTimeout', String(Math.max(1000, Math.floor(timeout * 0.9))));
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

      req.setTimeout(timeout, () => {
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
   * GET a path on the validator service, and parse the answer as JSON.
   * @param {string} path - the path, e.g. '/canonical'
   * @param {URLSearchParams} query
   * @param {number} timeout - in ms
   * @returns {Promise<{status: number, body: Object|null, text: string}>} body is null when
   *   the response is not JSON
   */
  getJson(path, query, timeout) {
    return this.requestJson('GET', path, query, null, timeout);
  }

  /**
   * Make a request of the validator service, and parse the answer as JSON.
   * @param {string} method - GET or POST
   * @param {string} path - the path, e.g. '/txTest/setup'
   * @param {URLSearchParams|null} query
   * @param {Object|null} json - a body to send, as JSON
   * @param {number} timeout - in ms
   * @returns {Promise<{status: number, body: Object|null, text: string}>} body is null when
   *   the response is not JSON
   */
  requestJson(method, path, query, json, timeout) {
    const url = new URL(`${this.baseUrl}${path}${query ? '?' + query.toString() : ''}`);
    const data = json === null || json === undefined ? null : Buffer.from(JSON.stringify(json), 'utf8');
    const headers = { 'Accept': 'application/fhir+json' };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers
      }, (res) => {
        readBody(res).then((text) => {
          let body = null;
          try {
            body = JSON.parse(text);
          } catch (e) {
            body = null;
          }
          resolve({ status: res.statusCode, body, text });
        }, reject);
      });
      req.on('error', reject);
      req.setTimeout(timeout, () => {
        req.destroy();
        reject(new Error(`${path} request timeout`));
      });
      req.end(data || undefined);
    });
  }

  /**
   * The text of an OperationOutcome's first issue, for an error message.
   */
  static outcomeText(body, fallback) {
    const issue = Array.isArray(body?.issue) ? body.issue[0] : null;
    return issue?.details?.text || issue?.diagnostics || fallback;
  }

  /**
   * Check a FHIRPath expression's types, without evaluating it (the service's /fhirpath/check,
   * validator 7.0.4 and later): the expression is parsed and checked against the type it would
   * be evaluated on.
   * @param {string} type - A type name (a resource or data type), a path in one
   *   ("Patient.name"), or the canonical URL of a StructureDefinition
   * @param {string} expression - The FHIRPath expression
   * @returns {Promise<Object>} - An OperationOutcome: an error issue when the expression doesn't
   *   parse (with its line and column) or doesn't check, a warning for each warning the checking
   *   raises, and when there's no error, an information issue saying what the expression returns.
   *   Rejects when the validator refuses the request (the type or expression is too long) or
   *   doesn't have the endpoint
   */
  async checkFhirPath(type, expression) {
    if (!this.isReady) {
      throw new Error('Validator service is not ready');
    }
    if (typeof type !== 'string' || !type.trim()) {
      throw new Error('type is required');
    }
    if (typeof expression !== 'string' || !expression.trim()) {
      throw new Error('expression is required');
    }
    const query = new URLSearchParams();
    query.set('type', type);
    query.set('expression', expression);
    const { status, body } = await this.getJson('/fhirpath/check', query, 60000);
    if (status === 200 && body?.resourceType === 'OperationOutcome') {
      return body;
    }
    if (status === 404 && body === null) {
      throw new Error('The validator does not have /fhirpath/check (it needs validator 7.0.4 or later)');
    }
    throw new Error(`FHIRPath check failed: HTTP ${status}: ${FhirValidator.outcomeText(body, 'no OperationOutcome')}`);
  }

  /**
   * Look up a canonical resource (a StructureDefinition, ValueSet, CodeSystem...) by its canonical
   * URL, as the validator's context knows it - from the core package, the loaded IGs and what they
   * depend on (the service's /canonical, validator 7.0.5 and later). When the validator was started
   * with autoLoadPackages, and no version is asked for, a resource it doesn't know is looked for the
   * way the validator does: the package that defines it is worked out from the url, downloaded if
   * need be, and loaded into the validator (for every later request). Otherwise nothing is fetched
   * from elsewhere.
   * @param {string} url - The canonical URL (absolute), optionally with a |version suffix
   * @param {string} [version] - The version, if not given as a |version suffix (not both)
   * @returns {Promise<Object|null>} - The resource, or null when the validator doesn't know it.
   *   Rejects when the validator refuses the request (a relative url, say) or doesn't have the
   *   endpoint
   */
  async lookupCanonical(url, version) {
    if (!this.isReady) {
      throw new Error('Validator service is not ready');
    }
    if (typeof url !== 'string' || !url.trim()) {
      throw new Error('url is required');
    }
    if (version !== undefined && version !== null && typeof version !== 'string') {
      throw new Error('version must be a string');
    }
    const query = new URLSearchParams();
    query.set('url', url);
    if (version) {
      query.set('version', version);
    }
    const { status, body } = await this.getJson('/canonical', query, this.autoLoadPackages ? CANONICAL_AUTO_LOAD_TIMEOUT_MS : CANONICAL_TIMEOUT_MS);
    if (status === 200 && body && typeof body.resourceType === 'string') {
      return body;
    }
    if (status === 404 && body?.resourceType === 'OperationOutcome') {
      return null;
    }
    if (status === 404 && body === null) {
      throw new Error(`The validator does not have /canonical (it needs validator ${CANONICAL_VERSION} or later)`);
    }
    throw new Error(`Canonical lookup failed: HTTP ${status}: ${FhirValidator.outcomeText(body, 'no OperationOutcome')}`);
  }

  /**
   * Start a terminology test run - a session - against a server (the service's /txTest/setup,
   * validator 7.0.4 and later, started with txTests: true). The test cases are loaded and the
   * server is connected to now; its FHIR version decides the version the tests run in. Run the
   * tests with runTxTest({session, ...}), and end the run with txTestTeardown(session), which
   * returns the reports. Every session started has to be torn down: one that isn't keeps its
   * tester in the validator until it stops, and never writes its reports.
   * @param {Object} params
   * @param {string} params.server - The address of the terminology server to test
   * @param {string} [params.testVersion] - The version of the test cases (e.g. '1.9.6'); default
   *   'current'. Not a FHIR version
   * @param {Object|string} [params.externals] - The content of an externals (messages) file, as an
   *   object or as its JSON text - not a file name
   * @param {string} [params.folder] - A name for the folder the run writes its output into, under
   *   the validator's temp directory. A name, not a path. Default: the server's host name
   * @param {string} [params.tester] - For TestReport.tester
   * @returns {Promise<Object>} What the validator says about the run: session (the id to pass to
   *   runTxTest and txTestTeardown), server, test-version, fhirVersion, software, features, output
   */
  async txTestSetup(params) {
    if (!this.isReady) {
      throw new Error('Validator service is not ready');
    }
    const { server, testVersion, externals, folder, tester } = params || {};
    if (!server) {
      throw new Error('server is required');
    }
    const version = this.knownVersion();
    if (versionBefore(version, TX_SESSION_VERSION)) {
      throw new Error(`Terminology test sessions need validator ${TX_SESSION_VERSION} or later (this is ${version}); use runTxTest() with a server instead`);
    }
    const body = { server };
    if (testVersion) {
      body['test-version'] = testVersion;
    }
    if (externals !== undefined && externals !== null) {
      body.externals = externals;
    }
    if (folder) {
      body.folder = folder;
    }
    if (tester) {
      body.tester = tester;
    }
    // loading the test cases and connecting to the server can take a while
    const { status, body: res } = await this.requestJson('POST', '/txTest/setup', null, body, 300000);
    if (status === 200 && typeof res?.session === 'string') {
      this.txSessions.add(res.session);
      return res;
    }
    if (status === 404 && res === null) {
      throw new Error(`The validator does not have /txTest/setup (it needs validator ${TX_SESSION_VERSION} or later)`);
    }
    throw new Error(`Terminology test setup failed: HTTP ${status}: ${FhirValidator.outcomeText(res, 'no OperationOutcome')}`);
  }

  /**
   * End a terminology test run (the service's /txTest/teardown), once its last test has
   * returned. The validator writes the run's reports to its output folder, and returns them.
   * @param {string} session - The session id from txTestSetup()
   * @returns {Promise<Object>} {session, output, 'test-results', report}: test-results.json, and
   *   report.json - a FHIR TestReport with a score and an overall pass/fail
   */
  async txTestTeardown(session) {
    if (!this.isReady) {
      throw new Error('Validator service is not ready');
    }
    if (typeof session !== 'string' || !session) {
      throw new Error('session is required');
    }
    const query = new URLSearchParams();
    query.set('session', session);
    const { status, body } = await this.requestJson('POST', '/txTest/teardown', query, null, 120000);
    if (status === 200 && body && typeof body === 'object') {
      this.txSessions.delete(session);
      return body;
    }
    if (status === 404) {
      // the session is gone either way (or never was)
      this.txSessions.delete(session);
    }
    throw new Error(`Terminology test teardown failed: HTTP ${status}: ${FhirValidator.outcomeText(body, 'no OperationOutcome')}`);
  }

  /**
   * Run a terminology server test
   * Needs the service to have been started with txTests: true (validator 7.0.4 and later).
   *
   * There are two ways to call it. With a session from txTestSetup() (validator 7.0.4 and later):
   * the run - its server, test cases, externals and output folder - was fixed by setup, so a test
   * names only the suite, the test, and optionally modes and label.
   *
   * Or, the older way, with a server and no session: the validator makes a run for that server
   * the first time it sees it, and keeps it until it stops. Everything about that run comes from
   * the first call for the server - its externalFile and folder; the same server with a different
   * folder or externalFile later on gets the first call's, without saying so. Its reports are never
   * written. Use a session instead where the validator has them.
   *
   * @param {Object} params - Test parameters
   * @param {string} [params.session] - The session from txTestSetup()
   * @param {string} [params.server] - Without a session: the address of the terminology server to test
   * @param {string} params.suiteName - The suite name that contains the test to run
   * @param {string} params.testName - The test name to run
   * @param {string} [params.version] - Without a session (and needed then): what FHIR version to use for the test
   * @param {string} [params.externalFile] - Without a session: optional name of a messages file in the test package
   * @param {string} [params.modes] - Optional comma delimited string of modes
   * @param {string} [params.folder] - Without a session: optional name for the folder the run writes its
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

    const { session, server, suiteName, testName, version, externalFile, modes, folder, label } = params || {};

    const queryParams = new URLSearchParams();
    if (session) {
      if (!suiteName || !testName) {
        throw new Error('suiteName and testName are required');
      }
      const fixed = ['server', 'version', 'externalFile', 'folder'].filter(n => params[n]);
      if (fixed.length > 0) {
        throw new Error(`${fixed.join(', ')} can't be given with a session: txTestSetup() fixes them for the run (and the FHIR version is the server's)`);
      }
      queryParams.set('session', session);
    } else {
      if (!server || !suiteName || !testName || !version) {
        throw new Error('server, suiteName, testName, and version are required');
      }
      queryParams.set('server', server);
      queryParams.set('version', version);
      if (externalFile) {
        // 'externals' is what the validator reads; this was sent as 'externalFile' and so was
        // never picked up - the validator quietly used its default messages file instead
        queryParams.set('externals', externalFile);
      }
      if (folder) {
        queryParams.set('folder', folder);
      }
    }
    queryParams.set('suite', suiteName);
    queryParams.set('test', testName);
    if (modes) {
      queryParams.set('modes', modes);
    }
    if (label) {
      queryParams.set('label', label);
    }

    let response;
    try {
      response = await this.requestJson('GET', '/txTest', queryParams, null, 60000);
    } catch (error) {
      return { result: false, message: `Request failed: ${error.message}` };
    }
    return FhirValidator.txTestResult(response);
  }

  /**
   * What a /txTest response says about the test: no error (or fatal) issue is a pass, and
   * anything else is a failure, with the message the validator gave for it. The message is the
   * validator's OperationOutcome text, never the raw response.
   * @param {{status: number, body: Object|null, text: string}} response - from requestJson()
   * @returns {{result: boolean, message?: string}}
   */
  static txTestResult({ status, body, text }) {
    if (status >= 400) {
      return { result: false, message: `HTTP error ${status}: ${FhirValidator.outcomeText(body, `a response that is not an OperationOutcome (${text.length} bytes)`)}` };
    }
    if (body === null) {
      return { result: false, message: `Failed to parse response: it is not JSON (${text.length} bytes)` };
    }
    if (body.resourceType !== 'OperationOutcome') {
      return { result: false, message: `Unexpected response type: ${body.resourceType || 'unknown'}` };
    }
    const issues = Array.isArray(body.issue) ? body.issue : [];
    const errorIssue = issues.find(issue => issue && (issue.severity === 'error' || issue.severity === 'fatal'));
    if (errorIssue) {
      return { result: false, message: errorIssue.details?.text || errorIssue.diagnostics || 'Test failed with error' };
    }
    return { result: true };
  }

  /**
   * Stop the validator service
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.process) {
      return;
    }
    if (this.txSessions.size > 0) {
      this.log('warn', `Stopping the validator with ${this.txSessions.size} terminology test session(s) not torn down: their reports were never written`);
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
    this.nonce = null;
    this.autoLoadPackages = false;
    this.txSessions.clear();
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
// for the tests
module.exports.cleanLogLine = cleanLogLine;
module.exports.hideCredentials = hideCredentials;