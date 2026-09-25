import asyncio
from collections import defaultdict
from typing import Any

_subscribers: dict[str, set[asyncio.Queue]] = defaultdict(set)
_loop: asyncio.AbstractEventLoop | None = None


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Called once from the FastAPI lifespan so background threads (the folder
    watcher, the training loop) can safely schedule broadcasts onto the app's
    event loop.
    """
    global _loop
    _loop = loop


def subscribe(channel: str) -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue()
    _subscribers[channel].add(queue)
    return queue


def unsubscribe(channel: str, queue: asyncio.Queue) -> None:
    _subscribers[channel].discard(queue)


async def broadcast(channel: str, event: dict[str, Any]) -> None:
    for queue in list(_subscribers[channel]):
        queue.put_nowait(event)


def emit_threadsafe(channel: str, event: dict[str, Any]) -> None:
    """Emit from any thread (e.g. the watchdog observer thread, the training thread)."""
    if _loop is None:
        return
    asyncio.run_coroutine_threadsafe(broadcast(channel, event), _loop)
