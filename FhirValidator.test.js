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
      // This one needs a JAR, and does not download one. The integration block below does, but
      // that runs after this, so on a clean checkout there is nothing here to start yet.
      if (!fs.existsSync(jarPath)) {
        console.log(`Skipping: no validator JAR at ${jarPath}. Set FHIR_VALIDATOR_JAR_PATH, or run again once the integration tests have downloaded one.`);
        return;
      }
      await validator.start({
        version: '5.0.0',
        txServer: 'http://tx.fhir.org/r5',
        txLog: './txlog.txt',
        autoDownload: false
      });
      expect(validator.jarVersion()).toBeDefined();
      // Stop it here rather than leaving it to afterAll: the tests below reach into this same
      // instance, and a real process on the far end of it is not what they are expecting.
      await validator.stop();
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
      // On its own instance, and never on the shared one: assigning a fake process over a real
      // one throws away the only handle to the child, so nothing stops it, the java process
      // outlives the run, and jest never exits - dropping the reference does not close it.
      const busyValidator = new FhirValidator('./test.jar');
      busyValidator.process = { mock: true };

      await expect(busyValidator.start({
        version: '5.0.0',
        txServer: 'http://tx.fhir.org/r5',
        txLog: './txlog.txt',
        autoDownload: false
      })).rejects.toThrow('Validator service is already running');
    });

    test('should handle stop when not running', async () => {
      // Should not throw
      await expect(validator.stop()).resolves.not.toThrow();
    });

    test('should capture output when validator fails to start', async () => {
      if (!fs.existsSync(jarPath)) {
        console.log(`Skipping: no validator JAR at ${jarPath}.`);
        return;
      }
      const failValidator = new FhirValidator(jarPath);

      await expect(failValidator.start({
        version: '5.0.0',
        txServer: 'http://not.exists',
        txLog: './txlog-fail.txt',
        port: 9199,
        timeout: 60000,
        autoDownload: false,
        skipUpdateCheck: true
      })).rejects.toThrow(); // will throw on timeout or process exit

      // Not lastStderr: the validator logs through logback, which writes to stdout, so it is
      // stdout that carries the reason it could not start - stderr stays empty.
      expect(failValidator.lastOutput.length).toBeGreaterThan(0);
    }, 120000);
  });
});

