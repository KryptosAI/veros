# Cold Outreach Messages

## 1. Cody Ebberson — Medplum CTO
**GitHub:** `codyebberson` — send as GitHub issue on medplum/medplum, or via their Discord

> Cody — I built Veros, an open-source validation layer that verifies AI-generated clinical claims against FHIR records with citations. FHIR-native, SMART on FHIR auth — same stack as Medplum. The claim decomposition approach is adapted from Stanford's VeriFact paper. Your platform already has the FHIR infrastructure; Veros adds the "prove it" step that every clinical LLM deployment needs. I'd love 5 minutes to see if this is useful for Medplum users, or if I'm solving the wrong problem. No pitch — just looking for honest feedback from someone who lives in FHIR. https://github.com/KryptosAI/veros

## 2. Philip Chung — VeriFact Lead Author, Stanford
**Email:** philipchung@stanford.edu (or LinkedIn DM)

> Dr. Chung — your VeriFact paper (NEJM AI, 2025) directly inspired Veros: an open-source, production-grade implementation of clinical AI claim verification against FHIR records. We implemented claim decomposition into atomic propositions, per-proposition verification, and verdict-with-reasons — the same approach your paper validated. Veros differs from VeriFact in two ways: it works against structured FHIR (not unstructured MIMIC notes), and it's built for production deployment with SMART on FHIR auth, audit logging, and RBAC. Code is open source. I'd be honored to get your technical feedback — especially on where the approach breaks down in practice and what you'd do differently. No strings attached. https://github.com/KryptosAI/veros

## 3. Josh Mandel — SMART on FHIR Creator, Microsoft Healthcare
**GitHub:** `jmandel` — comment on a relevant repo or DM

> Josh — I built Veros, an open-source layer that verifies AI-generated clinical claims against FHIR records using SMART on FHIR auth. The validation layer concept: submit a claim, decompose it into atomic propositions, verify each against the FHIR chart, return VERIFIED/CONTRADICTED/UNVERIFIABLE with citations. You built the SMART spec it authenticates against, and your recent health-record-mcp work connects AI to health records via FHIR. Veros could be the verification step those AI pipelines are missing. Open source — would love your architectural feedback on whether this pattern makes sense. https://github.com/KryptosAI/veros

---

## Sending instructions
- Tuesday-Thursday only, 6-8 AM recipient timezone
- One message per person. One follow-up after 5 days if no reply
- Never more than 2 messages without response
- Do NOT ask for stars, retweets, or promotion — only feedback
