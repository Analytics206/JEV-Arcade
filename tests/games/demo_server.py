"""A local Arcade with stand-in players, for working on a game's page without keys.

    uv run python tests/games/demo_server.py            # http://127.0.0.1:8002/?tab=arcade
    uv run python tests/games/demo_server.py --port 8010

The real server and the real page, with these players in place of the real
providers:

* **Jev** (`typesafe:jev-1.13.0`) answers in 0.08 to 0.25 s.
* **Text models** on OpenRouter: `demo/fast` (about a second a reply),
  `demo/steady` (two to three) and `demo/slow` (four to six).

What they answer is up to each game's demo handler, `tests/games/demo/<game>.py`
(see demo/__init__.py); a question no handler claims gets a plausible random
answer. Wikipedia is the real one. History goes to data/arcade-demo.db.
Nothing here is shipped: it lives with the tests.
"""
from __future__ import annotations

import argparse
import asyncio
import random
import sys
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parent))

import demo  # noqa: E402  (tests/games/demo)

from wikirace.app import create_app  # noqa: E402
from wikirace.config import load_settings  # noqa: E402
from wikirace.providers.base import Completion, TextProvider  # noqa: E402
from wikirace.race.wiki import Wiki  # noqa: E402

TEXT_DELAY_S = {"demo/fast": (0.7, 1.4), "demo/steady": (1.8, 3.2), "demo/slow": (4.0, 6.0)}


class DemoJev:
    async def aclose(self) -> None:
        return None

    async def discover(self) -> None:
        return None

    async def ask(self, model, state, questions, *, timeout=60.0):
        await asyncio.sleep(random.uniform(0.08, 0.25))
        answers = {qid: demo.jev_answer(qid, q, state) for qid, q in questions.items()}
        tokens = sum(len(str(q)) for q in questions.values()) // 3 + len(str(state)) // 3
        return {"model": model, "answers": answers, "usage": {"input_tokens": tokens, "output_tokens": 0}}


class DemoText(TextProvider):
    async def complete(self, model, system, prompt, *, thinking, max_tokens, timeout):
        lo, hi = TEXT_DELAY_S.get(model, (1.0, 2.5))
        await asyncio.sleep(random.uniform(lo, hi))
        text = demo.text_reply(model, system, prompt)
        return Completion(text=text, model=model, tokens_in=(len(system) + len(prompt)) // 3,
                          tokens_out=len(text) // 3 + 5, cost=None, stop_reason="stop")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", type=int, default=8002)
    args = ap.parse_args()
    settings = load_settings({
        "OPENROUTER_API_KEY": "sk-or-demo",
        "OPENROUTER_MODELS": ", ".join(TEXT_DELAY_S),
        "TYPESAFE_API_KEY": "ts-demo",
        "WIKIRACE_DB": "data/arcade-demo.db",
        "WIKIRACE_PORT": str(args.port),
    }, read_file=False)
    providers = {pid: DemoText(settings.providers[pid]) for pid in ("anthropic", "openai", "openrouter", "ollama")}
    providers["typesafe"] = DemoJev()
    app = create_app(settings, wiki=Wiki(user_agent=settings.user_agent), providers=providers)
    print(f"Arcade demo: http://127.0.0.1:{args.port}/?tab=arcade")
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
