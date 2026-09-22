"""WikiRace rules — the pure half: the prompt, reading a reply, judging a pick.

What matters here is that a foul is called exactly when one happened:

* **A sloppy spelling of a real link is a move, not a foul.** A model that
  writes "amazon Rainforest", wraps the title in `[[…]]`, bolds it, or types a
  hyphen for an en dash has named a link on the page. Calling that a foul would
  make the cheat log measure typography.
* **A title that is not on the page is a foul, however plausible.** Matching is
  forgiving about spelling, never about substance: "Brazil (country)" is not
  "Brazil".
* **Naming the target is a teleport only when the target is not on the page.**
  On the page it is simply the winning move.
"""
from __future__ import annotations

import json
import re

import pytest

from wikirace.race import rules
from wikirace.race.rules import LinkIndex, Turn, judge, parse_reply, title_variants
from wikirace.race.wiki import Page, fold

LINKS = (
    "Manager (baseball)", "Arizona Diamondbacks", "New York Yankees", "Brazil",
    "Amazon rainforest", "World Trade Center (1973–2001)", "Washington, D.C.",
    "'Allo 'Allo!", "AIDS", "Paris", "Titanic (1997 film)", "Yahoo!", "Yahoo",
)
PAGE = Page(title="2001 World Series", description="97th edition", lead="The 2001 World Series was…",
            links=LINKS)


def _judge(text: str, links=LINKS, target="Amazon rainforest", aliases=()):
    reply = parse_reply(text)
    keys = tuple(dict.fromkeys(fold(t) for t in (target, *aliases)))
    return judge(reply.claimed, reply.variants, LinkIndex(links), keys)


# ── Reading a reply ───────────────────────────────────────────────────────────


def test_parse_reply_reads_reason_and_link():
    r = parse_reply("REASON: Arizona links to the southwest.\nLINK: Arizona Diamondbacks")
    assert r.claimed == "Arizona Diamondbacks"
    assert r.reason == "Arizona links to the southwest."


def test_the_last_link_line_wins():
    r = parse_reply("LINK: Brazil\nActually, better:\nLINK: New York Yankees")
    assert r.claimed == "New York Yankees"


def test_decoration_around_the_fields_is_forgiven():
    r = parse_reply("**Reason:** close to the target\n- **LINK**: **Brazil**")
    assert r.claimed == "Brazil"
    assert r.reason.startswith("close to")


def test_a_bare_single_line_is_taken_as_the_title():
    assert parse_reply("Brazil").claimed == "Brazil"


def test_a_reply_with_no_link_names_nothing():
    r = parse_reply("REASON: I would go via South America.\nI am not sure which link to take.")
    assert r.claimed is None
    assert r.reason == "I would go via South America."
    assert parse_reply("").claimed is None


def test_title_variants_peel_markup_and_try_the_literal_spelling_first():
    assert "Brazil" in title_variants("[[Brazil|the country]]")
    assert "Brazil" in title_variants("[Brazil](https://en.wikipedia.org/wiki/Brazil)")
    assert "New York Yankees" in title_variants("https://en.wikipedia.org/wiki/New_York_Yankees#History")
    assert title_variants('"Brazil"') == ('"Brazil"', "Brazil")
    assert title_variants("Brazil.") == ("Brazil.", "Brazil")
    assert rules.display_title("[[Brazil|the country]]") == "Brazil"
    assert rules.display_title("https://en.wikipedia.org/wiki/New_York_Yankees") == "New York Yankees"


# ── Judging a pick ────────────────────────────────────────────────────────────


def test_an_exact_link_is_a_move():
    v = _judge("LINK: Arizona Diamondbacks")
    assert v.kind == "ok" and v.link == "Arizona Diamondbacks"


def test_case_and_dash_slips_still_name_the_link():
    assert _judge("LINK: arizona diamondbacks").link == "Arizona Diamondbacks"
    assert _judge("LINK: World Trade Center (1973-2001)").link == "World Trade Center (1973–2001)"
    assert _judge("LINK: [[Brazil]]").link == "Brazil"


def test_punctuation_that_is_part_of_a_title_is_kept():
    assert _judge("LINK: Washington, D.C.").link == "Washington, D.C."
    assert _judge("LINK: 'Allo 'Allo!").link == "'Allo 'Allo!"
    # One mark at a time, literal first: "Yahoo!." finds "Yahoo!" before "Yahoo".
    assert _judge("LINK: Yahoo!.").link == "Yahoo!"


def test_quotes_punctuation_and_emphasis_in_any_order_are_forgiven():
    # Found in review: each of these cost a strike on a page that links the title.
    assert _judge('LINK: "Paris".').link == "Paris"
    assert _judge("LINK: 'Paris',").link == "Paris"
    assert _judge("LINK: [[Paris]].").link == "Paris"
    assert _judge("LINK: *Titanic (1997 film)*").link == "Titanic (1997 film)"
    assert _judge("LINK: _Paris_").link == "Paris"


def test_the_log_shows_what_the_racer_said():
    assert parse_reply('LINK: "Paris".').claimed == '"Paris".'
    assert parse_reply("LINK: [[Brazil|the country]]").claimed == "Brazil"