describe('FhirValidator request building (no validator needed)', () => {
  const http = require('http');
  let server;
  let seen;
  let validator;

  beforeAll(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, body, contentType: req.headers['content-type'] });
        res.setHeader('Content-Type', 'application/fhir+json');
        const q = new URLSearchParams(req.url.substring(req.url.indexOf('?') + 1));
        if (req.url.startsWith('/validateResource?bad')) {
          res.statusCode = 500;
          res.end('<html>oops</html>');
        } else if (req.url.startsWith('/canonical')) {
          const url = q.get('url');
          if (url === 'http://example.org/sd') {
            res.end(JSON.stringify({ resourceType: 'StructureDefinition', url, version: q.get('version') || '1.0.0' }));
          } else if (url === 'relative') {
            res.statusCode = 400;
            res.end(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', details: { text: 'The url must be an absolute canonical URL: relative' } }] }));
          } else if (url === 'http://example.org/old-validator') {
            // a validator without the endpoint: the JDK server's own 404
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/html');
            res.end('<h1>404 Not Found</h1>No context found for request');
          } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] }));
          }
        } else if (req.url.startsWith('/fhirpath/check')) {
          if (q.get('type') === 'TooLong') {
            res.statusCode = 400;
            res.end(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', details: { text: 'The type is longer than 1024 characters' } }] }));
          } else {
            res.end(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'information', code: 'informational', details: { text: `checked ${q.get('type')}: ${q.get('expression')}` } }] }));
          }
        } else {
          res.end(JSON.stringify({ resourceType: 'OperationOutcome', issue: [] }));
        }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    validator = new FhirValidator(getJarPath());
    // as start() would leave it, without a validator
    validator.baseUrl = `http://127.0.0.1:${server.address().port}`;
    validator.isReady = true;
  });

  afterAll(() => new Promise(resolve => server.close(resolve)));

  test('sends the parameters the validator service accepts, one profile at a time', async () => {
    const r = await validator.validate({ resourceType: 'Patient' }, {
      profiles: ['http://a/p1', 'http://b/p2'],
      resourceIdRule: 'OPTIONAL',
      bpWarnings: 'Warning',
      displayOption: 'Check',
      checkIpsCodes: true,
      anyExtensionsAllowed: true,
      params: { noInvariants: true, bundleValidationRule: ['a', 'b'] }
    });
    expect(r.resourceType).toBe('OperationOutcome');
    const last = seen[seen.length - 1];
    expect(last.method).toBe('POST');
    expect(last.contentType).toBe('application/fhir+json');
    expect(last.body).toBe('{"resourceType":"Patient"}');
    const q = new URLSearchParams(last.url.substring(last.url.indexOf('?') + 1));
    expect(q.getAll('profile')).toEqual(['http://a/p1', 'http://b/p2']);
    expect(q.get('resourceIdRule')).toBe('OPTIONAL');
    expect(q.get('bestPractice')).toBe('Warning');
    expect(q.get('checkDisplay')).toBe('Check');
    expect(q.get('checkIpsCodes')).toBe('true');
    expect(q.getAll('extension')).toEqual(['any']);
    expect(q.get('noInvariants')).toBe('true');
    expect(q.getAll('bundleValidationRule')).toEqual(['a', 'b']);
    // the names the service does not know are never sent
    expect(q.has('profiles')).toBe(false);
    expect(q.has('bpWarnings')).toBe(false);
    expect(q.has('displayOption')).toBe(false);
    expect(q.has('anyExtensionsAllowed')).toBe(false);
  });

  test('sends XML as XML', async () => {
    await validator.validate('<Patient xmlns="http://hl7.org/fhir"/>');
    expect(seen[seen.length - 1].contentType).toBe('application/fhir+xml');
  });

  test('reports a response that is not JSON without echoing it', async () => {
    await expect(validator.validate('{}', { params: { bad: 1 } })).rejects.toThrow(/HTTP 500 .*not JSON/);
    await expect(validator.validate('{}', { params: { bad: 1 } })).rejects.not.toThrow(/oops/);
  });

  test('loadIG posts {ig: id#version}, and checks the package id and version', async () => {
    await expect(validator.loadIG('hl7.fhir.us.core', '6.0.0')).resolves.toMatchObject({ resourceType: 'OperationOutcome' });
    const last = seen[seen.length - 1];
    expect(last.method).toBe('POST');
    expect(last.url).toBe('/loadIG');
    expect(last.contentType).toBe('application/json');
    expect(JSON.parse(last.body)).toEqual({ ig: 'hl7.fhir.us.core#6.0.0' });
    await validator.loadIG('hl7.fhir.au.ps', 'current');
    expect(JSON.parse(seen[seen.length - 1].body)).toEqual({ ig: 'hl7.fhir.au.ps#current' });
    await expect(validator.loadIG('../x', '1')).rejects.toThrow(/packageId is not acceptable/);
    await expect(validator.loadIG('hl7.fhir.us.core', '1 OR 2')).rejects.toThrow(/version is not acceptable/);
  });

  test('checkFhirPath sends the type and expression, and returns the OperationOutcome', async () => {
    const oo = await validator.checkFhirPath('Patient', "Patient.name.where(use = 'official') & '+%'");
    expect(oo.issue[0].details.text).toBe("checked Patient: Patient.name.where(use = 'official') & '+%'");
    const last = seen[seen.length - 1];
    expect(last.method).toBe('GET');
    expect(last.url.startsWith('/fhirpath/check?')).toBe(true);
    await expect(validator.checkFhirPath('TooLong', 'x')).rejects.toThrow(/HTTP 400: The type is longer than 1024 characters/);
    await expect(validator.checkFhirPath('', 'x')).rejects.toThrow(/type is required/);
    await expect(validator.checkFhirPath('Patient', ' ')).rejects.toThrow(/expression is required/);
  });

  test('lookupCanonical returns the resource, null when it is not known, and rejects what the validator refuses', async () => {
    await expect(validator.lookupCanonical('http://example.org/sd')).resolves.toMatchObject({ resourceType: 'StructureDefinition', version: '1.0.0' });
    await expect(validator.lookupCanonical('http://example.org/sd', '2.0.0')).resolves.toMatchObject({ version: '2.0.0' });
    expect(seen[seen.length - 1].url).toBe('/canonical?url=http%3A%2F%2Fexample.org%2Fsd&version=2.0.0');
    await expect(validator.lookupCanonical('http://example.org/unknown')).resolves.toBeNull();
    await expect(validator.lookupCanonical('relative')).rejects.toThrow(/HTTP 400: The url must be an absolute canonical URL/);
    await expect(validator.lookupCanonical('http://example.org/old-validator')).rejects.toThrow(/does not have \/canonical/);
    await expect(validator.lookupCanonical('')).rejects.toThrow(/url is required/);
  });

  test('checkFhirPath and lookupCanonical need the service', async () => {
    const idle = new FhirValidator(getJarPath());
    await expect(idle.checkFhirPath('Patient', 'name')).rejects.toThrow(/not ready/);
    await expect(idle.lookupCanonical('http://example.org/sd')).rejects.toThrow(/not ready/);
  });
});

