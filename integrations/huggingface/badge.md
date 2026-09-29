[![Run on Anyroute](https://img.shields.io/badge/Run%20on-Anyroute-1fe15a?labelColor=0b0c0b)](https://api-production-70da.up.railway.app/models)

### Run it on Anyroute

OpenAI-compatible, pay per call, a signed receipt for every request:

```sh
curl https://api-production-70da.up.railway.app/api/v1/chat/completions \
  -H "Authorization: Bearer $ANYROUTE_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"<model id>","messages":[{"role":"user","content":"Hello"}]}'
```

<!-- Only for models with attested endpoints (attested_available: true in GET /api/v1/models): -->
[![Attested on Anyroute](https://img.shields.io/badge/Anyroute-attested%20TEE-1fe15a?labelColor=0b0c0b)](https://api-production-70da.up.railway.app/verify)

Add `"provider": {"lane": "attested"}` to the request to use only providers whose enclave the router verified; it refuses rather than falls back.
