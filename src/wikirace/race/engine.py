"""The race: lanes run concurrently, and every change is an event.

A race is a background task owned by this process. It keeps running when the
page that started it is closed, and a page opened later attaches to it: the
event stream begins with a snapshot of the whole race and continues with every
change after it.

The state is plain JSON — the snapshot IS the stored replay IS what the page
renders — and it changes only through `patch_lane`, `add_step` and `patch_race`,
each of which emits the matching event. The page applies those events with a
pure reducer (static/state.js, `applyEvent`), so the two cannot disagree about
what a change means. Everything here runs on the event loop's thread: nothing
outside it may touch a race (the API's handlers are `async` for exactly that
reason).

Events, as SSE `data:` JSON:
  {"type": "snapshot", "race": {...}}               first, on every connection
  {"type": "lane", "lane": i, "patch": {...}}       fields of lane i changed
  {"type": "step", "lane": i, "step": {...}}        lane i took a turn (a move or a foul)
  {"type": "race", "patch": {...}}                  race-level fields changed
  {"type": "end"}                                   the race is over; the stream closes

`end` is written by each stream, never logged: see `_finalize`.

**Persistence** is one writer per race, off the loop. Every move marks the race
dirty; the writer serialises the latest state ON the loop (a consistent copy)
and writes it in a thread, again and again until it is clean — coalescing moves
that land while a write is in flight, never writing an older state over a newer
one, and retrying with backoff when the database is busy. A finished race stays
in memory until its final state is written, so History never shows a race that
ended as still running.
"""
from __future__ import annotations

import asyncio
import json
import random
import time
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from .. import store
from .racers import Choice, DeadEnd, RacerError
from .rules import ENDED, LinkIndex, Turn, foul_note, judge, rank, shown_links
from .wiki import Lookup, Page, PageMissing, Wiki, WikiError, fold, normalize_title

#: Races that may run at once, unless the caller says (WIKIRACE_MAX_RACES).
#: Each is up to four models spending tokens; a double-clicked Start should not
#: be able to make it eight.
MAX_LIVE = 2
#: A silent stream gets a comment line this often, so nothing between here and
#: the browser decides the connection is dead while a thinking model is quiet.
KEEPALIVE_S = 15.0
#: One quick retry for an outage (a 5xx, a timeout, an empty reply).
_RETRY_DELAY_S = 3.0
#: A rate limit (HTTP 429) is waited out instead: the gap before each new try,
#: stretched by up to a quarter so two racers on one provider do not knock in
#: step, or the provider's Retry-After when that is longer. About two minutes
#: in all; then the racer stops, in the provider's words.
_RATE_LIMIT_WAITS_S = (5.0, 15.0, 30.0, 60.0)
#: A Retry-After past this is a limit that will not lift while the race runs:
#: the racer stops at once rather than sit waiting for it.
_RATE_LIMIT_MAX_WAIT_S = 120.0
#: A finished race stays attached this long after its final write, so a page
#: that connects just after the end still reads it from memory.
_LINGER_S = 120.0
#: Dead links one racer may hit on one article before its lane is called off.
_MAX_DEAD_LINKS = 5
#: The writer's backoff on a busy database, doubling to the cap.
_WRITE_BACKOFF_S = (0.5, 30.0)
#: Give up on the final write after this many failures; the race then leaves
#: memory anyway and a restart stamps it interrupted.
_MAX_WRITE_FAILURES = 12


class TooManyRaces(RuntimeError):
    pass


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _epoch_ms() -> int:
    return int(time.time() * 1000)


def _fmt_s(seconds: float) -> str:
    """45s · 2m · 1m 52s · 1h 5m — for a note a person reads."""
    s = max(0, round(seconds))
    if s < 60:
        return f"{s}s"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m}m {s}s" if s else f"{m}m"
    h, m = divmod(m, 60)
    return f"{h}h {m}m" if m else f"{h}h"


def _rate_limit_gap(exc: RacerError, gap: float | None, limited: int, started: float, deadline: float) -> float:
    """How long a rate-limited racer waits before its next try — or the error
    that stops it: the waits are used up, the provider asks for longer than a
    racer waits, or the race's time limit would pass first."""
    if gap is None:
        spent = _fmt_s(time.monotonic() - started)
        raise RacerError(f"{exc} — still rate-limited after {limited} tries over {spent}") from exc
    if exc.retry_after is not None and exc.retry_after > _RATE_LIMIT_MAX_WAIT_S:
        raise RacerError(f"{exc} — it asks for {_fmt_s(exc.retry_after)}, longer than a racer waits") from exc
    gap = max(gap * (1 + random.random() / 4), exc.retry_after or 0.0)
    if time.monotonic() + gap >= deadline:
        raise RacerError(f"{exc} — rate-limited, with the time limit before the next try") from exc
    return gap