describe('FhirValidator start() argument checks', () => {
  const base = { version: '4.0.1', txServer: 'http://tx.fhir.org/r4', txLog: './tx.log', autoDownload: false };
  const jar = path.join(__dirname, 'fhir-validator.js'); // any existing file: the checks run before java does

  test.each([
    [{ version: '-allowNetworkAccess' }, /version is not acceptable/],
    [{ txServer: 'tx.fhir.org' }, /txServer is not acceptable/],
    [{ txLog: '-x' }, /txLog is not acceptable/],
    [{ port: 'abc' }, /port must be an integer/],
    [{ port: 70000 }, /port must be an integer/],
    [{ igs: 'hl7.fhir.uv.ips#1.1.0' }, /igs must be an array/],
    [{ igs: ['hl7.fhir.uv.ips#1.1.0', '-ig'] }, /igs is not acceptable/],
    [{ extraArgs: [1] }, /extraArgs must be strings/],
    [{ txTests: 'yes' }, /txTests must be true or false/],
    [{ autoLoadPackages: 'yes' }, /autoLoadPackages must be true or false/],
    [{ verifyJar: 'yes' }, /verifyJar must be true or false/],
    [{ nonce: 1 }, /nonce must be true or false/],
    [{ logCommandLine: 'full' }, /logCommandLine must be true or false/],
    [{ extraArgs: '-allowNetworkAccess' }, /extraArgs must be an array of strings/]
  ])('refuses %j', async (bad, message) => {
    const v = new FhirValidator(jar);
    await expect(v.start({ ...base, ...bad })).rejects.toThrow(message);
    expect(v.process).toBeNull();
  });
});

describe('FhirValidator txTests option', () => {
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const v = new FhirValidator('./test.jar', quiet);

  test.each([
    [false, '7.0.4', []],
    [false, null, []],
    [true, '7.0.5', ['-txTests']],
    [true, '7.1.0', ['-txTests']],
    [true, '8.0.0-SNAPSHOT', ['-txTests']],
    // 7.0.4 reads a bare -txTests as the old txTests command; every validator with the option takes =true
    [true, '7.0.4', ['-txTests=true']],
    [true, null, ['-txTests=true']],
    [true, 'unknown', ['-txTests=true']],
    // before 7.0.4 the endpoints are always on, and the option would stop the validator starting
    [true, '7.0.3', []],
    [true, '6.10.4', []]
  ])('txTests %s with validator %s', (txTests, version, expected) => {
    expect(v.txTestsArgs(txTests, version)).toEqual(expected);
  });
});

describe('FhirValidator autoLoadPackages option', () => {
  const warnings = [];
  const v = new FhirValidator('./test.jar', { info() {}, warn(m) { warnings.push(m); }, error() {}, debug() {} });

  test.each([
    [false, '7.0.5', []],
    [false, null, []],
    [true, '7.0.5', ['-autoLoadPackages']],
    [true, '7.1.0', ['-autoLoadPackages']],
    [true, '7.0.6-SNAPSHOT', ['-autoLoadPackages']],
    [true, null, ['-autoLoadPackages']],
    // before 7.0.5 the validator doesn't know -autoLoadPackages, and would not start
    [true, '7.0.4', []],
    [true, '6.10.4', []]
  ])('autoLoadPackages %s with validator %s', (wanted, version, expected) => {
    expect(v.autoLoadPackagesArgs(wanted, version)).toEqual(expected);
    expect(v.autoLoadPackages).toBe(expected.length > 0);
  });

  test('a validator that predates the option is warned about', () => {
    warnings.length = 0;
    v.autoLoadPackagesArgs(true, '7.0.4');
    expect(warnings.join('\n')).toMatch(/predates -autoLoadPackages/);
  });
});

