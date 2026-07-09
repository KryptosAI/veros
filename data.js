const { v4: uuid } = require('uuid');
const { getDb, addResource, addResources, resourceCount } = require('./store');

const MEDICATION_CLASSES = {
  penicillins: {
    terms: ['penicillin', 'amoxicillin', 'ampicillin', 'amoxicillin-clavulanate',
      'piperacillin', 'ticarcillin', 'nafcillin', 'oxacillin', 'dicloxacillin',
      'penicillin g', 'penicillin v', 'pen v', 'pen g', 'pcn', 'augmentin'],
  },
  sulfonamides: {
    terms: ['sulfa', 'sulfamethoxazole', 'sulfadiazine', 'sulfisoxazole',
      'trimethoprim-sulfamethoxazole', 'bactrim', 'septra', 'tmp-smx', 'sulfonamide'],
  },
  nsaids: {
    terms: ['ibuprofen', 'naproxen', 'aspirin', 'celecoxib', 'diclofenac',
      'meloxicam', 'indomethacin', 'ketorolac', 'nsaid', 'motrin', 'advil', 'aleve'],
  },
  opioids: {
    terms: ['codeine', 'morphine', 'oxycodone', 'hydrocodone', 'fentanyl',
      'hydromorphone', 'tramadol', 'methadone', 'opioid', 'opiate', 'percocet', 'vicodin'],
  },
  cephalosporins: {
    terms: ['cephalexin', 'cefazolin', 'ceftriaxone', 'cefuroxime',
      'cefdinir', 'cefpodoxime', 'cephalosporin', 'keflex', 'rocephin'],
  },
};

const ROLES = {
  attending: { label: 'Attending Physician', access: { Patient: 'rw', AllergyIntolerance: 'rw', MedicationRequest: 'rw', MedicationStatement: 'rw', Observation: 'rw', Condition: 'rw', Encounter: 'rw', DocumentReference: 'rw', Procedure: 'rw' } },
  resident: { label: 'Resident Physician', access: { Patient: 'rw', AllergyIntolerance: 'rw', MedicationRequest: 'rw', MedicationStatement: 'rw', Observation: 'rw', Condition: 'rw', Encounter: 'rw', DocumentReference: 'rw', Procedure: 'rw' } },
  np: { label: 'Nurse Practitioner', access: { Patient: 'rw', AllergyIntolerance: 'rw', MedicationRequest: 'rw', MedicationStatement: 'rw', Observation: 'rw', Condition: 'rw', Encounter: 'rw', DocumentReference: 'rw', Procedure: 'rw' } },
  rn: { label: 'Registered Nurse', access: { Patient: 'r', AllergyIntolerance: 'r', MedicationRequest: 'r', MedicationStatement: 'r', Observation: 'rw', Condition: 'r', Encounter: 'r', DocumentReference: 'r', Procedure: 'r' } },
  pharmacist: { label: 'Clinical Pharmacist', access: { Patient: 'r', AllergyIntolerance: 'rw', MedicationRequest: 'rw', MedicationStatement: 'rw', Observation: 'r', Condition: 'r', Encounter: 'r', DocumentReference: 'r', Procedure: '' } },
  specialist: { label: 'Specialist', access: { Patient: 'rw', AllergyIntolerance: 'rw', MedicationRequest: 'rw', MedicationStatement: 'rw', Observation: 'rw', Condition: 'rw', Encounter: 'rw', DocumentReference: 'rw', Procedure: 'rw' } },
  student: { label: 'Medical Student', access: { Patient: 'r', AllergyIntolerance: 'r', MedicationRequest: 'r', MedicationStatement: 'r', Observation: 'r', Condition: 'r', Encounter: 'r', DocumentReference: 'r', Procedure: 'r' } },
  admin: { label: 'Administrator', access: { Patient: 'rw', AllergyIntolerance: '', MedicationRequest: '', MedicationStatement: '', Observation: '', Condition: 'r', Encounter: 'r', DocumentReference: '', Procedure: '' } },
  patient: { label: 'Patient', access: { Patient: 'r', AllergyIntolerance: 'r', MedicationRequest: 'r', MedicationStatement: 'r', Observation: 'r', Condition: 'r', Encounter: 'r', DocumentReference: 'r', Procedure: 'r' } },
};

