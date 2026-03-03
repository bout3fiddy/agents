from __future__ import annotations

from dataclasses import dataclass
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any, Callable, TypeAlias


def _load_http_types() -> tuple[type, type, type]:
    """Load Request/Response/Context from the fixture file by path."""
    fixture_path = Path(__file__).resolve().parents[3] / "fixtures" / "codequality" / "cd015" / "http_types.py"
    spec = spec_from_file_location("cd015_http_types", fixture_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to import HTTP types from {fixture_path}")

    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Request, module.Response, module.Context


Request, Response, Context = _load_http_types()

NextHandler: TypeAlias = Callable[[Context], Response]
Middleware: TypeAlias = Callable[[Context, NextHandler], Response]


@dataclass
class MiddlewarePipeline:
    """Composable HTTP middleware pipeline.

    Each middleware can:
    - read/update the shared typed Context
    - short-circuit by returning a Response early
    - delegate to the next stage
    """

    endpoint: NextHandler
    middleware: list[Middleware]

    def __init__(self, endpoint: NextHandler):
        self.endpoint = endpoint
        self.middleware = []

    def use(self, handler: Middleware) -> "MiddlewarePipeline":
        self.middleware.append(handler)
        return self

    def _compose(self) -> NextHandler:
        handler = self.endpoint
        for mw in reversed(self.middleware):
            current = handler

            def wrapped(ctx: Context, *, _mw: Middleware = mw, _next: NextHandler = current) -> Response:
                return _mw(ctx, _next)

            handler = wrapped
        return handler

    def handle(self, request: Request) -> Response:
        ctx = Context(request=request)
        return self._compose()(ctx)


def _header(headers: dict[str, str], name: str) -> str | None:
    for key, value in headers.items():
        if key.lower() == name.lower():
            return value
    return None


def auth_middleware(validate_token: Callable[[str], dict[str, Any] | None]) -> Middleware:
    def middleware(ctx: Context, next_handler: NextHandler) -> Response:
        auth_header = _header(ctx.request.headers, "Authorization")
        if not auth_header:
            return Response(status=401, body={"error": "missing authorization header"})

        try:
            scheme, token = auth_header.split(" ", 1)
        except ValueError:
            return Response(status=401, body={"error": "invalid authorization header"})

        if scheme.lower() != "bearer":
            return Response(status=401, body={"error": "unsupported auth scheme"})

        claims = validate_token(token.strip())
        if claims is None:
            return Response(status=403, body={"error": "invalid token"})

        # Typed context propagation to later middleware + endpoint.
        ctx.user_id = str(claims.get("user_id", "")) or None
        roles = claims.get("roles", [])
        ctx.roles = [str(role) for role in roles]
        return next_handler(ctx)

    return middleware


def validation_middleware(validator: Callable[[Any], list[str]]) -> Middleware:
    def middleware(ctx: Context, next_handler: NextHandler) -> Response:
        errors = validator(ctx.request.body)
        if errors:
            ctx.errors.extend(errors)
            return Response(status=422, body={"errors": errors})
        return next_handler(ctx)

    return middleware


def rate_limit_middleware(check_limit: Callable[[str], tuple[bool, int]]) -> Middleware:
    def middleware(ctx: Context, next_handler: NextHandler) -> Response:
        allowed, remaining = check_limit(ctx.request.client_ip)
        ctx.rate_limit_remaining = remaining
        if not allowed:
            return Response(
                status=429,
                body={"error": "rate limit exceeded"},
                headers={"X-RateLimit-Remaining": "0"},
            )

        response = next_handler(ctx)
        response.headers["X-RateLimit-Remaining"] = str(max(remaining, 0))
        return response

    return middleware


def error_formatting_middleware() -> Middleware:
    def middleware(ctx: Context, next_handler: NextHandler) -> Response:
        try:
            return next_handler(ctx)
        except Exception as exc:  # noqa: BLE001 - intentional boundary.
            ctx.errors.append(str(exc))
            return Response(
                status=500,
                body={
                    "error": "internal_server_error",
                    "details": ctx.errors,
                    "path": ctx.request.path,
                },
            )

    return middleware


if __name__ == "__main__":
    TOKENS = {
        "good-token": {"user_id": "u-123", "roles": ["reader"]},
    }

    hits: dict[str, int] = {}

    def validate_token(token: str) -> dict[str, Any] | None:
        return TOKENS.get(token)

    def validate_payload(body: Any) -> list[str]:
        if not isinstance(body, dict):
            return ["body must be an object"]
        if "message" not in body:
            return ["message is required"]
        return []

    def check_limit(client_ip: str) -> tuple[bool, int]:
        count = hits.get(client_ip, 0) + 1
        hits[client_ip] = count
        limit = 5
        remaining = max(limit - count, 0)
        return count <= limit, remaining

    def endpoint(ctx: Context) -> Response:
        return Response(
            status=200,
            body={
                "ok": True,
                "user_id": ctx.user_id,
                "roles": ctx.roles,
                "message": ctx.request.body["message"],
            },
        )

    pipeline = (
        MiddlewarePipeline(endpoint)
        .use(error_formatting_middleware())
        .use(rate_limit_middleware(check_limit))
        .use(auth_middleware(validate_token))
        .use(validation_middleware(validate_payload))
    )

    req = Request(
        method="POST",
        path="/messages",
        headers={"Authorization": "Bearer good-token"},
        body={"message": "hello"},
        client_ip="203.0.113.9",
    )
    print(pipeline.handle(req))
