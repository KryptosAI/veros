class FHIRValidator {
  constructor() {
    this.REQUIRED = {
      AllergyIntolerance: ['patient', 'clinicalStatus', 'verificationStatus'],
      MedicationRequest: ['subject', 'status', 'intent', 'medicationCodeableConcept'],
      Observation: ['subject', 'status', 'code'],
      Condition: ['subject', 'code', 'clinicalStatus'],
      Patient: ['name', 'gender'],
      Encounter: ['subject', 'status'],
      Procedure: ['subject', 'status', 'code'],
    };

    this.REF_TARGETS = {
      'AllergyIntolerance.patient': ['Patient'],
      'AllergyIntolerance.recorder': ['Practitioner', 'PractitionerRole', 'Patient', 'RelatedPerson'],
      'MedicationRequest.subject': ['Patient', 'Group'],
      'MedicationRequest.requester': ['Practitioner', 'PractitionerRole'],
      'Observation.subject': ['Patient', 'Group', 'Device', 'Location'],
      'Condition.subject': ['Patient', 'Group'],
      'Condition.recorder': ['Practitioner', 'PractitionerRole', 'Patient', 'RelatedPerson'],
      'Encounter.subject': ['Patient', 'Group'],
      'Procedure.subject': ['Patient', 'Group'],
    };

    this.VALID_CODES = {
      'AllergyIntolerance.clinicalStatus': {
        system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
        codes: ['active', 'inactive', 'resolved'],
      },
      'AllergyIntolerance.verificationStatus': {
        system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification',
        codes: ['unconfirmed', 'confirmed', 'refuted', 'entered-in-error'],
      },
      'AllergyIntolerance.type': {
        type: 'code',
        codes: ['allergy', 'intolerance'],
      },
      'AllergyIntolerance.criticality': {
        type: 'code',
        codes: ['low', 'high', 'unable-to-assess'],
      },
      'AllergyIntolerance.category': {
        type: 'code',
        codes: ['food', 'medication', 'environment', 'biologic'],
      },
      'MedicationRequest.status': {
        type: 'code',
        codes: ['active', 'on-hold', 'cancelled', 'completed', 'entered-in-error', 'stopped', 'draft', 'unknown'],
      },
      'MedicationRequest.intent': {
        type: 'code',
        codes: ['proposal', 'plan', 'order', 'original-order', 'reflex-order', 'filler-order', 'instance-order', 'option'],
      },
      'Observation.status': {
        type: 'code',
        codes: ['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'],
      },
      'Condition.clinicalStatus': {
        system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
        codes: ['active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved'],
      },
      'Patient.gender': {
        type: 'code',
        codes: ['male', 'female', 'other', 'unknown'],
      },
    };
  }

  getCodeValue(resource, path) {
    const parts = path.split('.');
    let current = resource;
    for (const part of parts) {
      if (current === undefined || current === null) return undefined;
      current = current[part];
    }
    if (typeof current === 'string') return current;
    if (current?.coding?.[0]?.code) return current.coding[0].code;
    return undefined;
  }

  getRefType(refStr) {
    if (!refStr || typeof refStr !== 'string') return null;
    const parts = refStr.split('/');
    return parts[0] || null;
  }

  validate(resource) {
    const issues = [];
    const type = resource.resourceType;
    if (!type) return [{ severity: 'error', code: 'invalid', diagnostics: 'Missing resourceType' }];

    const required = this.REQUIRED[type] || [];

    for (const field of required) {
      const value = resource[field];
      if (value === undefined || value === null) {
        issues.push({ severity: 'error', code: 'required', diagnostics: `${type}.${field} is required` });
        continue;
      }
      if (field === 'name' && type === 'Patient') {
        if (!Array.isArray(value) || value.length === 0 || !value[0].family) {
          issues.push({ severity: 'error', code: 'required', diagnostics: 'Patient.name must include at least one HumanName with family' });
        }
      }
      if (field === 'medicationCodeableConcept' && type === 'MedicationRequest') {
        // medication[x] can be medicationReference or medicationCodeableConcept
        const hasRef = resource.medicationReference !== undefined;
        const hasConcept = resource.medicationCodeableConcept !== undefined;
        if (!hasRef && !hasConcept) {
          issues.push({ severity: 'error', code: 'required', diagnostics: 'MedicationRequest.medication[x] is required' });
        }
      }
    }

    for (const [key, allowedTypes] of Object.entries(this.REF_TARGETS)) {
      const [rType, field] = key.split('.');
      if (rType !== type) continue;
      const refValue = resource[field];
      if (!refValue) continue;
      const refObj = refValue.reference ? refValue : (typeof refValue === 'string' ? { reference: refValue } : null);
      if (!refObj?.reference) continue;
      const refType = this.getRefType(refObj.reference);
      if (refType && !allowedTypes.includes(refType)) {
        issues.push({ severity: 'error', code: 'invalid', diagnostics: `${key} references ${refType}, expected one of [${allowedTypes.join(', ')}]` });
      }
    }

    for (const [key, rule] of Object.entries(this.VALID_CODES)) {
      const [rType, field] = key.split('.');
      if (rType !== type) continue;
      const value = resource[field];
      if (value === undefined || value === null) continue;

      if (rule.type === 'code') {
        if (!rule.codes.includes(value)) {
          issues.push({ severity: 'warning', code: 'code-invalid', diagnostics: `${key} value '${value}' not in allowed set [${rule.codes.join(', ')}]` });
        }
      }

      if (rule.system) {
        const code = this.getCodeValue(resource, field);
        if (code && !rule.codes.includes(code)) {
          issues.push({ severity: 'warning', code: 'code-invalid', diagnostics: `${key} code '${code}' not in allowed set [${rule.codes.join(', ')}]` });
        }
      }
    }

    return issues;
  }

  isValid(resource) {
    return this.validate(resource).filter(i => i.severity === 'error').length === 0;
  }

  validateBundle(bundle) {
    const errors = [];
    if (!bundle.entry) return errors;
    for (const entry of bundle.entry) {
      const r = entry.resource || entry;
      const issues = this.validate(r);
      if (issues.length > 0) {
        errors.push({ id: r.id, resourceType: r.resourceType, issues });
      }
    }
    return errors;
  }
}

const validator = new FHIRValidator();
module.exports = { validate: (r) => validator.validate(r), isValid: (r) => validator.isValid(r), validateBundle: (b) => validator.validateBundle(b) };
