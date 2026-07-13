# FHIR Zulip Post — implementers stream at chat.fhir.org

Hi all — I've been building an open-source validation layer for clinical AI that works against FHIR records, and I'd appreciate feedback from this community on whether the FHIR interaction patterns make sense.

**What it does:** Submit an AI-generated claim about a patient ("Patient is allergic to penicillin, has diabetes, and is on metformin"). Veros decomposes it into atomic propositions, verifies each one against the patient's FHIR chart, and returns VERIFIED/CONTRADICTED/UNVERIFIABLE with exact FHIR resource citations.

**FHIR stack:** 
- Resource types queried: AllergyIntolerance, MedicationRequest, Condition, Observation, DocumentReference, Patient
- Auth: SMART on FHIR v2 (launch/patient, bearer tokens, PKCE)
- FHIR endpoints served: /fhir/Patient/:id, /fhir/AllergyIntolerance?patient=X, etc.
- Claim decomposition: adapted from Stanford's VeriFact approach (NEJM AI 2025), but against structured resources instead of unstructured notes

**What I'm unsure about:**
- Is the claim decomposition → per-resource verification pattern useful, or would a vector/RAG approach against FHIR resources be better?
- For the differential diagnosis feature: what FHIR resources should it search beyond Condition and Observation? Should it consider MedicationStatement (what they're actually taking vs what's prescribed)?
- Is SMART launch the right auth pattern for a validation service, or should this be a backend-to-backend FHIR Bulk Data integration?

Code: https://github.com/KryptosAI/veros (MIT, open source, 4 synthetic patients pre-loaded for demo)

Not selling anything — genuinely looking for guidance from FHIR implementers. Thanks.