describe('FhirValidator log and command line hygiene', () => {
  test('cleanLogLine takes out escape sequences and control characters', () => {
    expect(FhirValidator.cleanLogLine('\u001b[31mred\u001b[0m')).toBe('red');
    expect(FhirValidator.cleanLogLine('a\u001b]0;window title\u0007b')).toBe('ab');
    expect(FhirValidator.cleanLogLine('a\u001b]8;;http://x\u001b\\b')).toBe('ab');
    expect(FhirValidator.cleanLogLine('a\u001b[2Kb\u001b[1;1Hc')).toBe('abc');
    expect(FhirValidator.cleanLogLine('a\u0007\u0000\u009bb‮c\r')).toBe('abc');
    expect(FhirValidator.cleanLogLine('  tab\tkept  ')).toBe('tab\tkept');
  });

  test('hideCredentials hides user:password@ in URLs', () => {
    expect(FhirValidator.hideCredentials('https://me:secret@tx.example.org/r4')).toBe('https://***@tx.example.org/r4');
    expect(FhirValidator.hideCredentials('http://tx.fhir.org/r4')).toBe('http://tx.fhir.org/r4');
  });

  test('the logged command line hides the nonce, and by default credentials and the extra arguments', () => {
    const v = new FhirValidator('./test.jar');
    const args = ['-jar', 'x.jar', 'server', '8080', '-tx', 'https://me:secret@tx.example.org/r4', '-nonce', 'abc123', '-proxy', 'u:p@proxy:3128'];
    const trimmed = v.describeCommand(args, 2, false);
    expect(trimmed).toBe('java -jar x.jar server 8080 -tx https://***@tx.example.org/r4 -nonce *** (and 2 more arguments: start with logCommandLine: true to see them)');
    const full = v.describeCommand(args, 2, true);
    expect(full).toBe('java -jar x.jar server 8080 -tx https://me:secret@tx.example.org/r4 -nonce *** -proxy u:p@proxy:3128');
  });
});

describe('FhirValidator nonce option', () => {
  const v = new FhirValidator('./test.jar');

  test.each([
    [true, '7.0.5', true],
    [true, '7.1.0', true],
    [true, '7.0.5-SNAPSHOT', true],
    [true, null, true],
    // before 7.0.5 the validator doesn't know -nonce, and would not start
    [true, '7.0.4', false],
    [true, '6.10.4', false],
    [false, '7.0.5', false]
  ])('nonce %s with validator %s', (wanted, version, given) => {
    const args = v.nonceArgs(wanted, version);
    if (given) {
      expect(args[0]).toBe('-nonce');
      expect(args[1]).toMatch(/^[0-9a-f]{32}$/);
      expect(v.nonce).toBe(args[1]);
    } else {
      expect(args).toEqual([]);
      expect(v.nonce).toBeNull();
    }
  });

  test('each start gets a new nonce', () => {
    expect(v.nonceArgs(true, null)[1]).not.toBe(v.nonceArgs(true, null)[1]);
  });
});