function generateSyntheticPatients() {
  const now = new Date().toISOString();
  const practitioners = [
    { id: 'pract-dr-chen', label: 'Dr. Sarah Chen, MD — Ophthalmologist', npi: '1234567890' },
    { id: 'pract-dr-patel', label: 'Dr. Raj Patel, MD — Retina Specialist', npi: '2345678901' },
    { id: 'pract-dr-nguyen', label: 'Dr. Minh Nguyen, MD — Glaucoma Specialist', npi: '3456789012' },
  ];

  const patients = [];

  // ── Patient 1: Robert Chen (62M) — Diabetic Retinopathy + Sulfa Allergy ──
  patients.push({
    resource: { resourceType: 'Patient', id: 'patient-001', identifier: [{ system: 'urn:oid:2.16.840.1.113883.19.5', value: 'MRN-001' }], name: [{ family: 'Chen', given: ['Robert', 'L'] }], gender: 'male', birthDate: '1964-06-12' },
    allergies: [
      { resourceType: 'AllergyIntolerance', id: 'allergy-001', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] }, verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }] }, type: 'allergy', category: ['medication'], criticality: 'high', code: { coding: [{ system: 'http://snomed.info/sct', code: '91935009', display: 'Allergy to sulfonamide antibiotic' }], text: 'Sulfa antibiotics (Bactrim)' }, patient: { reference: 'Patient/patient-001' }, onsetDateTime: '2018-03-10', recordedDate: '2019-06-01T10:00:00Z', recorder: { reference: 'Practitioner/pract-dr-chen', display: 'Dr. Sarah Chen' }, note: [{ text: 'Developed severe urticaria and facial swelling after Bactrim prescribed for UTI. Avoid all sulfonamides. Wears medical alert bracelet.' }], reaction: [{ manifestation: [{ coding: [{ system: 'http://snomed.info/sct', code: '247472004', display: 'Hives' }], text: 'Severe urticaria and angioedema' }], severity: 'severe', onset: '2018-03-10' }] },
    ],
    conditions: [
      { resourceType: 'Condition', id: 'cond-001', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: { coding: [{ system: 'http://snomed.info/sct', code: '44054006' }, { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'E11.9' }], text: 'Type 2 Diabetes Mellitus' }, subject: { reference: 'Patient/patient-001' }, onsetDateTime: '2013-05-01', recordedDate: '2013-05-15' },
      { resourceType: 'Condition', id: 'cond-002', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: { coding: [{ system: 'http://snomed.info/sct', code: '4855003' }, { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'E11.319' }], text: 'Diabetic Retinopathy — Proliferative, Both Eyes' }, subject: { reference: 'Patient/patient-001' }, onsetDateTime: '2020-09-01', recordedDate: '2020-09-15', note: [{ text: 'PDR with macular edema OU. Receiving anti-VEGF injections q4-6 weeks.' }] },
      { resourceType: 'Condition', id: 'cond-003', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: { coding: [{ system: 'http://snomed.info/sct', code: '38341003' }, { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'I10' }], text: 'Essential Hypertension' }, subject: { reference: 'Patient/patient-001' }, onsetDateTime: '2013-05-01' },
    ],
    medications: [
      { resourceType: 'MedicationRequest', id: 'med-001', status: 'active', intent: 'order', medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '860999', display: 'Metformin' }], text: 'Metformin 1000mg' }, subject: { reference: 'Patient/patient-001' }, authoredOn: '2025-01-10', requester: { reference: 'Practitioner/pract-dr-chen', display: 'Dr. Sarah Chen' }, dosageInstruction: [{ text: 'Take 1000mg twice daily with meals' }] },
      { resourceType: 'MedicationRequest', id: 'med-002', status: 'active', intent: 'order', medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '314076', display: 'Lisinopril' }], text: 'Lisinopril 10mg' }, subject: { reference: 'Patient/patient-001' }, authoredOn: '2025-01-10', requester: { reference: 'Practitioner/pract-dr-chen', display: 'Dr. Sarah Chen' }, dosageInstruction: [{ text: 'Take 10mg once daily' }] },
      { resourceType: 'MedicationRequest', id: 'med-003', status: 'active', intent: 'order', medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '65747', display: 'Bevacizumab' }], text: 'Bevacizumab 1.25mg/0.05mL intravitreal injection' }, subject: { reference: 'Patient/patient-001' }, authoredOn: '2025-06-01', requester: { reference: 'Practitioner/pract-dr-patel', display: 'Dr. Raj Patel' }, dosageInstruction: [{ text: 'Intravitreal injection OU every 4 weeks for PDR with DME (Protocol S regimen)' }] },
    ],
    observations: [
      { resourceType: 'Observation', id: 'obs-001', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'Hemoglobin A1c' }], text: 'HbA1c' }, subject: { reference: 'Patient/patient-001' }, effectiveDateTime: '2025-07-01', valueQuantity: { value: 8.2, unit: '%', system: 'http://unitsofmeasure.org', code: '%' }, referenceRange: [{ high: { value: 5.7, unit: '%' }, text: 'Normal <5.7%' }] },
      { resourceType: 'Observation', id: 'obs-002', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '28630-6', display: 'Intraocular pressure' }], text: 'IOP Right Eye' }, subject: { reference: 'Patient/patient-001' }, effectiveDateTime: '2025-07-01', valueQuantity: { value: 18, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mmHg' }, referenceRange: [{ low: { value: 10 }, high: { value: 21 }, text: 'Normal 10-21 mmHg' }], bodySite: { coding: [{ system: 'http://snomed.info/sct', code: '394600006', display: 'Right eye' }] } },
      { resourceType: 'Observation', id: 'obs-003', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '28630-6', display: 'Intraocular pressure' }], text: 'IOP Left Eye' }, subject: { reference: 'Patient/patient-001' }, effectiveDateTime: '2025-07-01', valueQuantity: { value: 19, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mmHg' }, referenceRange: [{ low: { value: 10 }, high: { value: 21 }, text: 'Normal 10-21 mmHg' }], bodySite: { coding: [{ system: 'http://snomed.info/sct', code: '896600008', display: 'Left eye' }] } },
      { resourceType: 'Observation', id: 'obs-004', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '79876-5', display: 'Visual acuity' }], text: 'Best Corrected Visual Acuity OD' }, subject: { reference: 'Patient/patient-001' }, effectiveDateTime: '2025-07-01', valueString: '20/60', bodySite: { coding: [{ system: 'http://snomed.info/sct', code: '394600006', display: 'Right eye' }] } },
      { resourceType: 'Observation', id: 'obs-004b', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '79876-5', display: 'Visual acuity' }], text: 'Best Corrected Visual Acuity OS' }, subject: { reference: 'Patient/patient-001' }, effectiveDateTime: '2025-07-01', valueString: '20/200', bodySite: { coding: [{ system: 'http://snomed.info/sct', code: '896600008', display: 'Left eye' }] } },
    ],
    notes: [
      { resourceType: 'DocumentReference', id: 'note-001', status: 'current', subject: { reference: 'Patient/patient-001' }, date: '2025-07-01T10:00:00Z', author: [{ reference: 'Practitioner/pract-dr-patel', display: 'Dr. Raj Patel' }], type: { coding: [{ system: 'http://loinc.org', code: '11502-2', display: 'Ophthalmology progress note' }], text: 'Ophthalmology Progress Note' }, content: [{ attachment: { title: 'Ophthalmology Progress Note 2025-07-01', contentType: 'text/plain', data: 'RE: Robert Chen, DOB 1964-06-12, MRN MRN-001. Patient returns for scheduled anti-VEGF injection. Reports stable vision since last injection 5 weeks ago. No ocular pain or new flashes/floaters. BCVA OD 20/60, OS 20/200. IOP 18/19 OU. Anterior segment: quiet OU. Dilated fundus exam: OD/OS show regressed neovascularization with persistent macular edema. Plan: Bevacizumab 1.25mg/0.05mL intravitreal injection OU. Continue Metformin and Lisinopril as prescribed. Follow up in 4 weeks. HbA1c 8.2% — suboptimal control, counseled on diabetes management. Return precautions given.' } }] },
      { resourceType: 'DocumentReference', id: 'note-002', status: 'current', subject: { reference: 'Patient/patient-001' }, date: '2025-06-03T09:30:00Z', author: [{ reference: 'Practitioner/pract-dr-patel', display: 'Dr. Raj Patel' }], type: { coding: [{ system: 'http://loinc.org', code: '11502-2', display: 'Ophthalmology progress note' }], text: 'Ophthalmology Progress Note' }, content: [{ attachment: { title: 'Ophthalmology Progress Note 2025-06-03', contentType: 'text/plain', data: 'RE: Robert Chen. Interval visit. BCVA stable at 20/60 OD, 20/200 OS. IOP 16/17 OU. OCT shows persistent intraretinal fluid OU but decreased from prior. Discussed treatment options including switching to aflibercept given suboptimal anatomic response to bevacizumab. Patient prefers to continue current regimen. Scheduled for injection in 4 weeks. Counseled on importance of glycemic control given HbA1c trend.' } }] },
      { resourceType: 'DocumentReference', id: 'note-003', status: 'current', subject: { reference: 'Patient/patient-001' }, date: '2025-01-15T14:00:00Z', author: [{ reference: 'Practitioner/pract-dr-chen', display: 'Dr. Sarah Chen' }], type: { coding: [{ system: 'http://loinc.org', code: '11502-2', display: 'Ophthalmology progress note' }], text: 'Initial Consult' }, content: [{ attachment: { title: 'Initial Ophthalmology Consult 2025-01-15', contentType: 'text/plain', data: 'RE: Robert Chen, 62yo male referred by PCP for diabetic eye exam. Known T2DM x12 years, HTN managed. Last eye exam >2 years ago. Reports gradual blurring both eyes, worse OS. Denies pain, flashes, floaters. BCVA 20/60 OD, 20/200 OS. IOP 18/19. Anterior segment: quiet. Dilated fundus exam: PDR with macular edema OU, worse OS. No vitreous hemorrhage. Plan: Start anti-VEGF therapy. Discussed risks/benefits of bevacizumab. To schedule first injection in 2 weeks. Refer for formal glycemic assessment — recent HbA1c needed.' } }] },
    ],
  });

  // ── Patient 2: Maria Santos (71F) — Glaucoma + Penicillin Allergy ──
  patients.push({
    resource: { resourceType: 'Patient', id: 'patient-002', identifier: [{ system: 'urn:oid:2.16.840.1.113883.19.5', value: 'MRN-002' }], name: [{ family: 'Santos', given: ['Maria', 'E'] }], gender: 'female', birthDate: '1955-11-08' },
    allergies: [
      { resourceType: 'AllergyIntolerance', id: 'allergy-002', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] }, verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }] }, type: 'allergy', category: ['medication'], criticality: 'high', code: { coding: [{ system: 'http://snomed.info/sct', code: '91936005', display: 'Allergy to penicillin' }, { system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '70618', display: 'Penicillin' }], text: 'Penicillin' }, patient: { reference: 'Patient/patient-002' }, onsetDateTime: '1990-02-15', recordedDate: '2010-03-20T14:00:00Z', recorder: { reference: 'Practitioner/pract-dr-nguyen', display: 'Dr. Minh Nguyen' }, note: [{ text: 'Anaphylactic reaction to penicillin at age 35. Required epinephrine and emergency treatment. Documented lifelong allergy. Avoid all penicillin-class antibiotics.' }], reaction: [{ manifestation: [{ coding: [{ system: 'http://snomed.info/sct', code: '39579001', display: 'Anaphylaxis' }], text: 'Anaphylaxis with respiratory distress' }], severity: 'severe', onset: '1990-02-15' }] },
    ],
    conditions: [
      { resourceType: 'Condition', id: 'cond-004', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: { coding: [{ system: 'http://snomed.info/sct', code: '77075001' }, { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'H40.11X2' }], text: 'Primary Open-Angle Glaucoma, Both Eyes — Moderate Stage' }, subject: { reference: 'Patient/patient-002' }, onsetDateTime: '2018-08-10', recordedDate: '2018-08-15', note: [{ text: 'Moderate POAG OU. IOP controlled on dual therapy (target <18 mmHg). Visual fields show early superior arcuate defects. No COPD, asthma, bradycardia, or heart block — timolol safe to use.' }] },
      { resourceType: 'Condition', id: 'cond-005', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: { coding: [{ system: 'http://snomed.info/sct', code: '193570009', display: 'Cataract' }], text: 'Nuclear Sclerotic Cataract, Both Eyes — Moderate OD, Mild OS' }, subject: { reference: 'Patient/patient-002' }, onsetDateTime: '2023-01-01', recordedDate: '2023-01-15' },
    ],
    medications: [
      { resourceType: 'MedicationRequest', id: 'med-004', status: 'active', intent: 'order', medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '107987', display: 'Latanoprost' }], text: 'Latanoprost 0.005% ophthalmic solution' }, subject: { reference: 'Patient/patient-002' }, authoredOn: '2025-02-01', requester: { reference: 'Practitioner/pract-dr-nguyen', display: 'Dr. Minh Nguyen' }, dosageInstruction: [{ text: 'Instill 1 drop in both eyes at bedtime' }] },
      { resourceType: 'MedicationRequest', id: 'med-005', status: 'active', intent: 'order', medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '8727', display: 'Timolol' }], text: 'Timolol GFS 0.5% ophthalmic gel (once-daily formulation)' }, subject: { reference: 'Patient/patient-002' }, authoredOn: '2025-02-01', requester: { reference: 'Practitioner/pract-dr-nguyen', display: 'Dr. Minh Nguyen' }, dosageInstruction: [{ text: 'Instill 1 drop in both eyes once daily in the morning' }] },
    ],
    observations: [
      { resourceType: 'Observation', id: 'obs-005', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '28630-6' }], text: 'IOP Right Eye' }, subject: { reference: 'Patient/patient-002' }, effectiveDateTime: '2025-06-15', valueQuantity: { value: 18, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mmHg' }, referenceRange: [{ low: { value: 10 }, high: { value: 21 }, text: 'Normal 10-21 mmHg, Target <18' }], bodySite: { coding: [{ system: 'http://snomed.info/sct', code: '394600006' }] } },
      { resourceType: 'Observation', id: 'obs-006', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '28630-6' }], text: 'IOP Left Eye' }, subject: { reference: 'Patient/patient-002' }, effectiveDateTime: '2025-06-15', valueQuantity: { value: 16, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mmHg' }, referenceRange: [{ low: { value: 10 }, high: { value: 21 }, text: 'Normal 10-21 mmHg, Target <18' }], bodySite: { coding: [{ system: 'http://snomed.info/sct', code: '896600008' }] } },
      { resourceType: 'Observation', id: 'obs-007', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '79876-5' }], text: 'Visual Acuity OS' }, subject: { reference: 'Patient/patient-002' }, effectiveDateTime: '2025-06-15', valueString: '20/40', bodySite: { coding: [{ system: 'http://snomed.info/sct', code: '896600008', display: 'Left eye' }] }, note: [{ text: 'VA 20/40 OS due to moderate cataract and early glaucomatous changes.' }] },
    ],
    notes: [
      { resourceType: 'DocumentReference', id: 'note-004', status: 'current', subject: { reference: 'Patient/patient-002' }, date: '2025-06-15T11:00:00Z', author: [{ reference: 'Practitioner/pract-dr-nguyen', display: 'Dr. Minh Nguyen' }], type: { coding: [{ system: 'http://loinc.org', code: '11502-2', display: 'Ophthalmology progress note' }], text: 'Glaucoma Follow-up Note' }, content: [{ attachment: { title: 'Glaucoma Follow-up 2025-06-15', contentType: 'text/plain', data: 'RE: Maria Santos, DOB 1955-11-08. Returns for 6-month glaucoma follow-up. Compliant with latanoprost qHS and timolol GFS qAM. No ocular side effects. BP well controlled, no bradycardia. Performs punctal occlusion. IOP 18 OD, 16 OS — well below target of <18mmHg. Pachymetry: 545 OD, 550 OS. Visual fields stable — superior arcuate defects unchanged from prior. OCT RNFL: mild progression inferior OU. VA 20/40 OS due to moderate nuclear sclerotic cataract. Discussed potential cataract surgery with combined glaucoma considerations. Will continue monitoring. Return in 6 months.' } }] },
      { resourceType: 'DocumentReference', id: 'note-005', status: 'current', subject: { reference: 'Patient/patient-002' }, date: '2025-01-10T10:30:00Z', author: [{ reference: 'Practitioner/pract-dr-nguyen', display: 'Dr. Minh Nguyen' }], type: { coding: [{ system: 'http://loinc.org', code: '11502-2', display: 'Ophthalmology progress note' }], text: 'Glaucoma Follow-up Note' }, content: [{ attachment: { title: 'Glaucoma Follow-up 2025-01-10', contentType: 'text/plain', data: 'RE: Maria Santos. IOP 20 OD, 18 OS. Medication compliance good. No progression of visual field defects. Patient reports occasional redness with timolol — switched to timolol GFS once-daily gel forming solution for better tolerability. Discussed importance of continued compliance and annual comprehensive exam. PENICILLIN ALLERGY confirmed — anaphylaxis. Ensure this is flagged in all surgical planning.' } }] },
    ],
  });

  // ── Patient 3: James Wright (58M) — Post-Cataract Surgery, NKDA ──
  patients.push({
    resource: { resourceType: 'Patient', id: 'patient-003', identifier: [{ system: 'urn:oid:2.16.840.1.113883.19.5', value: 'MRN-003' }], name: [{ family: 'Wright', given: ['James', 'T'] }], gender: 'male', birthDate: '1968-04-25' },
    allergies: [
      { resourceType: 'AllergyIntolerance', id: 'allergy-003', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] }, verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }] }, type: 'allergy', category: ['medication'], criticality: 'low', code: { coding: [{ system: 'http://snomed.info/sct', code: '409137002', display: 'No known drug allergy' }], text: 'No known drug allergies' }, patient: { reference: 'Patient/patient-003' }, recordedDate: '2025-01-10T08:00:00Z', recorder: { reference: 'Practitioner/pract-dr-chen', display: 'Dr. Sarah Chen' }, note: [{ text: 'Patient denies any known drug allergies. Confirmed NKDA per pre-operative assessment.' }], reaction: [] },
    ],
    conditions: [
      { resourceType: 'Condition', id: 'cond-006', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'resolved' }] }, code: { coding: [{ system: 'http://snomed.info/sct', code: '193570009', display: 'Cataract' }], text: 'Cataract, Right Eye — Post-Operative (phacoemulsification + IOL, 2025-05-20)' }, subject: { reference: 'Patient/patient-003' }, onsetDateTime: '2023-06-01', abatementDateTime: '2025-05-20', recordedDate: '2025-05-20', note: [{ text: 'Uncomplicated phaco with AcrySof IQ IOL implant. Post-op course uneventful.' }] },
      { resourceType: 'Condition', id: 'cond-007', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: { coding: [{ system: 'http://snomed.info/sct', code: '193570009' }], text: 'Cataract, Left Eye — Immature, Surgery Scheduled' }, subject: { reference: 'Patient/patient-003' }, onsetDateTime: '2024-01-01', recordedDate: '2024-01-10' },
    ],
    medications: [
      { resourceType: 'MedicationRequest', id: 'med-006', status: 'completed', intent: 'order', medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '8634', display: 'Prednisolone acetate' }], text: 'Prednisolone acetate 1% ophthalmic suspension' }, subject: { reference: 'Patient/patient-003' }, authoredOn: '2025-05-20', requester: { reference: 'Practitioner/pract-dr-chen', display: 'Dr. Sarah Chen' }, dosageInstruction: [{ text: 'Post-op taper: 4x daily week 1, 3x daily week 2, 2x daily week 3, 1x daily week 4' }], note: [{ text: 'Completed. Taper finished 2025-06-17. No complications.' }] },
      { resourceType: 'MedicationRequest', id: 'med-007', status: 'completed', intent: 'order', medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '16544', display: 'Moxifloxacin' }], text: 'Moxifloxacin 0.5% ophthalmic solution' }, subject: { reference: 'Patient/patient-003' }, authoredOn: '2025-05-20', requester: { reference: 'Practitioner/pract-dr-chen', display: 'Dr. Sarah Chen' }, dosageInstruction: [{ text: '1 drop 4x daily for 7 days post-op' }] },
    ],
    observations: [
      { resourceType: 'Observation', id: 'obs-008', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '28630-6' }], text: 'IOP Right Eye (post-op)' }, subject: { reference: 'Patient/patient-003' }, effectiveDateTime: '2025-06-20', valueQuantity: { value: 15, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mmHg' }, referenceRange: [{ low: { value: 10 }, high: { value: 21 }, text: 'Normal 10-21 mmHg' }], bodySite: { coding: [{ system: 'http://snomed.info/sct', code: '394600006' }] } },
      { resourceType: 'Observation', id: 'obs-009', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '28630-6' }], text: 'IOP Left Eye' }, subject: { reference: 'Patient/patient-003' }, effectiveDateTime: '2025-06-20', valueQuantity: { value: 16, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mmHg' }, referenceRange: [{ low: { value: 10 }, high: { value: 21 }, text: 'Normal 10-21 mmHg' }], bodySite: { coding: [{ system: 'http://snomed.info/sct', code: '896600008' }] } },
      { resourceType: 'Observation', id: 'obs-010', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '79876-5' }], text: 'Visual Acuity OD (post-op)' }, subject: { reference: 'Patient/patient-003' }, effectiveDateTime: '2025-06-20', valueString: '20/25', bodySite: { coding: [{ system: 'http://snomed.info/sct', code: '394600006' }] } },
    ],
    notes: [
      { resourceType: 'DocumentReference', id: 'note-006', status: 'current', subject: { reference: 'Patient/patient-003' }, date: '2025-06-20T09:00:00Z', author: [{ reference: 'Practitioner/pract-dr-chen', display: 'Dr. Sarah Chen' }], type: { coding: [{ system: 'http://loinc.org', code: '11502-2', display: 'Ophthalmology progress note' }], text: 'Post-operative Visit Note' }, content: [{ attachment: { title: 'Cataract Surgery Post-op 1 Month 2025-06-20', contentType: 'text/plain', data: 'RE: James Wright, DOB 1968-04-25. Post-op week 4 visit status post uncomplicated phacoemulsification with AcrySof IQ IOL implant OD on 2025-05-20. Patient very satisfied with vision. BCVA 20/25 OD without correction. IOP 15 OD. Cornea clear, anterior chamber deep and quiet, IOL well-centered in capsular bag. Posterior capsule clear. No signs of CME or endophthalmitis. Prednisolone taper completed without complication. Moxifloxacin course completed. Discharged from post-op care. Discussed scheduling OS cataract surgery when patient is ready. Patient plans to schedule for late July.' } }] },
      { resourceType: 'DocumentReference', id: 'note-007', status: 'current', subject: { reference: 'Patient/patient-003' }, date: '2025-05-20T16:00:00Z', author: [{ reference: 'Practitioner/pract-dr-chen', display: 'Dr. Sarah Chen' }], type: { coding: [{ system: 'http://loinc.org', code: '11502-2', display: 'Ophthalmology progress note' }], text: 'Operative Report' }, content: [{ attachment: { title: 'Operative Report — Phacoemulsification OD 2025-05-20', contentType: 'text/plain', data: 'PROCEDURE: Phacoemulsification with posterior chamber intraocular lens implant, right eye. SURGEON: Dr. Sarah Chen. ANESTHESIA: Topical proparacaine and intracameral lidocaine. IMPLANT: AcrySof IQ SN60WF +20.5D. Operative course uncomplicated. Clear corneal temporal incision 2.4mm. Continuous curvilinear capsulorhexis. Phacoemulsification completed without complication. IOL inserted into capsular bag without difficulty. Wound checked watertight. Post-op meds: Prednisolone acetate 1% QID taper, Moxifloxacin 0.5% QID x7 days. NKDA confirmed pre-op. Post-op day 1 visit scheduled.' } }] },
    ],
  });

  // ── Patient 4: Diane Foster (79F) — Wet AMD + Latex + Codeine Allergies ──
  patients.push({
    resource: { resourceType: 'Patient', id: 'patient-004', identifier: [{ system: 'urn:oid:2.16.840.1.113883.19.5', value: 'MRN-004' }], name: [{ family: 'Foster', given: ['Diane', 'M'] }], gender: 'female', birthDate: '1947-09-03' },
    allergies: [
      { resourceType: 'AllergyIntolerance', id: 'allergy-004', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] }, verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }] }, type: 'intolerance', category: ['medication'], criticality: 'high', code: { coding: [{ system: 'http://snomed.info/sct', code: '373270004', display: 'Adverse reaction to opioid' }], text: 'Codeine' }, patient: { reference: 'Patient/patient-004' }, onsetDateTime: '2019-08-15', recordedDate: '2019-09-01T11:00:00Z', recorder: { reference: 'Practitioner/pract-dr-patel', display: 'Dr. Raj Patel' }, note: [{ text: 'Severe respiratory depression after codeine/acetaminophen for post-operative pain following hip replacement. CYP2D6 ultra-rapid metabolizer confirmed. Avoid ALL opioids. Use non-opioid alternatives for pain management.' }], reaction: [{ manifestation: [{ coding: [{ system: 'http://snomed.info/sct', code: '267036007', display: 'Respiratory depression' }], text: 'Severe respiratory depression' }], severity: 'severe', onset: '2019-08-15' }] },
      { resourceType: 'AllergyIntolerance', id: 'allergy-005', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] }, verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }] }, type: 'allergy', category: ['environment'], criticality: 'low', code: { coding: [{ system: 'http://snomed.info/sct', code: '300916003', display: 'Allergy to latex' }], text: 'Latex' }, patient: { reference: 'Patient/patient-004' }, onsetDateTime: '2015-03-01', recordedDate: '2015-04-10T09:00:00Z', recorder: { reference: 'Practitioner/pract-dr-patel', display: 'Dr. Raj Patel' }, note: [{ text: 'Contact dermatitis from latex surgical gloves. Clinic uses latex-free equipment for all procedures. Valid for surgical setting.' }], reaction: [{ manifestation: [{ coding: [{ system: 'http://snomed.info/sct', code: '275303003', display: 'Contact dermatitis' }], text: 'Contact dermatitis on hands' }], severity: 'mild' }] },
    ],
    conditions: [
      { resourceType: 'Condition', id: 'cond-008', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: { coding: [{ system: 'http://snomed.info/sct', code: '267718000' }, { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'H35.32' }], text: 'Exudative Age-Related Macular Degeneration OD, Dry AMD OS' }, subject: { reference: 'Patient/patient-004' }, onsetDateTime: '2022-11-15', recordedDate: '2022-11-20', note: [{ text: 'Wet AMD OD diagnosed after sudden vision distortion. Dry AMD OS with drusen. Receiving anti-VEGF injections OD with treat-and-extend protocol. VA OD stable on treatment.' }] },
      { resourceType: 'Condition', id: 'cond-009', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: { coding: [{ system: 'http://snomed.info/sct', code: '38341003' }, { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'I10' }], text: 'Essential Hypertension' }, subject: { reference: 'Patient/patient-004' }, onsetDateTime: '2010-02-01' },
    ],
    medications: [
      { resourceType: 'MedicationRequest', id: 'med-008', status: 'active', intent: 'order', medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '604805', display: 'Ranibizumab' }], text: 'Ranibizumab 0.5mg/0.05mL intravitreal injection OD' }, subject: { reference: 'Patient/patient-004' }, authoredOn: '2025-06-28', requester: { reference: 'Practitioner/pract-dr-patel', display: 'Dr. Raj Patel' }, dosageInstruction: [{ text: 'Intravitreal injection OD. Treat-and-extend protocol: currently q8 weeks after 12-month loading phase.' }] },
      { resourceType: 'MedicationRequest', id: 'med-009', status: 'active', intent: 'plan', medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '52164', display: 'Losartan' }], text: 'Losartan 50mg' }, subject: { reference: 'Patient/patient-004' }, authoredOn: '2025-01-05', requester: { reference: 'Practitioner/pract-dr-patel', display: 'Dr. Raj Patel' }, dosageInstruction: [{ text: 'Take 50mg once daily for hypertension' }] },
    ],
    observations: [
      { resourceType: 'Observation', id: 'obs-011', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '28630-6' }], text: 'IOP Right Eye' }, subject: { reference: 'Patient/patient-004' }, effectiveDateTime: '2025-06-28', valueQuantity: { value: 16, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mmHg' }, referenceRange: [{ low: { value: 10 }, high: { value: 21 }, text: 'Normal 10-21 mmHg' }], bodySite: { coding: [{ system: 'http://snomed.info/sct', code: '394600006' }] } },
      { resourceType: 'Observation', id: 'obs-012', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '28630-6' }], text: 'IOP Left Eye' }, subject: { reference: 'Patient/patient-004' }, effectiveDateTime: '2025-06-28', valueQuantity: { value: 15, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mmHg' }, referenceRange: [{ low: { value: 10 }, high: { value: 21 }, text: 'Normal 10-21 mmHg' }], bodySite: { coding: [{ system: 'http://snomed.info/sct', code: '896600008' }] } },
      { resourceType: 'Observation', id: 'obs-013', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '79876-5' }], text: 'Visual Acuity OD (on anti-VEGF)' }, subject: { reference: 'Patient/patient-004' }, effectiveDateTime: '2025-06-28', valueString: '20/100', bodySite: { coding: [{ system: 'http://snomed.info/sct', code: '394600006' }] } },
      { resourceType: 'Observation', id: 'obs-014', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '79876-5' }], text: 'Visual Acuity OS (dry AMD)' }, subject: { reference: 'Patient/patient-004' }, effectiveDateTime: '2025-06-28', valueString: '20/40', bodySite: { coding: [{ system: 'http://snomed.info/sct', code: '896600008' }] } },
    ],
    notes: [
      { resourceType: 'DocumentReference', id: 'note-008', status: 'current', subject: { reference: 'Patient/patient-004' }, date: '2025-06-28T14:00:00Z', author: [{ reference: 'Practitioner/pract-dr-patel', display: 'Dr. Raj Patel' }], type: { coding: [{ system: 'http://loinc.org', code: '11502-2', display: 'Ophthalmology progress note' }], text: 'Retina Follow-up Note' }, content: [{ attachment: { title: 'AMD Follow-up 2025-06-28', contentType: 'text/plain', data: 'RE: Diane Foster, DOB 1947-09-03. Returns for anti-VEGF injection OD. Currently on treat-and-extend protocol at q8 weeks. BCVA stable at 20/100 OD, 20/40 OS. OCT OD: intraretinal fluid resolved, no subretinal fluid. OCT OS: dry, stable drusen without fluid. IOP 16/15 OU. Reviewed Amsler grid — stable. Discussed extending interval to q10 weeks given sustained anatomic response. Patient agreeable. Concerns about transportation — daughter drives her to appointments. CODEINE ALLERGY noted — severe respiratory depression, CYP2D6 ultra-rapid metabolizer. LATEX ALLERGY — contact dermatitis, use latex-free equipment for all procedures. Plan: Ranibizumab 0.5mg intravitreal OD today, return in 10 weeks. Continue Losartan 50mg daily for HTN.' } }] },
      { resourceType: 'DocumentReference', id: 'note-009', status: 'current', subject: { reference: 'Patient/patient-004' }, date: '2025-03-15T11:30:00Z', author: [{ reference: 'Practitioner/pract-dr-patel', display: 'Dr. Raj Patel' }], type: { coding: [{ system: 'http://loinc.org', code: '11502-2', display: 'Ophthalmology progress note' }], text: 'Retina Follow-up Note' }, content: [{ attachment: { title: 'AMD Follow-up 2025-03-15', contentType: 'text/plain', data: 'RE: Diane Foster. Returns for continued management of wet AMD OD. Previously on q4 week injections, now transitioning to treat-and-extend. BCVA improved to 20/100 from 20/200 at presentation. OCT shows excellent anatomic response — IRF resolved. OS remains dry with drusen. Discussed extending interval to 6 weeks. Patient reports no new visual symptoms. IOP 16/15. Latex allergy precautions maintained. Patient expresses gratitude for vision preservation — able to continue reading large print and recognize faces.' } }] },
    ],
  });

  return { patients, practitioners };
}

