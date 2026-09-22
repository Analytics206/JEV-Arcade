"""The list of Arcade games, in the hub's order, each loaded from its module.

What a game is lives in base.py; this only finds them.
"""
from __future__ import annotations

import importlib

from .base import Context, Game, GameInputError, GameSourceError, NoParams, placeholder

__all__ = ["GAMES", "ORDER", "Context", "Game", "GameInputError", "GameSourceError", "NoParams", "get_game", "placeholder"]

#: Every game, in the hub's order: the eight main games, then the quick hits.
ORDER: tuple[str, ...] = (
    "chess", "switchboard", "customs", "wikiguessr", "railyard", "twotruths", "judges", "ghostmaze",
    "needle", "slots", "drivethru", "memory", "bigsort", "tasting",
)


def _load() -> dict[str, Game]:
    games: dict[str, Game] = {}
    for gid in ORDER:
        module = importlib.import_module(f"{__package__}.{gid}")
        game: Game = module.GAME
        if game.id != gid:
            raise RuntimeError(f"games/{gid}.py names its game {game.id!r}")
        games[gid] = game
    return games


GAMES: dict[str, Game] = _load()


def get_game(game_id: str) -> Game | None:
    return GAMES.get(game_id)