describe('FhirValidator service checks (no validator needed)', () => {
  const http = require('http');
  let server;
  let seen;
  let nonceToSend;
  let validator;

  const oo = (severity, text) => ({ resourceType: 'OperationOutcome', issue: severity ? [{ severity, code: 'processing', details: { text } }] : [] });

  beforeAll(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const q = new URLSearchParams(req.url.substring(req.url.indexOf('?') + 1));
        seen.push({ url: req.url, method: req.method, body, q });
        if (nonceToSend) {
          res.setHeader('X-Validator-Nonce', nonceToSend);
        }
        res.setHeader('Content-Type', 'application/fhir+json');
        const send = (status, json) => { res.statusCode = status; res.end(JSON.stringify(json)); };
        if (req.url.startsWith('/validateResource') && req.method === 'GET') {
          res.statusCode = 405;
          res.end();
        } else if (req.url.startsWith('/validateResource')) {
          send(200, oo());
        } else if (req.url.startsWith('/txTest/setup')) {
          const b = JSON.parse(body);
          if (b.server === 'https://refused.example.org') {
            send(403, oo('error', 'The tx test server is not configured in fhir-settings'));
          } else {
            send(200, { session: 's1', server: b.server, 'test-version': b['test-version'] || 'current', output: '/tmp/x' });
          }
        } else if (req.url.startsWith('/txTest/teardown')) {
          if (q.get('session') === 's1') {
            send(200, { session: 's1', output: '/tmp/x', 'test-results': {}, report: { resourceType: 'TestReport' } });
          } else {
            send(404, oo('error', `Unknown session '${q.get('session')}'`));
          }
        } else if (req.url.startsWith('/txTest')) {
          if (q.get('test') === 'fails') {
            send(200, oo('error', 'the expansion is different'));
          } else if (q.get('test') === 'huge') {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/html');
            res.end('<html>' + 'x'.repeat(100000) + '</html>');
          } else {
            send(200, oo());
          }
        } else {
          send(404, oo('error', 'unknown'));
        }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  });

  beforeEach(() => {
    nonceToSend = null;
    // a jar with no version file beside it, so that only what a test sets is the validator's version
    validator = new FhirValidator(path.join(require('os').tmpdir(), 'fhir-validator-wrapper-none', 'v.jar'));
    validator.baseUrl = `http://127.0.0.1:${server.address().port}`;
    validator.port = server.address().port;
    validator.isReady = true;
  });

  afterAll(() => new Promise(resolve => server.close(resolve)));

  test('healthCheck only accepts an answer that carries the nonce', async () => {
    validator.nonce = 'abc';
    await expect(validator.healthCheck()).rejects.toMatchObject({ foreign: true });
    nonceToSend = 'other';
    await expect(validator.healthCheck()).rejects.toMatchObject({ foreign: true });
    nonceToSend = 'abc';
    await expect(validator.healthCheck()).resolves.toBeUndefined();
    // a validator started without one (it predates -nonce): any 405 will do
    validator.nonce = null;
    nonceToSend = null;
    await expect(validator.healthCheck()).resolves.toBeUndefined();
  });

  test('validate tells validators that have it to stop validating before the request times out', async () => {
    validator.version = '7.0.4';
    await validator.validate({ resourceType: 'Patient' }, { timeout: 10000 });
    expect(seen[seen.length - 1].q.get('validationTimeout')).toBe('9000');
    await validator.validate({ resourceType: 'Patient' });
    expect(seen[seen.length - 1].q.get('validationTimeout')).toBe('27000');
    await validator.validate({ resourceType: 'Patient' }, { params: { validationTimeout: 5 } });
    expect(seen[seen.length - 1].q.getAll('validationTimeout')).toEqual(['5']);
    // too old for it, or not known: not sent (an older validator refuses parameters it doesn't know)
    validator.version = '6.8.0';
    await validator.validate({ resourceType: 'Patient' });
    expect(seen[seen.length - 1].q.has('validationTimeout')).toBe(false);
    validator.version = undefined;
    await validator.validate({ resourceType: 'Patient' });
    expect(seen[seen.length - 1].q.has('validationTimeout')).toBe(false);
  });

  test('a terminology test session: setup, tests, teardown', async () => {
    validator.version = '7.0.4';
    const run = await validator.txTestSetup({ server: 'https://tx.example.org/r4', testVersion: '1.9.6', folder: 'mine', externals: { a: 1 } });
    expect(run.session).toBe('s1');
    const setup = seen[seen.length - 1];
    expect(setup.method).toBe('POST');
    expect(JSON.parse(setup.body)).toEqual({ server: 'https://tx.example.org/r4', 'test-version': '1.9.6', folder: 'mine', externals: { a: 1 } });
    expect(validator.txSessions.has('s1')).toBe(true);

    await expect(validator.runTxTest({ session: 's1', suiteName: 'simple', testName: 'passes', modes: 'general', label: 'r4' })).resolves.toEqual({ result: true });
    const q = seen[seen.length - 1].q;
    expect(q.get('session')).toBe('s1');
    expect(q.get('suite')).toBe('simple');
    expect(q.get('label')).toBe('r4');
    expect(q.has('server')).toBe(false);
    expect(q.has('version')).toBe(false);

    await expect(validator.runTxTest({ session: 's1', suiteName: 'simple', testName: 'fails' })).resolves.toEqual({ result: false, message: 'the expansion is different' });
    await expect(validator.runTxTest({ session: 's1', suiteName: 'simple', testName: 'x', folder: 'other' })).rejects.toThrow(/folder can't be given with a session/);
    await expect(validator.runTxTest({ session: 's1', testName: 'x' })).rejects.toThrow(/suiteName and testName are required/);

    const reports = await validator.txTestTeardown('s1');
    expect(reports.report.resourceType).toBe('TestReport');
    expect(seen[seen.length - 1].url).toBe('/txTest/teardown?session=s1');
    expect(validator.txSessions.size).toBe(0);
    await expect(validator.txTestTeardown('s2')).rejects.toThrow(/HTTP 404: Unknown session 's2'/);
  });

  test('setup reports what the validator refused, and needs a validator that has sessions', async () => {
    validator.version = '7.0.4';
    await expect(validator.txTestSetup({ server: 'https://refused.example.org' })).rejects.toThrow(/HTTP 403: The tx test server is not configured/);
    await expect(validator.txTestSetup({})).rejects.toThrow(/server is required/);
    validator.version = '7.0.3';
    await expect(validator.txTestSetup({ server: 'https://tx.example.org/r4' })).rejects.toThrow(/need validator 7.0.4 or later/);
  });

  test('the older form of runTxTest still sends the server, version and folder', async () => {
    await expect(validator.runTxTest({ server: 'https://tx.example.org/r4', suiteName: 'simple', testName: 'passes', version: '4.0', folder: 'mine', externalFile: 'messages-x' })).resolves.toEqual({ result: true });
    const q = seen[seen.length - 1].q;
    expect(q.get('server')).toBe('https://tx.example.org/r4');
    expect(q.get('version')).toBe('4.0');
    expect(q.get('folder')).toBe('mine');
    expect(q.get('externals')).toBe('messages-x');
  });

  test('a failed test reports the status, not the response body', async () => {
    const r = await validator.runTxTest({ session: 's1', suiteName: 'simple', testName: 'huge' });
    expect(r.result).toBe(false);
    expect(r.message).toMatch(/^HTTP error 500: a response that is not an OperationOutcome \(\d+ bytes\)$/);
  });
});