const DEFAULT_USERS = [
  { id: 'user-dr-chen', email: 'sarah.chen@eyeclinic.example', role: 'attending', name: 'Dr. Sarah Chen, MD' },
  { id: 'user-dr-patel', email: 'raj.patel@eyeclinic.example', role: 'attending', name: 'Dr. Raj Patel, MD' },
  { id: 'user-dr-nguyen', email: 'minh.nguyen@eyeclinic.example', role: 'attending', name: 'Dr. Minh Nguyen, MD' },
  { id: 'user-rn-jones', email: 'lisa.jones@eyeclinic.example', role: 'rn', name: 'Lisa Jones, RN — Ophthalmic Nurse' },
  { id: 'user-pharm-kim', email: 'david.kim@eyeclinic.example', role: 'pharmacist', name: 'Dr. David Kim, PharmD' },
  { id: 'user-admin-smith', email: 'admin@eyeclinic.example', role: 'admin', name: 'Admin Smith' },
  { id: 'user-patient-001', email: 'robert.chen@example.com', role: 'patient', name: 'Robert Chen', patientId: 'patient-001' },
  { id: 'user-patient-002', email: 'maria.santos@example.com', role: 'patient', name: 'Maria Santos', patientId: 'patient-002' },
];

function seedDatabase() {
  const d = getDb();

  const userStmt = d.prepare('INSERT OR IGNORE INTO users (id, email, name, role, patient_id) VALUES (?, ?, ?, ?, ?)');
  const tx = d.transaction(() => {
    for (const u of DEFAULT_USERS) {
      userStmt.run(u.id, u.email, u.name, u.role, u.patientId || null);
    }
  });
  tx();

  const { patients, practitioners } = generateSyntheticPatients();
  for (const p of practitioners) {
    addResource({ resourceType: 'Practitioner', id: p.id, name: [{ text: p.label }], identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: p.npi }] });
  }
  for (const p of patients) {
    addResource(p.resource);
    addResources(p.allergies);
    addResources(p.conditions);
    addResources(p.medications);
    addResources(p.observations);
    addResources(p.notes || []);
  }

  return { patients: patients.length, practitioners: practitioners.length, totalResources: resourceCount() };
}

function resolveMedicationClass(medicationName) {
  const lower = medicationName.toLowerCase().trim();
  for (const [className, cls] of Object.entries(MEDICATION_CLASSES)) {
    for (const term of cls.terms) {
      if (lower === term || lower.includes(term) || term.includes(lower)) {
        return { className, terms: cls.terms };
      }
    }
  }
  return null;
}

function getUsers() {
  return getDb().prepare('SELECT id, email, name, role, patient_id FROM users ORDER BY role, name').all();
}

function getUserById(userId) {
  return getDb().prepare('SELECT id, email, name, role, patient_id FROM users WHERE id = ?').get(userId);
}

module.exports = {
  MEDICATION_CLASSES, ROLES, DEFAULT_USERS,
  generateSyntheticPatients, seedDatabase, resolveMedicationClass,
  getUsers, getUserById,
};
