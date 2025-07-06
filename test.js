const FHIRValidatorService = require('./validator-service');

// Test data
const validPatient = {
  "resourceType": "Patient",
  "id": "test-patient-1",
  "active": true,
  "name": [{
    "use": "official",
    "family": "Doe",
    "given": ["Jane"]
  }],
  "gender": "female",
  "birthDate": "1985-05-15"
};

const invalidPatient = {
  "resourceType": "Patient",
  "id": "test-patient-2",
  "active": "not-a-boolean", // This should cause a validation error
  "name": [{
    "use": "official",
    "family": "Smith"
    // Missing given name
  }],
  "gender": "invalid-gender", // Invalid gender value
  "birthDate": "not-a-date"   // Invalid date format
};

const validBundle = {
  "resourceType": "Bundle",
  "id": "test-bundle",
  "type": "collection",
  "entry": [
    {
      "resource": validPatient
    }
  ]
};

async function runTests() {
  console.log('🧪 Starting FHIR Validator Tests...\n');
  
  const validator = new FHIRValidatorService();
  let testsPassed = 0;
  let testsFailed = 0;

  try {
    // Test 1: Configuration
    console.log('Test 1: Configuring Java environment...');
    await validator.configureJava('./lib/validator_cli.jar', {
      javaOptions: '-Xmx2g' // Use less memory for testing
    });
    console.log('✅ Java configuration successful\n');
    testsPassed++;

    // Test 2: Initialization
    console.log('Test 2: Initializing validator...');
    await validator.initialize('./definitions/definitions.xml.zip');
    console.log('✅ Validator initialization successful\n');
    testsPassed++;

    // Test 3: Terminology server connection
    console.log('Test 3: Connecting to terminology server...');
    await validator.connectToTerminologyServer('http://tx.fhir.org/r4', null);
    console.log('✅ Terminology server connection successful\n');
    testsPassed++;

    // Test 4: Valid resource validation
    console.log('Test 4: Validating valid Patient resource...');
    const validResourceBytes = Buffer.from(JSON.stringify(validPatient));
    const validResult = await validator.validateResource(
      validResourceBytes,
      'JSON',
      'Test Valid Patient'
    );
    
    const validOutcome = JSON.parse(validResult.toString());
    const validErrors = validOutcome.issue?.filter(issue => issue.severity === 'error') || [];
    
    if (validErrors.length === 0) {
      console.log('✅ Valid resource passed validation (as expected)\n');
      testsPassed++;
    } else {
      console.log('❌ Valid resource failed validation unexpectedly');
      console.log('Errors:', validErrors);
      testsFailed++;
    }

    // Test 5: Invalid resource validation
    console.log('Test 5: Validating invalid Patient resource...');
    const invalidResourceBytes = Buffer.from(JSON.stringify(invalidPatient));
    const invalidResult = await validator.validateResource(
      invalidResourceBytes,
      'JSON',
      'Test Invalid Patient'
    );
    
    const invalidOutcome = JSON.parse(invalidResult.toString());
    const invalidErrors = invalidOutcome.issue?.filter(issue => issue.severity === 'error') || [];
    
    if (invalidErrors.length > 0) {
      console.log('✅ Invalid resource failed validation (as expected)');
      console.log(`Found ${invalidErrors.length} validation errors`);
      invalidErrors.forEach((error, index) => {
        console.log(`  ${index + 1}. ${error.details?.text || error.diagnostics}`);
      });
      console.log();
      testsPassed++;
    } else {
      console.log('❌ Invalid resource passed validation unexpectedly\n');
      testsFailed++;
    }

    // Test 6: Bundle validation
    console.log('Test 6: Validating FHIR Bundle...');
    const bundleBytes = Buffer.from(JSON.stringify(validBundle));
    const bundleResult = await validator.validateResource(
      bundleBytes,
      'JSON',
      'Test Bundle',
      {
        idRule: 'id-optional',
        bestPractice: 'bp-warning'
      }
    );
    
    const bundleOutcome = JSON.parse(bundleResult.toString());
    const bundleErrors = bundleOutcome.issue?.filter(issue => issue.severity === 'error') || [];
    const bundleWarnings = bundleOutcome.issue?.filter(issue => issue.severity === 'warning') || [];
    
    console.log(`✅ Bundle validation completed`);
    console.log(`   Errors: ${bundleErrors.length}, Warnings: ${bundleWarnings.length}\n`);
    testsPassed++;

    // Test 7: Status check
    console.log('Test 7: Checking validator status...');
    const status = await validator.getStatus();
    console.log('✅ Status retrieved successfully');
    console.log(`   Validations performed: ${status['validation-count']}`);
    console.log(`   Memory used: ${status['mem-used']} MB`);
    console.log(`   Custom resources: ${status['custom-resource-count']}\n`);
    testsPassed++;

    // Test 8: Add custom resource
    console.log('Test 8: Adding custom resource to context...');
    const customProfile = {
      "resourceType": "StructureDefinition",
      "id": "test-profile",
      "url": "http://example.org/StructureDefinition/test-profile",
      "name": "TestProfile",
      "status": "draft",
      "kind": "resource",
      "abstract": false,
      "type": "Patient",
      "baseDefinition": "http://hl7.org/fhir/StructureDefinition/Patient"
    };
    
    const profileBytes = Buffer.from(JSON.stringify(customProfile));
    await validator.seeResource(profileBytes, 'JSON');
    console.log('✅ Custom resource added successfully\n');
    testsPassed++;

    // Test 9: Validator ready check
    console.log('Test 9: Checking if validator is ready...');
    const isReady = validator.isReady();
    if (isReady) {
      console.log('✅ Validator is ready\n');
      testsPassed++;
    } else {
      console.log('❌ Validator is not ready\n');
      testsFailed++;
    }

  } catch (error) {
    console.error('❌ Test failed with error:', error.message);
    testsFailed++;
  } finally {
    // Test 10: Shutdown
    console.log('Test 10: Shutting down validator...');
    await validator.shutdown();
    console.log('✅ Validator shutdown successful\n');
    testsPassed++;
  }

  // Test Summary
  console.log('📊 Test Summary:');
  console.log(`✅ Tests Passed: ${testsPassed}`);
  console.log(`❌ Tests Failed: ${testsFailed}`);
  console.log(`📈 Success Rate: ${Math.round((testsPassed / (testsPassed + testsFailed)) * 100)}%`);
  
  if (testsFailed === 0) {
    console.log('\n🎉 All tests passed! Your FHIR Validator Service is ready to use.');
  } else {
    console.log('\n⚠️  Some tests failed. Please check the configuration and try again.');
    process.exit(1);
  }
}