def test_an_exact_title_beats_a_case_fold():
    v = judge("AIDS", ("AIDS",), LinkIndex(["Aids", "AIDS"]), set())
    assert v.link == "AIDS"


def test_naming_the_target_when_it_is_on_the_page_is_the_winning_move():
    v = _judge("LINK: Amazon rainforest")
    assert v.kind == "ok" and v.link == "Amazon rainforest"


def test_naming_the_target_when_it_is_not_on_the_page_is_a_teleport():
    v = _judge("LINK: Amazon rainforest", links=("Brazil",))
    assert v.kind == "teleport"
    # The target as the person typed it counts too.
    v = _judge("LINK: Amazon Forest", links=("Brazil",), aliases=("Amazon Forest",))
    assert v.kind == "teleport"


def test_naming_the_target_when_the_page_links_it_by_another_name_is_the_winning_move():
    # Found in review: the page links the towers only as "Twin Towers" (a
    # redirect). Naming the target is not a jump — the page goes there.
    target, aliases = "World Trade Center (1973–2001)", ("Twin Towers", "WTC")
    links = ("Brazil", "Twin Towers")
    v = _judge("LINK: World Trade Center (1973–2001)", links=links, target=target, aliases=aliases)
    assert v.kind == "ok" and v.link == "Twin Towers"
    # One alias named, another linked: the same move.
    v = _judge("LINK: WTC", links=links, target=target, aliases=aliases)
    assert v.kind == "ok" and v.link == "Twin Towers"
    # No name of the target on the page: a jump after all.
    v = _judge("LINK: WTC", links=("Brazil",), target=target, aliases=aliases)
    assert v.kind == "teleport"


def test_a_plausible_title_that_is_not_on_the_page_is_off_page():
    assert _judge("LINK: Brazil (country)").kind == "off_page"
    assert _judge("LINK: South America").kind == "off_page"


def test_no_link_is_no_pick():
    assert _judge("REASON: thinking…").kind == "no_pick"


def test_foul_notes_say_what_happened():
    assert "not among the 100 links you were shown" in rules.foul_note("off_page", "B", "X", hidden_of=100)
    assert "not a Wikipedia article" in rules.foul_note("off_page", "Zzz", "X", exists=False)
    assert "real article" in rules.foul_note("off_page", "Brazil", "X", exists=True)
    assert "no shortcuts" in rules.foul_note("teleport", "Amazon rainforest", "X")
    assert "LINK:" in rules.foul_note("no_pick", None, "X")


# ── The prompt ────────────────────────────────────────────────────────────────


def _turn(**kw) -> Turn:
    base = dict(target="Amazon rainforest", target_description="Large rainforest in South America",
                page=PAGE, hop=2, max_hops=12, path=("Abraham Lincoln", "2001 World Series"))
    return Turn(**{**base, **kw})


def test_the_prompt_names_target_page_path_and_every_link():
    p = rules.turn_prompt(_turn())
    assert "TARGET: Amazon rainforest — Large rainforest in South America" in p
    assert "YOU ARE ON: 2001 World Series" in p
    assert "hop 2 of the 12" in p
    assert "Abraham Lincoln → 2001 World Series" in p
    assert "Already visited (going back only wastes a hop): Abraham Lincoln" in p
    assert f"LINKS ON THIS ARTICLE ({len(LINKS)}):" in p
    assert all(link in p.splitlines() for link in LINKS)


def test_the_prompt_repeats_fouls_on_this_article():
    p = rules.turn_prompt(_turn(fouls=("“Zzz” is not a link",), strikes=1, max_strikes=3))
    assert "FOUL on this article: “Zzz” is not a link" in p
    assert "Fouls: 1 of 3" in p


def test_a_link_cap_shows_the_first_links_in_reading_order():
    p = rules.turn_prompt(_turn(max_links=3))
    assert f"the first 3 of {len(LINKS)}" in p
    assert "Manager (baseball)" in p and "AIDS" not in p.splitlines()


def test_the_system_prompt_states_both_fouls():
    assert "not in that list is a foul" in rules.SYSTEM_PROMPT
    assert "Naming the target" in rules.SYSTEM_PROMPT
    assert "LINK:" in rules.SYSTEM_PROMPT


# ── Ranking and cost ──────────────────────────────────────────────────────────


def test_rank_is_fewest_hops_then_least_thinking():
    lanes = [
        {"index": 0, "status": "finished", "hops": 5, "think_ms": 900, "finish_order": 1},
        {"index": 1, "status": "finished", "hops": 4, "think_ms": 5000, "finish_order": 3},
        {"index": 2, "status": "finished", "hops": 4, "think_ms": 2000, "finish_order": 2},
        {"index": 3, "status": "dq", "hops": 1, "think_ms": 10, "finish_order": None},
    ]
    assert rules.rank(lanes) == [2, 1, 0]


def test_estimates_use_list_prices_and_leave_unknown_models_unpriced():
    assert rules.estimate_cost("claude-opus-5", 1_000_000, 0) == 5.0
    assert rules.estimate_cost("claude-haiku-4-5-20251001", 0, 1_000_000) == 5.0
    assert rules.estimate_cost("claude-fable-5-1", 1_000_000, 0) == 10.0
    assert rules.estimate_cost("gpt-5.5", 1000, 1000) is None


