<p align="center">
  <img src="public/logo/veros-banner.png" alt="Veros" width="512">
</p>

<p align="center">
  <strong>Plug into any EHR. Ask questions in plain English. Get cited answers from the chart.<br>Every AI claim gets fact-checked before it reaches a clinician.</strong>
</p>

---

## Quick demo

```bash
git clone https://github.com/KryptosAI/veros.git && cd veros && npm install && npm start
# → http://localhost:3100 (4 synthetic ophthalmology patients pre-loaded)
```

```bash
# Ask a question
curl -X POST localhost:3100/api/query/demo \
  -H 'Content-Type: application/json' \
  -d '{"question":"is this patient allergic to penicillin","patientId":"patient-002","userId":"user-dr-nguyen"}'
```

```json
{
  "understanding": "Checking for allergies or adverse reactions",
  "answer": "YES — Maria E Santos has a documented Penicillin. HIGH RISK. Anaphylaxis with respiratory distress in 1990.",
  "citations": [{
    "sourceType": "AllergyIntolerance",
    "sourceId": "allergy-002",
    "display": "Penicillin — HIGH RISK (Confirmed)",
    "snippet": "Anaphylaxis with respiratory distress — avoid penicillin-class antibiotics."
  }],
  "policy": "all_cited"
}
```

```bash
# Verify an AI claim — decomposes compound claims into atomic propositions
curl -X POST localhost:3100/api/verify/demo \
  -H 'Content-Type: application/json' \
  -d '{"claim":"Patient has diabetic retinopathy, is on metformin, and is allergic to penicillin","patientId":"patient-001","userId":"user-dr-chen"}'
```

```json
{
  "verdict": "PARTIALLY_VERIFIED",
  "reason": "2 verified, 0 contradicted, 1 unverifiable.",
  "decomposed": true,
  "propositions": [
    { "proposition": "Patient has diabetic retinopathy", "verdict": "VERIFIED", "reason": "Confirmed: 'Diabetic Retinopathy — Proliferative, Both Eyes' is documented (active)." },
    { "proposition": "is on metformin", "verdict": "VERIFIED", "reason": "Confirmed: Metformin 1000mg — active (order)." },
    { "proposition": "is allergic to penicillin", "verdict": "UNVERIFIABLE", "reason": "No allergy or medication history found for penicillin." }
  ]
}
```

```bash
# Generate a differential diagnosis
curl -X POST localhost:3100/api/differential/demo \
  -H 'Content-Type: application/json' \
  -d '{"symptoms":"62yo diabetic with progressive blurry vision OS x6mo, no pain, no flashes","patientId":"patient-001","userId":"user-dr-chen"}'
```

| Rank | Diagnosis | Likelihood | Supporting |
|---|---|---|---|
| 1 | Diabetic Macular Edema Progression | high | HbA1c 8.2%, PDR, anti-VEGF therapy |
| 2 | Vitreous Hemorrhage | medium | PDR both eyes |
| 3 | Cataract | medium | Age 62, diabetic |
| 4 | Tractional Retinal Detachment | low | PDR both eyes |
| 5 | NAION | low | Age 62, hypertension |

Each diagnosis includes suggested tests to order and questions to ask the patient.

## What it does

AI systems are being embedded in every EHR. They write notes, suggest diagnoses, summarize charts. They also hallucinate. A fabricated allergy or a wrong medication in a clinical note isn't a typo — it's dangerous. Veros is a validation layer: submit a claim, and it checks whether the actual patient record backs it up, contradicts it, or has no data either way.

<p align="center">
  <img src="public/veros-architecture.png" alt="Architecture" width="700">
</p>

## Features

| | | |
|---|---|---|
| 🗣 **Plain English queries** | 📋 **Cited FHIR sources** | 🔍 **AI claim verification** |
| Ask anything about a patient. LLM interprets intent, searches FHIR, answers with citations. | Every answer links to the exact chart source — resource type, ID, author, date, clinical snippet. | Submit a claim. Get VERIFIED, CONTRADICTED, or UNVERIFIABLE with per-proposition evidence. |
| 🩺 **Differential diagnosis** | 🔒 **RBAC + audit trail** | 🏥 **FHIR-native · SMART auth** |
| Describe symptoms. Get ranked differential with supporting/contradicting evidence, suggested tests, patient questions. | 9 clinical roles. Per-resource access. Hash-chained tamper-evident audit log. | Speaks FHIR R4. Authenticates via SMART on FHIR. Works with Epic, Oracle, Medplum, OpenEMR, or anything with a FHIR API. |

## Install

```bash
npm install @kryptosai/veros
```
```bash
git clone https://github.com/KryptosAI/veros.git
cd veros && npm install
npm start          # → http://localhost:3100
npm run eval       # 27 unit tests
npm run benchmark  # citation precision/recall
```

Enable natural language understanding (otherwise falls back to deterministic regex):

```bash
export DEEPSEEK_API_KEY="sk-your-key"
npm start
```

Open source under MIT. PRs and issues welcome on [GitHub](https://github.com/KryptosAI/veros/issues).

## License

MIT © KryptosAI
