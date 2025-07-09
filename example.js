const FhirValidator = require('./fhir-validator');

async function main() {
  // Get JAR path from environment variable or use default
  const jarPath = process.env.FHIR_VALIDATOR_JAR_PATH || './validator_cli.jar';
  console.log(`Using validator JAR: ${jarPath}`);
  
  // Initialize the validator with path to validator.jar
  const validator = new FhirValidator(jarPath);

  try {
    // Start the validator service
    await validator.start({
      version: '5.0.0',
      txServer: 'http://tx.fhir.org/r5',
      txLog: './txlog.txt',
      igs: [
        'hl7.fhir.us.core#6.0.0',
        'hl7.fhir.uv.sdc#3.0.0'
      ],
      port: 8080,
      timeout: 60000 // Wait up to 60 seconds for startup
    });

    console.log('Validator service started successfully');

    // Example 1: Validate a JSON resource string
    const patientJson = `{
      "resourceType": "Patient",
      "id": "example",
      "active": true,
      "name": [{
        "use": "official",
        "family": "Doe",
        "given": ["John"]
      }],
      "gender": "male",
      "birthDate": "1974-12-25"
    }`;

    console.log('\\nValidating Patient resource...');
    const result1 = await validator.validate(patientJson);
    console.log('Validation result:', JSON.stringify(result1, null, 2));

    // Example 2: Validate with specific profiles
    console.log('\\nValidating with US Core Patient profile...');
    const result2 = await validator.validate(patientJson, {
      profiles: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient'],
      resourceIdRule: 'OPTIONAL',
      anyExtensionsAllowed: true,
      bpWarnings: 'Warning',
      displayOption: 'Check'
    });
    console.log('Profile validation result:', JSON.stringify(result2, null, 2));

    // Example 3: Validate a resource object
    const observationObject = {
      resourceType: 'Observation',
      id: 'example-obs',
      status: 'final',
      category: [{
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/observation-category',
          code: 'vital-signs'
        }]
      }],
      code: {
        coding: [{
          system: 'http://loinc.org',
          code: '85354-9',
          display: 'Blood pressure panel with all children optional'
        }]
      },
      subject: {
        reference: 'Patient/example'
      },
      effectiveDateTime: '2023-01-01T10:00:00Z',
      valueQuantity: {
        value: 120,
        unit: 'mmHg',
        system: 'http://unitsofmeasure.org',
        code: 'mm[Hg]'
      }
    };

    console.log('\\nValidating Observation object...');
    const result3 = await validator.validateObject(observationObject);
    console.log('Object validation result:', JSON.stringify(result3, null, 2));

    // Example 4: Validate bytes (useful for file uploads)
    const xmlResource = `<?xml version="1.0" encoding="UTF-8"?>
    <Patient xmlns="http://hl7.org/fhir">
      <id value="xml-example"/>
      <active value="true"/>
      <name>
        <use value="official"/>
        <family value="Smith"/>
        <given value="Jane"/>
      </name>
      <gender value="female"/>
      <birthDate value="1980-05-15"/>
    </Patient>`;

    console.log('\\nValidating XML resource from bytes...');
    const xmlBytes = Buffer.from(xmlResource, 'utf8');
    const result4 = await validator.validateBytes(xmlBytes, 'xml');
    console.log('XML validation result:', JSON.stringify(result4, null, 2));

    // Example 5: Load additional IG at runtime
    console.log('\\nLoading additional Implementation Guide...');
    const igResult = await validator.loadIG('hl7.fhir.uv.ips', '1.1.0');
    console.log('IG load result:', JSON.stringify(igResult, null, 2));

    // Example 6: Error handling
    try {
      console.log('\\nTesting error handling with invalid resource...');
      const invalidResource = '{ "resourceType": "InvalidType" }';
      await validator.validate(invalidResource);
    } catch (error) {
      console.log('Expected validation error:', error.message);
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    // Always stop the validator service when done
    console.log('\\nStopping validator service...');
    await validator.stop();
    console.log('Validator service stopped');
  }
}

// Handle process termination gracefully
process.on('SIGINT', async () => {
  console.log('\\nReceived SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\\nReceived SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Run the example
main().catch(console.error);