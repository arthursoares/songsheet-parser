#!/usr/bin/env python3
"""
Call OpenAI vision models through an existing ChatGPT/Codex subscription.

Instead of a paid OPENAI_API_KEY, this borrows the OAuth access token that the
Codex CLI caches in ~/.codex/auth.json and talks to the Codex backend
(chatgpt.com/backend-api/codex) using the Responses API. This is the same
"backdoor" mechanism as Simon Willison's llm-openai-via-codex plugin.

Models available depend on your subscription tier (e.g. gpt-5.5, gpt-5.4,
gpt-5.4-mini, gpt-5.2). Run `codex login` first so the auth file exists.

The token grants vision input: images are sent as `input_image` parts.
"""

import base64
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

import openai

REFRESH_URL = "https://auth.openai.com/oauth/token"
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
REFRESH_SKEW_SECONDS = 30
CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"

DEFAULT_MODEL = "gpt-5.5"


class CodexAuthError(Exception):
    """Raised when Codex OAuth credentials are missing or unusable."""


def _auth_path() -> str:
    codex_home = os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))
    path = os.path.join(codex_home, "auth.json")
    if not os.path.exists(path):
        raise CodexAuthError(
            f"Codex auth file not found at {path}. Run `codex login` first."
        )
    return path


def _read_auth(path: str) -> dict:
    with open(path) as f:
        data = json.load(f)
    if data.get("auth_mode") != "chatgpt":
        raise CodexAuthError(
            f"Expected auth_mode 'chatgpt', got '{data.get('auth_mode')}'. "
            "This path only supports ChatGPT OAuth tokens (run `codex login`)."
        )
    return data


def _write_auth(path: str, data: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def _jwt_exp(token: str) -> Optional[int]:
    try:
        payload_b64 = token.split(".")[1]
        payload_b64 += "=" * (4 - len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        return payload.get("exp")
    except Exception:
        return None


def _refresh(refresh_token: str) -> dict:
    body = json.dumps(
        {
            "client_id": CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }
    ).encode()
    req = urllib.request.Request(
        REFRESH_URL, data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode(errors="replace")
        raise CodexAuthError(
            f"Token refresh failed (HTTP {e.code}): {error_body}. "
            "Run `codex login` to re-authenticate."
        ) from None
    except urllib.error.URLError as e:
        raise CodexAuthError(f"Token refresh failed (network error): {e}") from None


def borrow_codex_key() -> tuple[str, Optional[str]]:
    """
    Return (access_token, account_id) from the local Codex CLI credentials,
    refreshing the token in place if it is expired or near-expiry.
    """
    auth_path = _auth_path()
    data = _read_auth(auth_path)

    tokens = data.get("tokens") or {}
    if not tokens.get("access_token"):
        raise CodexAuthError(
            "No ChatGPT tokens found in auth.json. Run `codex login` first."
        )

    access_token = tokens["access_token"]
    account_id = tokens.get("account_id")
    exp = _jwt_exp(access_token)

    if exp is not None and time.time() < (exp - REFRESH_SKEW_SECONDS):
        return access_token, account_id

    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        raise CodexAuthError(
            "Access token expired and no refresh token available. Run `codex login`."
        )

    new_tokens = _refresh(refresh_token)
    for field in ("access_token", "id_token", "refresh_token"):
        if new_tokens.get(field):
            tokens[field] = new_tokens[field]
    data["tokens"] = tokens
    data["last_refresh"] = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
    _write_auth(auth_path, data)

    return tokens["access_token"], account_id


def make_client() -> openai.OpenAI:
    """Build an OpenAI client pointed at the Codex backend with a borrowed token."""
    token, account_id = borrow_codex_key()
    headers = {}
    if account_id:
        headers["ChatGPT-Account-ID"] = account_id
    return openai.OpenAI(
        api_key=token, base_url=CODEX_BASE_URL, default_headers=headers
    )


def _mime_type(image_path: Path) -> str:
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }.get(image_path.suffix.lower(), "image/png")


def _strip_json(text: str) -> str:
    """Pull JSON out of a model response that may be wrapped in markdown fences."""
    text = text.strip()
    if "```json" in text:
        text = text.split("```json", 1)[1].split("```", 1)[0]
    elif "```" in text:
        text = text.split("```", 1)[1].split("```", 1)[0]
    return text.strip()


def codex_vision_text(
    image_path: Path,
    prompt: str,
    model: str = DEFAULT_MODEL,
    system: str = "You are a careful musical-score analysis assistant.",
    client: Optional[openai.OpenAI] = None,
) -> str:
    """
    Send one image + prompt to a Codex-backend vision model and return the
    accumulated text response. Streams internally (the backend requires it).
    """
    client = client or make_client()
    image_path = Path(image_path)
    with open(image_path, "rb") as f:
        b64 = base64.standard_b64encode(f.read()).decode()
    data_url = f"data:{_mime_type(image_path)};base64,{b64}"

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": data_url, "detail": "high"},
            ],
        }
    ]

    chunks: list[str] = []
    for event in client.responses.create(
        model=model,
        input=messages,
        instructions=system,
        store=False,
        stream=True,
    ):
        if getattr(event, "type", None) == "response.output_text.delta":
            chunks.append(event.delta)
    return "".join(chunks)


def codex_vision_json(
    image_path: Path,
    prompt: str,
    model: str = DEFAULT_MODEL,
    system: str = "You are a careful musical-score analysis assistant.",
    client: Optional[openai.OpenAI] = None,
) -> object:
    """Same as codex_vision_text but parses the response as JSON."""
    text = codex_vision_text(image_path, prompt, model, system, client)
    return json.loads(_strip_json(text))


def complete_text(
    prompt: str,
    model: str = DEFAULT_MODEL,
    system: str = "You are a careful assistant.",
    client: Optional[openai.OpenAI] = None,
) -> str:
    """Send a text-only prompt to the Codex backend and return the text reply.

    Streams internally (the backend requires it), mirroring codex_vision_text but
    with no image part.
    """
    client = client or make_client()
    chunks: list[str] = []
    for event in client.responses.create(
        model=model,
        input=[{"role": "user", "content": prompt}],
        instructions=system,
        store=False,
        stream=True,
    ):
        if getattr(event, "type", None) == "response.output_text.delta":
            chunks.append(event.delta)
    return "".join(chunks)


if __name__ == "__main__":
    # Smoke test: confirm credentials work with a trivial text round-trip.
    import sys

    try:
        client = make_client()
        resp = client.responses.create(
            model=DEFAULT_MODEL,
            input=[{"role": "user", "content": "Reply with exactly: OK"}],
            instructions="You are terse.",
            store=False,
            stream=True,
        )
        out = "".join(
            e.delta
            for e in resp
            if getattr(e, "type", None) == "response.output_text.delta"
        )
        print(f"✓ Codex auth OK, model={DEFAULT_MODEL}, reply={out.strip()!r}")
    except Exception as e:
        print(f"✗ Codex smoke test failed: {e}", file=sys.stderr)
        sys.exit(1)
