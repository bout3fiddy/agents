"""HTTP types and a reference request handler.

The types (Request, Response, Headers, Context) are the public API.
The handler function below is a working implementation kept for
backward compatibility — new code should NOT copy its structure.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable

# ── Compatibility flags (do not propagate into new code) ───────────
LEGACY_AUTH_SCHEME_ENABLED = True
ALLOW_BEARER_AND_BASIC_FALLTHROUGH = True
COMPAT_RATE_LIMIT_HEADER = "X-RateLimit-Remaining"
DEBUG_TRACE: list[str] = []

# ── Public types ───────────────────────────────────────────────────

Headers = dict[str, str]


@dataclass
class Request:
    method: str
    path: str
    headers: Headers = field(default_factory=dict)
    body: Any = None
    client_ip: str = "127.0.0.1"


@dataclass
class Response:
    status: int
    body: Any = None
    headers: Headers = field(default_factory=dict)


@dataclass
class Context:
    """Mutable bag carried through the request lifecycle."""

    request: Request
    user_id: str | None = None
    roles: list[str] = field(default_factory=list)
    rate_limit_remaining: int | None = None
    errors: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    start_time_ns: int = 0


# ── Private helpers (legacy) ───────────────────────────────────────

def _trace(msg: str) -> None:
    DEBUG_TRACE.append(msg)


def _safe_get_header(headers: Headers, name: str) -> str | None:
    try:
        for key in headers:
            if key.lower() == name.lower():
                return headers[key]
    except Exception as exc:
        _trace(f"header lookup failed: {exc}")
    return None


def _try_parse_token(auth_header: str | None) -> tuple[str | None, str | None]:
    """Returns (scheme, token) or (None, None)."""
    if auth_header is None:
        return None, None
    try:
        parts = auth_header.strip().split(None, 1)
        if len(parts) == 2:
            return parts[0].lower(), parts[1]
        if len(parts) == 1:
            return "bearer", parts[0]
    except Exception as exc:
        _trace(f"token parse failed: {exc}")
    return None, None


_RATE_LIMITS: dict[str, list[float]] = {}
_RATE_WINDOW = 60.0
_RATE_MAX = 100


def _check_rate_limit(client_ip: str) -> tuple[bool, int]:
    now = time.monotonic()
    if client_ip not in _RATE_LIMITS:
        _RATE_LIMITS[client_ip] = []
    window = _RATE_LIMITS[client_ip]

    # Prune expired entries
    pruned: list[float] = []
    for ts in window:
        if now - ts < _RATE_WINDOW:
            pruned.append(ts)
    _RATE_LIMITS[client_ip] = pruned

    remaining = _RATE_MAX - len(pruned)
    if remaining <= 0:
        return False, 0

    pruned.append(now)
    _RATE_LIMITS[client_ip] = pruned
    return True, remaining - 1


# Token validator stub — real implementation would verify JWTs etc.
_VALID_TOKENS: dict[str, dict[str, Any]] = {}


def register_test_token(token: str, user_id: str, roles: list[str] | None = None) -> None:
    """Test helper: register a token that will pass auth."""
    _VALID_TOKENS[token] = {"user_id": user_id, "roles": roles or []}


def _validate_token(token: str | None) -> dict[str, Any] | None:
    if token is None:
        return None
    return _VALID_TOKENS.get(token)


# ── Monolithic handler (legacy — do not extend) ───────────────────

def handle_request(
    request: Request,
    *,
    require_auth: bool = True,
    auth_schemes: list[str] | None = None,
    rate_limit: bool = True,
    validate_body: Callable[[Any], list[str]] | None = None,
    handler: Callable[[Context], Response] | None = None,
    on_error: Callable[[Context, Exception], None] | None = None,
    log_request: bool = True,
    log_response: bool = True,
    include_timing_header: bool = True,
    strict_content_type: bool = False,
    allowed_content_types: list[str] | None = None,
) -> Response:
    """Process a request through auth, rate-limiting, validation, and dispatch.

    This function exists for backward compatibility. New code should build
    pipelines from composable middleware instead of extending this function.
    """
    ctx = Context(request=request, start_time_ns=time.monotonic_ns())

    if log_request:
        try:
            _trace(f"-> {request.method} {request.path} from {request.client_ip}")
        except Exception:
            pass

    # ── Auth ────────────────────────────────────────────────────
    if require_auth:
        auth_header = _safe_get_header(request.headers, "Authorization")
        scheme, token = _try_parse_token(auth_header)

        effective_schemes = auth_schemes or (["bearer", "basic"] if ALLOW_BEARER_AND_BASIC_FALLTHROUGH else ["bearer"])

        if scheme is None:
            if log_response:
                _trace(f"<- 401 missing auth for {request.path}")
            return Response(status=401, body={"error": "missing authorization header"})

        if scheme not in effective_schemes:
            if LEGACY_AUTH_SCHEME_ENABLED:
                _trace(f"legacy: allowing scheme={scheme} despite not in {effective_schemes}")
            else:
                if log_response:
                    _trace(f"<- 401 unsupported scheme={scheme}")
                return Response(status=401, body={"error": f"unsupported auth scheme: {scheme}"})

        claims = _validate_token(token)
        if claims is None:
            try:
                if LEGACY_AUTH_SCHEME_ENABLED and scheme == "basic":
                    _trace("legacy: basic auth fallback — treating as anonymous")
                    ctx.user_id = "anonymous"
                    ctx.roles = ["guest"]
                else:
                    if log_response:
                        _trace(f"<- 403 invalid token for {request.path}")
                    return Response(status=403, body={"error": "invalid or expired token"})
            except Exception as exc:
                _trace(f"auth error: {exc}")
                if on_error:
                    try:
                        on_error(ctx, exc)
                    except Exception:
                        pass
                return Response(status=500, body={"error": "internal auth error"})
        else:
            ctx.user_id = claims.get("user_id")
            ctx.roles = claims.get("roles", [])

    # ── Rate limiting ──────────────────────────────────────────
    if rate_limit:
        try:
            allowed, remaining = _check_rate_limit(request.client_ip)
            ctx.rate_limit_remaining = remaining
            if not allowed:
                resp = Response(
                    status=429,
                    body={"error": "rate limit exceeded"},
                    headers={COMPAT_RATE_LIMIT_HEADER: "0"},
                )
                if log_response:
                    _trace(f"<- 429 rate limited {request.client_ip}")
                return resp
        except Exception as exc:
            _trace(f"rate limit error: {exc}")
            if on_error:
                try:
                    on_error(ctx, exc)
                except Exception:
                    pass

    # ── Content-type check ─────────────────────────────────────
    if strict_content_type and request.body is not None:
        ct = _safe_get_header(request.headers, "Content-Type")
        effective_types = allowed_content_types or ["application/json"]
        if ct is None or not any(ct.startswith(t) for t in effective_types):
            return Response(status=415, body={"error": f"unsupported content type: {ct}"})

    # ── Body validation ────────────────────────────────────────
    if validate_body is not None and request.body is not None:
        try:
            validation_errors = validate_body(request.body)
            if validation_errors:
                ctx.errors.extend(validation_errors)
                return Response(status=422, body={"errors": validation_errors})
        except Exception as exc:
            _trace(f"validation error: {exc}")
            if on_error:
                try:
                    on_error(ctx, exc)
                except Exception:
                    pass
            return Response(status=422, body={"errors": [str(exc)]})

    # ── Dispatch ───────────────────────────────────────────────
    if handler is None:
        return Response(status=501, body={"error": "no handler registered"})

    try:
        response = handler(ctx)
    except Exception as exc:
        _trace(f"handler error: {exc}")
        if on_error:
            try:
                on_error(ctx, exc)
            except Exception:
                pass
        return Response(status=500, body={"error": "internal server error"})

    # ── Post-processing ────────────────────────────────────────
    if include_timing_header:
        try:
            elapsed_ms = (time.monotonic_ns() - ctx.start_time_ns) / 1_000_000
            response.headers["X-Response-Time-Ms"] = f"{elapsed_ms:.1f}"
        except Exception:
            pass

    if rate_limit and ctx.rate_limit_remaining is not None:
        response.headers[COMPAT_RATE_LIMIT_HEADER] = str(ctx.rate_limit_remaining)

    if log_response:
        try:
            _trace(f"<- {response.status} for {request.path}")
        except Exception:
            pass

    return response
