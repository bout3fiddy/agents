from __future__ import annotations

from dataclasses import dataclass, field
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any, Callable
import time


# Load Request/Response/Context from the fixture path requested in the prompt.
_HTTP_TYPES_PATH = (
    Path(__file__).resolve().parents[3]
    / "fixtures"
    / "codequality"
    / "cd015"
    / "http_types.py"
)
_spec = spec_from_file_location("cd015_http_types", _HTTP_TYPES_PATH)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"Failed to load HTTP types from {_HTTP_TYPES_PATH}")
_http_types = module_from_spec(_spec)
_spec.loader.exec_module(_http_types)

Request = _http_types.Request
Response = _http_types.Response
Context = _http_types.Context


Handler = Callable[[Request, "PipelineContext"], Response]
NextHandler = Callable[[Request, "PipelineContext"], Response]
Middleware = Callable[[Request, "PipelineContext", NextHandler], Response]


@dataclass
class PipelineContext(Context):
    """Typed context shared across middleware stages."""

    validated_body: dict[str, Any] | None = None
    request_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class TokenAuth:
    def __init__(self, valid_tokens: dict[str, tuple[str, list[str]]]) -> None:
        self._valid_tokens = valid_tokens

    def __call__(self, request: Request, ctx: PipelineContext, nxt: NextHandler) -> Response:
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return Response(status=401, body={"error": "missing bearer token"})

        token = auth.removeprefix("Bearer ").strip()
        user = self._valid_tokens.get(token)
        if user is None:
            return Response(status=403, body={"error": "invalid token"})

        ctx.user_id = user[0]
        ctx.roles = user[1]
        return nxt(request, ctx)


class JsonBodyValidation:
    def __call__(self, request: Request, ctx: PipelineContext, nxt: NextHandler) -> Response:
        if request.body is None:
            return Response(status=400, body={"error": "request body required"})
        if not isinstance(request.body, dict):
            return Response(status=422, body={"error": "body must be an object"})
        if "name" not in request.body:
            return Response(status=422, body={"error": "missing required field: name"})

        # Typed value available to downstream handlers.
        ctx.validated_body = request.body
        return nxt(request, ctx)


class InMemoryRateLimit:
    def __init__(self, limit: int, window_seconds: float) -> None:
        self._limit = limit
        self._window = window_seconds
        self._hits: dict[str, list[float]] = {}

    def __call__(self, request: Request, ctx: PipelineContext, nxt: NextHandler) -> Response:
        now = time.monotonic()
        key = request.client_ip
        active = [ts for ts in self._hits.get(key, []) if now - ts < self._window]
        self._hits[key] = active

        remaining = self._limit - len(active)
        if remaining <= 0:
            return Response(status=429, body={"error": "rate limit exceeded"}, headers={"X-RateLimit-Remaining": "0"})

        active.append(now)
        self._hits[key] = active
        ctx.rate_limit_remaining = self._limit - len(active)

        resp = nxt(request, ctx)
        resp.headers["X-RateLimit-Remaining"] = str(ctx.rate_limit_remaining)
        return resp


class ErrorFormatting:
    def __call__(self, request: Request, ctx: PipelineContext, nxt: NextHandler) -> Response:
        try:
            return nxt(request, ctx)
        except Exception as exc:  # noqa: BLE001
            return Response(status=500, body={"error": "internal_server_error", "detail": str(exc)})


def build_pipeline(middlewares: list[Middleware], endpoint: Handler) -> Callable[[Request], Response]:
    """Compose middleware into a single request handler.

    Each middleware can short-circuit by returning a Response without calling `nxt`.
    """

    def run(request: Request) -> Response:
        ctx = PipelineContext(request=request, start_time_ns=time.monotonic_ns())

        def dispatch(index: int, req: Request, current_ctx: PipelineContext) -> Response:
            if index >= len(middlewares):
                return endpoint(req, current_ctx)
            mw = middlewares[index]
            return mw(req, current_ctx, lambda r, c: dispatch(index + 1, r, c))

        return dispatch(0, request, ctx)

    return run


def app_endpoint(request: Request, ctx: PipelineContext) -> Response:
    body = {
        "message": f"hello {ctx.user_id}",
        "name": ctx.validated_body["name"] if ctx.validated_body else None,
        "roles": ctx.roles,
    }
    return Response(status=200, body=body)


if __name__ == "__main__":
    pipeline = build_pipeline(
        middlewares=[
            ErrorFormatting(),
            InMemoryRateLimit(limit=5, window_seconds=60),
            TokenAuth(valid_tokens={"good-token": ("u-123", ["admin"])}),
            JsonBodyValidation(),
        ],
        endpoint=app_endpoint,
    )

    request = Request(
        method="POST",
        path="/hello",
        headers={"Authorization": "Bearer good-token"},
        body={"name": "Ada"},
        client_ip="10.0.0.8",
    )
    print(pipeline(request))