describe('FhirValidator download checks', () => {
  const os = require('os');
  const crypto = require('crypto');
  const { Readable } = require('stream');
  let dir;
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const content = Buffer.from('not really a jar, but bytes all the same');
  const sha = crypto.createHash('sha256').update(content).digest('hex');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhir-validator-wrapper-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const leftovers = () => fs.readdirSync(dir);

  test('a complete download is put in place', async () => {
    const v = new FhirValidator(path.join(dir, 'v.jar'), quiet);
    const dest = path.join(dir, 'v.jar');
    const r = await v.saveDownload(Readable.from([content.subarray(0, 10), content.subarray(10)]), dest, { contentLength: content.length, size: content.length, sha256: sha });
    expect(r).toEqual({ bytes: content.length, sha256: sha });
    expect(fs.readFileSync(dest)).toEqual(content);
    expect(leftovers()).toEqual(['v.jar']);
  });

  test.each([
    ['cut short', { contentLength: content.length + 5 }, /cut short/],
    ['the wrong size', { size: content.length - 1 }, /the release says the jar is/],
    ['the wrong bytes', { sha256: '0'.repeat(64) }, /is not the one the release gives/]
  ])('a download that is %s is not used, and leaves nothing behind', async (what, expect_, message) => {
    const dest = path.join(dir, 'v.jar');
    fs.writeFileSync(dest, 'the old jar');
    const v = new FhirValidator(dest, quiet);
    await expect(v.saveDownload(Readable.from([content]), dest, expect_)).rejects.toThrow(message);
    expect(fs.readFileSync(dest, 'utf8')).toBe('the old jar');
    expect(leftovers()).toEqual(['v.jar']);
  });

  test('a download whose connection drops part way fails, rather than waiting forever', async () => {
    const dest = path.join(dir, 'v.jar');
    const v = new FhirValidator(dest, quiet);
    const dropping = new Readable({
      read() {
        this.push(content);
        this.destroy(new Error('socket hang up'));
      }
    });
    await expect(v.saveDownload(dropping, dest, {})).rejects.toThrow(/Download failed: socket hang up/);
    expect(leftovers()).toEqual([]);
  });

  test('verifying a jar on disk needs a digest, and compares it', async () => {
    const dest = path.join(dir, 'v.jar');
    fs.writeFileSync(dest, content);
    const v = new FhirValidator(dest, quiet);
    await expect(v.jarMatches('sha256:' + sha, 'test')).resolves.toBe(true);
    await expect(v.jarMatches('sha256:' + '1'.repeat(64), 'test')).resolves.toBe(false);
    await expect(v.jarMatches(null, 'none given')).rejects.toThrow(/no sha256 digest for it \(none given\)/);
  });

  test('ensureValidator with verify and skipUpdateCheck checks the jar against the digest it recorded', async () => {
    const dest = path.join(dir, 'v.jar');
    fs.writeFileSync(dest, content);
    const v = new FhirValidator(dest, quiet);
    v.saveVersionInfo('7.0.4', 'https://github.com/x', 'sha256:' + sha);
    await expect(v.ensureValidator({ skipUpdateCheck: true, verify: true })).resolves.toMatchObject({ version: '7.0.4', downloaded: false });
    fs.writeFileSync(dest, 'changed');
    await expect(v.ensureValidator({ skipUpdateCheck: true, verify: true })).rejects.toThrow(/does not match the digest recorded/);
    // not asked to verify: used as it is
    await expect(v.ensureValidator({ skipUpdateCheck: true })).resolves.toMatchObject({ downloaded: false });
  });
});

