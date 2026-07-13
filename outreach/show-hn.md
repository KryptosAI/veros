# Show HN Post

## Title
Show HN: Veros — open-source validation layer that fact-checks AI clinical claims against patient records

## Body

AI is showing up in every EHR. Epic, Oracle, and startups are embedding LLMs that write notes, suggest diagnoses, and summarize charts. The problem: these models hallucinate. A fabricated allergy in a clinical note isn't a typo.

Veros is a validation layer that sits between any AI system and the patient's FHIR record. You submit a claim. It opens the chart. It tells you whether the record backs it up, contradicts it, or has no data either way — with exact citations.

Three things it does:

1. **Query** — ask anything about a patient in plain English, get cited answers from the chart
2. **Verify** — submit an AI-generated claim (e.g., "Patient is allergic to penicillin"). It decomposes compound claims into atomic propositions, checks each one against FHIR, and returns VERIFIED/CONTRADICTED/UNVERIFIABLE with per-proposition evidence
3. **Differential** — describe symptoms, get a ranked differential with supporting/contradicting chart evidence, suggested tests, and questions to ask the patient

Built FHIR-native with SMART on FHIR auth, RBAC, hash-chained audit trail, and deidentification. Works with Epic, Oracle, Medplum, OpenEMR, or anything with a FHIR API.

The verification approach is inspired by Stanford's VeriFact (NEJM AI, 2025), which demonstrated that AI can fact-check clinical text as well as humans. Veros packages that insight into a deployable open-source layer.

4 synthetic ophthalmology patients are pre-loaded for demo. Takes 3 commands to run locally.

Feedback welcome — especially on whether this addresses a real problem in your workflow.

## Link
https://github.com/KryptosAI/veros

---

## Posting instructions
- Day: Tuesday morning (8-9 AM Pacific)
- Site: news.ycombinator.com → Submit → check "Show HN"
- Title exactly as above (under 80 chars)
- Do NOT ask for upvotes or stars
- Stay in the thread and reply to every comment for the first 2 hours