@dataclass
class LaneSpec:
    """A racer and how to show it. Built by the API from a model key."""

    key: str
    label: str
    provider: str
    model_id: str
    kind: str
    #: The thinking level the racer runs on (None: none sent).
    thinking: str | None
    racer: Any
    #: What the person asked for (None: the configured level), kept so "Race
    #: again" asks for the same thing rather than what it became.
    thinking_request: str | None = None


def _new_lane(i: int, spec: LaneSpec, start: str) -> dict[str, Any]:
    return {
        "index": i, "key": spec.key, "label": spec.label, "provider": spec.provider,
        "model_id": spec.model_id, "kind": spec.kind, "thinking": spec.thinking,
        "thinking_request": spec.thinking_request,
        "status": "waiting", "note": None, "page": start,
        "hops": 0, "strikes": 0, "revisits": 0,
        "fouls": {"off_page": 0, "teleport": 0, "no_pick": 0},
        "tokens_in": 0, "tokens_out": 0, "cost": None, "cost_estimated": False,
        "think_ms": 0, "elapsed_ms": None, "turn_started_ms": None,
        "finish_order": None, "rank": None, "steps": [],
    }


class LiveRace:
    def __init__(
        self, *, state: dict[str, Any], racers: list[Any], start_page: Page, wiki: Wiki,
        db_path: str, target_aliases: Sequence[str] = (),
    ) -> None:
        self.state = state
        self.racers = racers
        self.start_page = start_page
        self.wiki = wiki
        self.db_path = db_path
        #: Every event so far, already framed for SSE — serialised once, however
        #: many pages are watching.
        self.events: list[str] = []
        self.done = False
        self.task: asyncio.Task[None] | None = None
        self._tick = asyncio.Event()
        self._t0 = time.monotonic()
        self._lanes: list[asyncio.Task[None]] = []
        self._stop_requested = False
        self._finishers = 0
        self._indexes: dict[tuple[str, int], LinkIndex] = {}
        # The target's names, folded, canonical title first: the title, what
        # the person typed, and every redirect to it.
        target = state["target"]
        names = [target["title"], target.get("input") or "", *target_aliases]
        self._target_keys = tuple(dict.fromkeys(fold(n) for n in names if n))
        self._target_title = normalize_title(target["title"])
        self._dirty = False
        self._writer: asyncio.Task[None] | None = None
        self._write_failures = 0
        self._lingering = False

    @property
    def id(self) -> str:
        return str(self.state["id"])

    # ── events ──

    def _emit(self, event: dict[str, Any]) -> None:
        self.events.append(f"data: {json.dumps(event)}\n\n")
        self._wake()

    def _wake(self) -> None:
        tick, self._tick = self._tick, asyncio.Event()
        tick.set()

    def patch_lane(self, i: int, **fields: Any) -> None:
        self.state["lanes"][i].update(fields)
        self._emit({"type": "lane", "lane": i, "patch": fields})

    def add_step(self, i: int, step: dict[str, Any]) -> None:
        self.state["lanes"][i]["steps"].append(step)
        self._emit({"type": "step", "lane": i, "step": step})

    def patch_race(self, **fields: Any) -> None:
        self.state.update(fields)
        self._emit({"type": "race", "patch": fields})

    def snapshot(self) -> tuple[int, str]:
        """How many events the snapshot covers, and the snapshot frame. Taken in
        one synchronous step, so no event can fall between the two."""
        return len(self.events), f"data: {json.dumps({'type': 'snapshot', 'race': self.state})}\n\n"

    async def wait(self, seen: int, timeout: float) -> bool:
        """Until there is an event past *seen*, or the race is over. False when
        *timeout* passed with nothing new — the caller's cue to send a keepalive."""
        if len(self.events) > seen or self.done:
            return True
        tick = self._tick
        try:
            await asyncio.wait_for(tick.wait(), timeout)
        except TimeoutError:
            return False
        return True

    # ── persistence: one writer, off the loop ──

    def _save(self) -> None:
        self._dirty = True
        if self._writer is None or self._writer.done():
            self._writer = asyncio.get_running_loop().create_task(
                self._write_loop(), name=f"wikirace-{self.id}-save"
            )

    async def _write_loop(self) -> None:
        delay = _WRITE_BACKOFF_S[0]
        while self._dirty:
            self._dirty = False
            row = store.serialize(self.state)  # on the loop: a consistent copy
            try:
                await asyncio.to_thread(store.write, self.db_path, row)
                self._write_failures = 0
                delay = _WRITE_BACKOFF_S[0]
            except Exception:  # noqa: BLE001 - a busy or broken DB must not stop a race
                self._write_failures += 1
                if self.done and self._write_failures >= _MAX_WRITE_FAILURES:
                    break
                self._dirty = True
                await asyncio.sleep(delay)
                delay = min(delay * 2, _WRITE_BACKOFF_S[1])
        if self.done:
            self._linger()

    def _linger(self) -> None:
        if self._lingering:
            return
        self._lingering = True
        asyncio.get_running_loop().call_later(_LINGER_S, _LIVE.pop, self.id, None)

    async def flushed(self) -> None:
        """Until every change so far is written. For tests and shutdown."""
        while self._writer is not None and not self._writer.done():
            await asyncio.shield(self._writer)

    # ── lifecycle ──

    def start(self) -> None:
        self.task = asyncio.create_task(self._run(), name=f"wikirace-{self.id}")

    def stop(self) -> None:
        """Stop every lane. Must be called on the loop's thread."""
        self._stop_requested = True
        for task in self._lanes:
            task.cancel()

    def _elapsed_ms(self) -> int:
        return int((time.monotonic() - self._t0) * 1000)

    async def _run(self) -> None:
        self._t0 = time.monotonic()
        self._lanes = [
            asyncio.create_task(self._run_lane(i), name=f"wikirace-{self.id}-{i}")
            for i in range(len(self.racers))
        ]
        try:
            await asyncio.gather(*self._lanes, return_exceptions=True)
        except asyncio.CancelledError:
            # The process is going down, or someone cancelled the race task
            # itself: take the lanes with it, then record what was reached.
            for task in self._lanes:
                task.cancel()
            await asyncio.gather(*self._lanes, return_exceptions=True)
            self._stop_requested = True
            raise
        finally:
            self._finalize("stopped" if self._stop_requested else "finished")

    def _finalize(self, status: str) -> None:
        lanes = self.state["lanes"]
        for ln in lanes:
            if ln["status"] not in ENDED:
                self._end(ln["index"], "stopped", "stopped before it finished")
        order = rank(lanes)
        for pos, idx in enumerate(order, start=1):
            self.patch_lane(idx, rank=pos)
        self.patch_race(
            status=status, finished_at=_now_iso(), ranking=order, winner=order[0] if order else None
        )
        # No `end` in the log: each stream writes its own once `done` is set and
        # it has drained the log. A logged `end` would be swallowed by the
        # snapshot of anyone attaching after the finish — who then never hears
        # the race is over.
        self.done = True
        self._wake()
        self._save()  # the writer lets the race leave memory once this lands

    # ── one lane ──

    def _end(self, i: int, status: str, note: str | None) -> None:
        patch: dict[str, Any] = {
            "status": status, "note": note, "elapsed_ms": self._elapsed_ms(), "turn_started_ms": None,
        }
        if status == "finished":
            self._finishers += 1
            patch["finish_order"] = self._finishers
        self.patch_lane(i, **patch)
        self._save()

    async def _run_lane(self, i: int) -> None:
        try:
            await self._play(i)
        except asyncio.CancelledError:
            if self.state["lanes"][i]["status"] not in ENDED:
                self._end(i, "stopped", "stopped")
            raise
        except Exception as exc:  # noqa: BLE001 - a bug ends this lane, never the race
            if self.state["lanes"][i]["status"] not in ENDED:
                self._end(i, "error", f"{type(exc).__name__}: {exc}")

    def _index(self, page: Page, max_links: int) -> LinkIndex:
        """The links a racer may pick on *page*: the ones it was shown."""
        key = (page.title, max_links)
        idx = self._indexes.get(key)
        if idx is None:
            idx = self._indexes[key] = LinkIndex(shown_links(page, max_links))
        return idx

    def _path(self, i: int) -> list[str]:
        path = [self.state["start"]["title"]]
        path += [s["to"] for s in self.state["lanes"][i]["steps"] if s["verdict"] == "ok" and s["to"]]
        return path

    async def _choose(self, i: int, turn: Turn, deadline: float) -> Choice:
        """One quick retry for an outage; a rate limit is waited out, longer and
        in plain sight: the lane says it is rate-limited and when it tries next,
        and the wait is not thinking time. Anything else is final."""
        started = time.monotonic()
        waits = iter(_RATE_LIMIT_WAITS_S)
        limited, retried_outage = 0, False
        while True:
            try:
                return await self.racers[i].choose(turn)
            except RacerError as exc:
                if not exc.retryable or (not exc.rate_limited and retried_outage):
                    raise
                if not exc.rate_limited:
                    retried_outage = True
                    await asyncio.sleep(_RETRY_DELAY_S)
                    continue
                limited += 1
                gap = _rate_limit_gap(exc, next(waits, None), limited, started, deadline)
                self.patch_lane(
                    i, status="rate_limited", turn_started_ms=None,
                    note=f"{self.state['lanes'][i]['provider']} rate limit — trying again in {_fmt_s(gap)}"
                         f" (try {limited + 1} of {len(_RATE_LIMIT_WAITS_S) + 1})",
                )
                await asyncio.sleep(gap)
                self.patch_lane(i, status="thinking", turn_started_ms=_epoch_ms(), note=None)

    async def _lookup(self, title: str) -> Lookup | None:
        try:
            return await self.wiki.lookup(title)
        except WikiError:
            return None

    @staticmethod
    def _account(lane: dict[str, Any], choice: Choice) -> dict[str, Any]:
        cost = lane["cost"]
        if choice.cost is not None:
            cost = (cost or 0.0) + choice.cost
        return {
            "tokens_in": lane["tokens_in"] + choice.tokens_in,
            "tokens_out": lane["tokens_out"] + choice.tokens_out,
            "cost": cost,
            "cost_estimated": bool(lane["cost_estimated"] or (choice.cost is not None and choice.cost_estimated)),
            "think_ms": lane["think_ms"] + choice.latency_ms,
        }

    async def _play(self, i: int) -> None:
        lane = self.state["lanes"][i]
        rules = self.state["rules"]
        target = self.state["target"]
        page = self.start_page
        fouls_here: list[str] = []
        dead_here: list[str] = []
        deadline = self._t0 + rules["time_limit_s"]

        while True:
            if lane["hops"] >= rules["max_hops"]:
                return self._end(i, "dnf", f"out of hops — all {rules['max_hops']} used")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return self._end(i, "dnf", "out of time")
            path = self._path(i)
            followed = [s["link"] for s in lane["steps"] if s["verdict"] == "ok" and s.get("link")]
            turn = Turn(
                target=target["title"], target_description=target.get("description") or "",
                page=page, hop=lane["hops"] + 1, max_hops=rules["max_hops"], path=tuple(path),
                fouls=tuple(fouls_here), strikes=lane["strikes"], max_strikes=rules["strikes"],
                max_links=rules["max_links"], excluded=tuple(dict.fromkeys(dead_here + followed)),
            )
            self.patch_lane(i, status="thinking", page=page.title, turn_started_ms=_epoch_ms())
            try:
                choice = await asyncio.wait_for(self._choose(i, turn, deadline), timeout=remaining)
            except TimeoutError:
                return self._end(i, "dnf", "out of time")
            except DeadEnd as exc:
                return self._end(i, "dnf", str(exc))
            except RacerError as exc:
                return self._end(i, "error", str(exc))

            verdict = judge(
                choice.claimed, choice.variants, self._index(page, rules["max_links"]), self._target_keys
            )
            totals = self._account(lane, choice)
            step: dict[str, Any] = {
                "turn": len(lane["steps"]) + 1, "from": page.title, "links": len(page.links),
                "claimed": choice.claimed, "reason": choice.reason, "verdict": verdict.kind,
                "link": verdict.link, "to": None, "note": None, "revisit": False,
                "tokens_in": choice.tokens_in, "tokens_out": choice.tokens_out,
                "cost": choice.cost, "latency_ms": choice.latency_ms,
                "at_ms": self._elapsed_ms(), "detail": choice.detail or None,
            }

            if verdict.kind == "ok":
                # The pick is legal; the next article still has to load. Shown,
                # so a slow fetch never reads as a slow model.
                self.patch_lane(i, status="moving", turn_started_ms=None)
                try:
                    nxt = await self.wiki.page(verdict.link or "")
                except PageMissing:
                    # Linked, but no article behind it (deleted since the page
                    # was cached). Not the racer's fault: no strike, pick again —
                    # and a ranking racer is never offered it again.
                    note = f"“{verdict.link}” is linked but has no article behind it — pick another link"
                    step.update(verdict="dead_link", note=note)
                    fouls_here.append(note)
                    dead_here.append(verdict.link or "")
                    self.add_step(i, step)
                    self.patch_lane(i, **totals)
                    if len(dead_here) >= _MAX_DEAD_LINKS:
                        return self._end(i, "error", f"{len(dead_here)} dead links on “{page.title}”")
                    continue
                except WikiError as exc:
                    self.add_step(i, step)
                    self.patch_lane(i, **totals)
                    return self._end(i, "error", f"Wikipedia: {exc}")
                visited = {normalize_title(p) for p in path}
                step.update(to=nxt.title, revisit=normalize_title(nxt.title) in visited)
                self.add_step(i, step)
                patch = {**totals, "hops": lane["hops"] + 1, "page": nxt.title}
                if step["revisit"]:
                    patch["revisits"] = lane["revisits"] + 1
                self.patch_lane(i, **patch)
                # Canonical titles on both sides, compared exactly: MediaWiki is
                # case-sensitive after the first letter ("Red dwarf" the star is
                # not "Red Dwarf" the sitcom).
                if normalize_title(nxt.title) == self._target_title:
                    return self._end(i, "finished", None)
                page, fouls_here, dead_here = nxt, [], []
                self._save()
                continue

            # A foul. Off-page picks are looked up, so the log can say whether the
            # racer named a real article or invented one — and so a title that
            # merely REDIRECTS to the target is caught as the teleport it is.
            kind, exists, hidden_of = verdict.kind, None, None
            variants = choice.variants or ((choice.claimed,) if choice.claimed else ())
            if rules["max_links"] and kind in ("off_page", "teleport") and variants:
                # On the article, but past the cap the racer was shown: still a
                # foul (the rules say pick from the list), and said as such —
                # "not linked from here" would be false.
                full = LinkIndex(page.links)
                if full.match(variants) or (kind == "teleport" and full.find_any(self._target_keys)):
                    kind, hidden_of = "off_page", rules["max_links"]
            if kind == "off_page" and hidden_of is None and choice.claimed:
                look = await self._lookup(choice.claimed)
                if look is not None:
                    exists = look.exists
                    if look.exists and normalize_title(look.title) == self._target_title:
                        kind = "teleport"
            cut_off = (choice.detail or {}).get("stop_reason") in ("max_tokens", "length")
            note = foul_note(kind, choice.claimed, page.title, exists=exists, hidden_of=hidden_of,
                             cut_off=cut_off)
            step.update(verdict=kind, note=note)
            strikes = lane["strikes"] + 1
            self.add_step(i, step)
            self.patch_lane(
                i, **totals, strikes=strikes, fouls={**lane["fouls"], kind: lane["fouls"][kind] + 1}
            )
            if strikes >= rules["strikes"]:
                return self._end(i, "dq", f"disqualified — {strikes} foul{'s' if strikes != 1 else ''}")
            fouls_here.append(note)
            self._save()