describe('FhirValidator ensureValidator verify (release stubbed)', () => {
  const os = require('os');
  const crypto = require('crypto');
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const content = Buffer.from('the released jar');
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  const release = (over = {}) => ({
    version: '7.0.4',
    downloadUrl: 'https://github.com/hapifhir/org.hl7.fhir.core/releases/download/7.0.4/validator_cli.jar',
    size: content.length,
    digest: 'sha256:' + sha,
    ...over
  });
  let dir;
  let jar;
  let v;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhir-validator-wrapper-'));
    jar = path.join(dir, 'validator_cli.jar');
    v = new FhirValidator(jar, quiet);
    v.getLatestRelease = jest.fn(async () => release());
    // stands in for the download: writes the released jar, as a good download would
    v.downloadFile = jest.fn(async (url, dest) => fs.writeFileSync(dest, content));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('refuses to go ahead when the release gives no digest', async () => {
    v.getLatestRelease = jest.fn(async () => release({ digest: null }));
    await expect(v.ensureValidator({ verify: true })).rejects.toThrow(/GitHub gives no sha256 digest for validator_cli.jar in release 7.0.4/);
    expect(v.downloadFile).not.toHaveBeenCalled();
    expect(fs.existsSync(jar)).toBe(false);
  });

  test('without verify, a release with no digest is downloaded as before', async () => {
    v.getLatestRelease = jest.fn(async () => release({ digest: null }));
    await expect(v.ensureValidator()).resolves.toMatchObject({ downloaded: true });
    expect(v.downloadFile.mock.calls[0][2]).toEqual({ size: content.length, sha256: undefined });
  });

  test('a download is checked against the release digest, which is recorded', async () => {
    await expect(v.ensureValidator({ verify: true })).resolves.toMatchObject({ version: '7.0.4', downloaded: true });
    expect(v.downloadFile.mock.calls[0][2]).toEqual({ size: content.length, sha256: sha });
    expect(v.getVersionInfo()).toMatchObject({ version: '7.0.4', digest: 'sha256:' + sha });
  });

  test('without verify, the download is only checked for size, but the digest is still recorded', async () => {
    await expect(v.ensureValidator()).resolves.toMatchObject({ downloaded: true });
    expect(v.downloadFile.mock.calls[0][2]).toEqual({ size: content.length, sha256: undefined });
    expect(v.getVersionInfo().digest).toBe('sha256:' + sha);
  });

  test('an up to date jar that matches the release is used as it is', async () => {
    fs.writeFileSync(jar, content);
    v.saveVersionInfo('7.0.4', 'https://github.com/x', 'sha256:' + sha);
    await expect(v.ensureValidator({ verify: true })).resolves.toEqual({ version: '7.0.4', updated: false, downloaded: false });
    expect(v.downloadFile).not.toHaveBeenCalled();
  });

  test('an up to date jar that does not match the release is downloaded again', async () => {
    fs.writeFileSync(jar, 'changed on disk');
    v.saveVersionInfo('7.0.4', 'https://github.com/x', 'sha256:' + sha);
    await expect(v.ensureValidator({ verify: true })).resolves.toMatchObject({ version: '7.0.4', downloaded: true, updated: false });
    expect(v.downloadFile).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(jar)).toEqual(content);
  });

  test('without verify, an up to date jar is not checked', async () => {
    fs.writeFileSync(jar, 'changed on disk');
    v.saveVersionInfo('7.0.4', 'https://github.com/x', 'sha256:' + sha);
    await expect(v.ensureValidator()).resolves.toMatchObject({ downloaded: false });
    expect(v.downloadFile).not.toHaveBeenCalled();
  });

  test('when GitHub cannot be reached, the jar is checked against the recorded digest', async () => {
    v.getLatestRelease = jest.fn(async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); });
    fs.writeFileSync(jar, content);
    v.saveVersionInfo('7.0.4', 'https://github.com/x', 'sha256:' + sha);
    await expect(v.ensureValidator({ verify: true })).resolves.toMatchObject({ version: '7.0.4', downloaded: false });
    fs.writeFileSync(jar, 'changed on disk');
    await expect(v.ensureValidator({ verify: true })).rejects.toThrow(/does not match the digest recorded/);
    // and when nothing was recorded, there is nothing to verify against
    v.saveVersionInfo('7.0.4', 'https://github.com/x');
    await expect(v.ensureValidator({ verify: true })).rejects.toThrow(/none was recorded when it was downloaded/);
  });
});

