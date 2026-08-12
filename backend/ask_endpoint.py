"""
/api/ask — Ask SolutionSet LLM proxy for the ww-merch-ops-demo Databricks App.

Add this to the existing FastAPI service. It is the server-side replacement for
window.cowork.askClaude(), which only exists inside Cowork.

Design notes
------------
* Calls a Databricks Model Serving endpoint, so no Anthropic key lives in the app.
  The app's service principal already authenticates via the Databricks SDK's
  default credential chain — the same identity that runs /api/query.
* The endpoint does NOT execute SQL. The frontend takes the SQL the model returns,
  sanitises it client-side, then sends it to /api/query, which applies the real
  SELECT-only + allowlist enforcement. The model is never in the trust path.
* Prompts are capped and the response is returned as plain text.

Prerequisites in the workspace
------------------------------
1. A Model Serving endpoint serving Claude. Either a Foundation Model API
   pay-per-token endpoint or an External Model endpoint pointed at Anthropic.
2. The app's service principal needs CAN QUERY on that endpoint.
3. app.yaml gets: env: - name: ASK_ENDPOINT / value: <endpoint-name>
"""

import os
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)
router = APIRouter()

ASK_ENDPOINT = os.environ.get("ASK_ENDPOINT", "")
MAX_PROMPT_CHARS = 24_000
MAX_TOKENS = 1_500


class AskRequest(BaseModel):
    prompt: str = Field(..., min_length=1)


class AskResponse(BaseModel):
    text: str


def _client():
    # Imported lazily so the module can be loaded even where the SDK is absent.
    from databricks.sdk import WorkspaceClient

    return WorkspaceClient()


@router.post("/api/ask", response_model=AskResponse)
def ask(req: AskRequest) -> AskResponse:
    if not ASK_ENDPOINT:
        raise HTTPException(
            status_code=503,
            detail="Ask SolutionSet is not configured: ASK_ENDPOINT is unset in app.yaml.",
        )

    prompt = req.prompt.strip()
    if len(prompt) > MAX_PROMPT_CHARS:
        raise HTTPException(
            status_code=413,
            detail=f"Prompt too large ({len(prompt)} chars, limit {MAX_PROMPT_CHARS}).",
        )

    try:
        from databricks.sdk.service.serving import ChatMessage, ChatMessageRole

        resp = _client().serving_endpoints.query(
            name=ASK_ENDPOINT,
            messages=[ChatMessage(role=ChatMessageRole.USER, content=prompt)],
            max_tokens=MAX_TOKENS,
            temperature=0.0,
        )
    except Exception as exc:  # noqa: BLE001 - surface a usable message to the UI
        log.exception("serving endpoint %s failed", ASK_ENDPOINT)
        raise HTTPException(status_code=502, detail=f"Model endpoint error: {exc}") from exc

    try:
        text = resp.choices[0].message.content or ""
    except (AttributeError, IndexError, TypeError) as exc:
        log.error("unexpected serving response shape: %r", resp)
        raise HTTPException(status_code=502, detail="Unexpected model response shape.") from exc

    return AskResponse(text=text)


# In main.py (or wherever the FastAPI app is created), after the app object exists:
#
#     from .ask_endpoint import router as ask_router
#     app.include_router(ask_router)
#
# Mount it BEFORE the SPA catch-all route, otherwise the static handler swallows /api/ask.