_LIVE: dict[str, LiveRace] = {}


def get_live(race_id: str) -> LiveRace | None:
    return _LIVE.get(race_id)


def forget(race_id: str) -> None:
    """Drop a race from memory (a deleted race must not keep being served)."""
    _LIVE.pop(race_id, None)


def running_count() -> int:
    return sum(1 for r in _LIVE.values() if not r.done)


def live_races() -> list[LiveRace]:
    return list(_LIVE.values())


def start_race(
    *, db_path: str, wiki: Wiki, start_page: Page, start_input: str, target: Lookup,
    target_input: str, rules: dict[str, Any], lanes: list[LaneSpec],
    target_aliases: Sequence[str] = (), max_live: int = MAX_LIVE,
) -> LiveRace:
    """Create a race, record it, and set it running. Returns at once. Must be
    called on the loop's thread."""
    if running_count() >= max_live:
        raise TooManyRaces(
            f"{max_live} race{'s are' if max_live != 1 else ' is'} already running"
            " — stop one or let it finish first"
        )
    state: dict[str, Any] = {
        "id": uuid.uuid4().hex[:12],
        "status": "running",
        "start": {
            "title": start_page.title, "description": start_page.description,
            "input": start_input, "links": len(start_page.links),
        },
        "target": {"title": target.title, "description": target.description, "input": target_input},
        "rules": dict(rules),
        "created_at": _now_iso(),
        "started_ms": _epoch_ms(),
        "finished_at": None,
        "ranking": [],
        "winner": None,
        "lanes": [_new_lane(i, spec, start_page.title) for i, spec in enumerate(lanes)],
    }
    race = LiveRace(
        state=state, racers=[spec.racer for spec in lanes], start_page=start_page,
        wiki=wiki, db_path=db_path, target_aliases=target_aliases,
    )
    _LIVE[race.id] = race
    race._save()
    race.start()
    return race