def test_openai_models_are_priced_and_a_sibling_never_borrows_a_price():
    # OpenAI reports no cost either: its models cost what OpenAI lists.
    assert rules.estimate_cost("o3", 1_000_000, 1_000_000) == pytest.approx(2.00 + 8.00)
    assert rules.estimate_cost("gpt-5-mini", 1_000_000, 1_000_000) == pytest.approx(0.25 + 2.00)
    assert rules.estimate_cost("gpt-5-nano-2025-08-07", 1_000_000, 0) == pytest.approx(0.05)
    assert rules.estimate_cost("o4-mini", 1_000_000, 1_000_000) == pytest.approx(1.10 + 4.40)
    assert rules.estimate_cost("gpt-4.1-mini", 1_000_000, 1_000_000) == pytest.approx(0.40 + 1.60)
    # A pinned snapshot is its model…
    assert rules.estimate_cost("o3-2025-04-16", 1_000_000, 0) == pytest.approx(2.00)
    assert rules.estimate_cost("gpt-4.1-mini-2025-04-14", 0, 1_000_000) == pytest.approx(1.60)
    # …a sibling is not: o3-pro lists at ten times o3, o3-mini at about half.
    for model in ("o3-pro", "o3-mini", "o3-deep-research", "claude-opus-5-1"):
        assert rules.estimate_cost(model, 1000, 1000) is None, model
    # A namespaced id is OpenRouter's, which bills its own.
    assert rules.estimate_cost("openai/o3", 1000, 1000) is None


# ── Jev's question ────────────────────────────────────────────────────────────


def test_chunked_never_leaves_a_runt():
    sizes = [len(c) for c in rules.chunked(list(range(101)), 100)]
    assert sizes == [51, 50]
    assert [len(c) for c in rules.chunked(list(range(250)), 100)] == [84, 83, 83]
    # Found in review: a fixed step left 99 × 100 + 1 here.
    big = [len(c) for c in rules.chunked(list(range(9901)), 100)]
    assert max(big) <= 100 and min(big) >= 99 and sum(big) == 9901
    for n in (1, 7, 100, 199, 1234):
        pieces = rules.chunked(list(range(n)), 100)
        assert sum(map(len, pieces)) == n and max(map(len, pieces)) - min(map(len, pieces)) <= 1
    assert rules.chunked([], 100) == []


def test_the_final_question_takes_as_many_of_every_piece_as_it_holds():
    assert rules.jev_keep(2) == 127
    assert rules.jev_keep(5) == 51
    assert rules.jev_keep(300) == 1
    for n in (2, 3, 7, 40):
        assert n * rules.jev_keep(n) <= rules.JEV_MAX_OPTIONS


def test_jev_is_told_the_target_itself_is_the_move():
    # Jev reads the words literally: asked only for the title "most closely
    # related to the target", it passed over the target while the page linked it.
    text = json.dumps(rules.JEV_INSTRUCTIONS)
    assert "If `target_article` itself is one of the options, choose it" in text
    # Every field the question names is one the state carries.
    turn = Turn(target="Anna's Archive", target_description="Shadow library search engine",
                      page=Page("Digital library", "", "", ("Anna's Archive",)), hop=4, max_hops=12,
                      path=("Hayley Williams", "Discogs", "Database", "Digital library"))
    state = rules.jev_state(turn)
    assert state == {"current_article": "Digital library", "target_article": "Anna's Archive",
                     "target_description": "Shadow library search engine"}
    for field in re.findall(r"`(\w+)`", text):
        assert field in state, field


def test_a_jev_question_hides_the_order_and_is_repeatable():
    opts = [f"T{i}" for i in range(20)]
    q1, ids1 = rules.jev_question(opts, "seed")
    q2, ids2 = rules.jev_question(opts, "seed")
    assert ids1 == ids2 and q1 == q2
    assert sorted(ids1.values()) == sorted(opts)
    assert list(ids1.values()) != opts  # shuffled
    assert all(k.startswith("c") for k in ids1)
    assert q1["type"] == "choice" and q1["criteria"] == ids1


def test_a_reply_padded_with_a_sea_of_spaces_is_read_at_once():
    # A lazy pattern that trimmed itself took seconds on this, on the event loop.
    import time

    started = time.perf_counter()
    reply = parse_reply("REASON:" + " " * 60_000 + "why\nLINK: " + " " * 60_000 + "Brazil" + " " * 60_000)
    assert time.perf_counter() - started < 0.5
    assert reply.claimed == "Brazil"


def test_a_title_named_at_length_is_cut():
    reply = parse_reply("LINK: " + "A" * 5000)
    assert reply.claimed is not None and len(reply.claimed) <= 300


def test_a_reply_that_ran_out_of_room_is_told_so():
    assert "ran out of room" in rules.foul_note("no_pick", None, "Page", cut_off=True)
    assert "LINK: line" in rules.foul_note("no_pick", None, "Page")