// Performance test function
async function performanceTest() {
  console.log('\n🚀 Running Performance Test...\n');
  
  const validator = new FHIRValidatorService();
  
  try {
    await validator.configureJava('./lib/validator_cli.jar');
    await validator.initialize('./definitions/definitions.xml.zip');
    await validator.connectToTerminologyServer('http://tx.fhir.org/r4');
    
    const iterations = 10;
    const startTime = Date.now();
    
    console.log(`Validating ${iterations} resources...`);
    
    for (let i = 0; i < iterations; i++) {
      const testPatient = {
        ...validPatient,
        id: `perf-test-patient-${i}`
      };
      
      const resourceBytes = Buffer.from(JSON.stringify(testPatient));
      await validator.validateResource(resourceBytes, 'JSON', `Performance Test ${i + 1}`);
      
      if ((i + 1) % 5 === 0) {
        console.log(`Completed ${i + 1}/${iterations} validations...`);
      }
    }
    
    const endTime = Date.now();
    const totalTime = endTime - startTime;
    const avgTime = totalTime / iterations;
    
    console.log(`\n📊 Performance Results:`);
    console.log(`Total Time: ${totalTime}ms`);
    console.log(`Average Time per Validation: ${avgTime.toFixed(2)}ms`);
    console.log(`Validations per Second: ${(1000 / avgTime).toFixed(2)}`);
    
    const finalStatus = await validator.getStatus();
    console.log(`Final Memory Usage: ${finalStatus['mem-used']} MB`);
    
  } catch (error) {
    console.error('Performance test failed:', error.message);
  } finally {
    await validator.shutdown();
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--performance')) {
    await performanceTest();
  } else {
    await runTests();
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  runTests,
  performanceTest
};