// These download the real jar (~200MB) from GitHub, once
describe('FhirValidator ensureValidator verify (the real release)', () => {
  const os = require('os');
  const crypto = require('crypto');
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  let dir;
  let jar;
  let latest;

  const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhir-validator-wrapper-net-'));
    jar = path.join(dir, 'validator_cli.jar');
    latest = await new FhirValidator(jar, quiet).getLatestRelease();
  }, 60000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('GitHub gives a size and a sha256 digest for the jar', () => {
    expect(latest.size).toBeGreaterThan(100 * 1024 * 1024);
    expect(latest.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('a verified download is the released jar', async () => {
    const v = new FhirValidator(jar, quiet);
    await expect(v.ensureValidator({ verify: true })).resolves.toMatchObject({ version: latest.version, downloaded: true });
    expect(fs.statSync(jar).size).toBe(latest.size);
    expect('sha256:' + sha256Of(jar)).toBe(latest.digest);
    expect(v.getVersionInfo().digest).toBe(latest.digest);
    // nothing left over from the download
    expect(fs.readdirSync(dir).sort()).toEqual(['validator_cli.jar', 'validator_cli.jar.version']);
  }, 600000);

  test('the jar is then verified against the release without downloading it again', async () => {
    const v = new FhirValidator(jar, quiet);
    const mtime = fs.statSync(jar).mtimeMs;
    await expect(v.ensureValidator({ verify: true })).resolves.toEqual({ version: latest.version, updated: false, downloaded: false });
    expect(fs.statSync(jar).mtimeMs).toBe(mtime);
  }, 60000);

  test('a jar changed on disk is refused when the update check is skipped', async () => {
    fs.appendFileSync(jar, 'x');
    const v = new FhirValidator(jar, quiet);
    await expect(v.ensureValidator({ skipUpdateCheck: true, verify: true })).rejects.toThrow(/does not match the digest recorded/);
  }, 60000);
});

describe('FhirValidator download safety', () => {
  test('refuses to download over http or from other hosts', async () => {
    const v = new FhirValidator('./nowhere/validator_cli.jar');
    await expect(v.downloadFile('http://github.com/x/validator_cli.jar', './nowhere/x.jar')).rejects.toThrow(/over http/);
    await expect(v.downloadFile('https://example.org/validator_cli.jar', './nowhere/x.jar')).rejects.toThrow(/not a GitHub host/);
    expect(fs.existsSync('./nowhere')).toBe(false);
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
      skipUpdateCheck: true,  // Don't check for updates every test run
      txTests: true           // the runTxTest tests below need the terminology test endpoints
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

    // https, and the versioned endpoint: the validator refuses non-https URLs unless SSRF
    // protection is turned off, and the bare host has no /metadata to report a version from
    const result = await validator.runTxTest({
      server: 'https://tx-dev.fhir.org/r5',
      suiteName: 'metadata',
      testName: 'metadata',
      version: '5.0'
    });

    if (!result.result) {
      console.error(`tx test failed: ${result.message}`);
    }
    expect(result).toHaveProperty('result', true);
    expect(result.message).toBeUndefined();
  }, 60000);

  test('should return failure for invalid tx test server', async () => {
    if (skipIntegration) return;

    // Slower than it looks, so it needs its own timeout: the host does not resolve, and the
    // validator's HTTP client retries a failed request once with a 2 second pause either side
    // of it - for the $versions probe and then again for /metadata - before it gives up and
    // reports that it cannot determine the server's FHIR version.
    const result = await validator.runTxTest({
      server: 'https://tx-dev.fhir.orgX/r5',
      suiteName: 'metadata',
      testName: 'metadata',
      version: '5.0'
    });

    expect(result).toHaveProperty('result', false);
    expect(result.message).toBeDefined();
  }, 60000);

  test('should return failure for invalid tx test suite', async () => {
    if (skipIntegration) return;

    const result = await validator.runTxTest({
      server: 'https://tx-dev.fhir.org/r5',
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
      server: 'https://tx-dev.fhir.org/r5',
      suiteName: 'metadata',
      testName: 'metadataX',
      version: '5.0'
    });

    expect(result).toHaveProperty('result', false);
    expect(result.message).toBeDefined();
  });
});