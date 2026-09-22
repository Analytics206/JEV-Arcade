"""What an Arcade game is: `Game`, the `Context` its play receives, and the
errors a round's setup may raise. Game modules import from here, never from
the registry, which imports them.

A game is one module under `games/` with a `GAME = Game(...)` in it:

    class Params(BaseModel): ...                      # what the setup may choose
    async def prepare(ctx) -> dict: ...               # optional: fetch the round, before the run starts
    async def play(run, ctx) -> None: ...             # the game itself
    GAME = Game(id=..., title=..., tagline=..., use_case=..., params=Params, play=play, prepare=prepare)

`prepare` runs inside the request that starts the game, so a round that cannot
be set up (Wikipedia is down, the article has no coordinates) is a 400 or 502
with a reason, not a run that errors at once. What it returns becomes the run's
own top-level fields, streamed to the page; what the page must not see yet
(the lie, the critic's score) goes in `ctx.private` until `play` reveals it.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel

from ..config import Settings
from ..race.wiki import Wiki
from .players import Player
from .runs import GameRun


class GameInputError(ValueError):
    """The round cannot be set up as asked; the message says why (HTTP 400)."""


class GameSourceError(RuntimeError):
    """A source the round needs did not answer (HTTP 502)."""


@dataclass
class Context:
    """Everything a game may use, besides its run."""

    settings: Settings
    providers: Mapping[str, Any]
    wiki: Wiki
    players: list[Player]
    params: Any
    #: What the page must not see yet. Never streamed; gone with the run.
    private: dict[str, Any] = field(default_factory=dict)

    @property
    def jev(self) -> list[Player]:
        return [p for p in self.players if p.is_jev]

    @property
    def text(self) -> list[Player]:
        return [p for p in self.players if not p.is_jev]


class NoParams(BaseModel):
    pass


@dataclass(frozen=True)
class Game:
    id: str
    title: str
    tagline: str
    #: The Jev use case it shows, in a few words.
    use_case: str
    play: Callable[[GameRun, Context], Awaitable[None]]
    params: type[BaseModel] = NoParams
    prepare: Callable[[Context], Awaitable[dict[str, Any]]] | None = None
    #: (fewest, most) lanes.
    lanes: tuple[int, int] = (1, 4)
    #: Who may take a lane: `judgment` (Jev), `text`.
    kinds: frozenset[str] = frozenset({"judgment", "text"})
    #: At least one lane must be Jev.
    needs_jev: bool = False
    #: False while the game is a placeholder: the hub says "coming soon".
    ready: bool = True

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id, "title": self.title, "tagline": self.tagline, "use_case": self.use_case,
            "lanes": {"min": self.lanes[0], "max": self.lanes[1]}, "kinds": sorted(self.kinds),
            "needs_jev": self.needs_jev, "ready": self.ready,
            "params": self.params.model_json_schema(),
        }


def placeholder(id: str, title: str, tagline: str, use_case: str) -> Game:
    """A game that is listed but not built yet."""
    async def play(run: GameRun, ctx: Context) -> None:
        raise GameInputError(f"{title} is not built yet")

    return Game(id=id, title=title, tagline=tagline, use_case=use_case, play=play, ready=False)
