from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Callable, Mapping, Sequence


def _load_http_types() -> tuple[type, type, type]:
    """Load Request/Response/Context from fixtures by file path."""
    module_path = (
        Path(__file__).resolve().parents[3]
        / "fixtures"
        / "codequality"
        / "cd015"
        / "http_types.py"
    )
    spec = importlib.util.spec_from_file_location("cd015_http_types", module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load HTTP types from {module_path}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Request, module.Response, module.Context


Request, Response, Context = _load_http_types()

Handler = Callable[[Context], Response]
Middleware = Callable[[Context, Handler], Response]


def chain_middlewares(middlewares: Sequence[Middleware], endpoint: Handler) -> Handler:
    """Compose middleware right-to-left into a single context handler."""
    handler = endpoint
    for middleware in reversed(middlewares):
        next_handler = handler

        def wrapped(ctx: Context, mw: Middleware = middleware, nxt: Handler = next_handler) -> Response:
            return mw(ctx, nxt)

        handler = wrapped
    return handler


class MiddlewarePipeline:
    def __init__(self, middlewares: Sequence[Middleware], endpoint: Handler) -> None:
        self._handler = chain_middlewares(middlewares, endpoint)

    def handle(self, request: Request) -> Response:
        context = Context(request=request)
        return self._handler(context)


def auth_middleware(valid_tokens: Mapping[str, tuple[str, list[str]]]) -> Middleware:
    def middleware(ctx: Context, next_handler: Handler) -> Response:
        auth_header = ctx.request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return Response(status=401, body={"error": "missing bearer token"})

        token = auth_header[len("Bearer ") :].strip()
        principal = valid_tokens.get(token)
        if principal is None:
            return Response(status=403, body={"error": "invalid token"})

        ctx.user_id, roles = principal
        ctx.roles = list(roles)
        return next_handler(ctx)

    return middleware


def validation_middleware(validator: Callable[[object], list[str]]) -> Middleware:
    def middleware(ctx: Context, next_handler: Handler) -> Response:
        errors = validator(ctx.request.body)
        if errors:
            ctx.errors.extend(errors)
            return Response(status=422, body={"errors": errors})
        return next_handler(ctx)

    return middleware


def rate_limit_middleware(limit_per_client: int = 5) -> Middleware:
    requests_seen: dict[str, int] = {}

    def middleware(ctx: Context, next_handler: Handler) -> Response:
        ip = ctx.request.client_ip
        requests_seen[ip] = requests_seen.get(ip, 0) + 1
        remaining = max(limit_per_client - requests_seen[ip], 0)
        ctx.rate_limit_remaining = remaining

        if requests_seen[ip] > limit_per_client:
            return Response(status=429, body={"error": "rate limit exceeded"}, headers={"X-RateLimit-Remaining": "0"})

        response = next_handler(ctx)
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        return response

    return middleware


def error_formatting_middleware() -> Middleware:
    def middleware(ctx: Context, next_handler: Handler) -> Response:
        try:
            return next_handler(ctx)
        except Exception as exc:  # noqa: BLE001 - middleware intentionally normalizes exceptions
            return Response(
                status=500,
                body={
                    "error": {
                        "type": exc.__class__.__name__,
                        "message": str(exc),
                        "path": ctx.request.path,
                    }
                },
            )

    return middleware


def _sample_endpoint(ctx: Context) -> Response:
    return Response(
        status=200,
        body={
            "ok": True,
            "user_id": ctx.user_id,
            "roles": ctx.roles,
            "payload": ctx.request.body,
        },
    )


if __name__ == "__main__":
    valid_tokens = {"token-123": ("user-1", ["member"])}

    def validate_payload(body: object) -> list[str]:
        if not isinstance(body, dict):
            return ["JSON body must be an object"]
        if "action" not in body:
            return ["'action' is required"]
        return []

    pipeline = MiddlewarePipeline(
        middlewares=[
            error_formatting_middleware(),
            auth_middleware(valid_tokens),
            validation_middleware(validate_payload),
            rate_limit_middleware(limit_per_client=2),
        ],
        endpoint=_sample_endpoint,
    )

    request = Request(
        method="POST",
        path="/tasks",
        headers={"Authorization": "Bearer token-123"},
        body={"action": "run"},
        client_ip="10.0.0.8",
    )
    print(pipeline.handle(request))
