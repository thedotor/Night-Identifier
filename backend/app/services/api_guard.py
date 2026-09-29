"""Keeps other programs (and web pages open in the user's browser) from driving the local API.

The API listens on loopback with no login, and a browser will happily send a request to
http://127.0.0.1:8765 from any web page. CORS only stops the page reading the answer, not the
request being made, so on its own it doesn't protect endpoints that move folders or delete images.

When the Electron app starts the backend it hands it a random per-launch token (NIGHT_ID_API_TOKEN)
and adds it as a header to every request the app's own windows make. Anything without it is refused.
With no token set (development, `npm run dev:backend`) the check is off.
"""

import hmac

from starlette.types import ASGIApp, Receive, Scope, Send

TOKEN_HEADER = b"x-ni-token"


class ApiTokenMiddleware:
    def __init__(self, app: ASGIApp, token: str) -> None:
        self.app = app
        self.token = token.encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket") or not self.token:
            await self.app(scope, receive, send)
            return
        given = next((v for k, v in scope["headers"] if k == TOKEN_HEADER), b"")
        if hmac.compare_digest(given, self.token):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [(b"content-type", b"text/plain; charset=utf-8"), (b"content-length", b"9")],
            }
        )
        await send({"type": "http.response.body", "body": b"Forbidden"})
