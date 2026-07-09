<p align="center">
  <img src="public/logo/veros-banner.png" alt="Veros" width="512">
</p>

# Veros

**Clinical ground truth for AI.**

Veros verifies AI-generated clinical claims against FHIR source records. Every verdict cites the exact chart evidence that supports or contradicts the claim. No source, no answer. Every query logged, every chain auditable.

---

## Quick start

```bash
npm install
npm start        # → http://localhost:3100
npm run eval     # 27 unit tests
npm run benchmark # citation precision/recall
```

## What it does

| Mode | Endpoint | Description |
|---|---|---|
| **Query** | `POST /api/query` | Ask questions, get cited answers from the chart |
| **Verify** | `POST /api/verify` | Verify AI claims against FHIR truth |
| **Bulk** | `POST /api/verify/bulk` | Verify multiple claims at once |

### Verdicts

- **VERIFIED** — Chart confirms this claim. Here is the exact source.
- **CONTRADICTED** — Chart says the opposite. Here is the proof.
- **UNVERIFIABLE** — No data either way. Refusing to guess.

## LLM

Set `DEEPSEEK_API_KEY` or `OPENAI_API_KEY` to enable full NL query parsing. Without a key, the system uses regex patterns which handle ~80% of common clinical queries. With a key, any natural language question works.

```bash
export DEEPSEEK_API_KEY="sk-your-key"
npm start
```

## License

Open core. The trust layer (query, verify, citations, permissions, audit) is open source.
