"""Settings: one `.env` for both ways of running, read the way Compose reads it.

* **The file and the environment agree with Docker Compose.** The same `.env`
  is read by `wikirace` and handed to the container by `env_file`, so a value
  must mean the same thing to both: quotes, `export`, ` #` comments.
* **The environment wins, but an empty variable does not hide the file.**
* **Nothing here stops a race over a typo.** A bad thinking level or number is
  ignored with a warning the page shows, never an exception at startup.
"""
from __future__ import annotations

from wikirace.config import THINKING_LEVELS, display_url, load_settings, parse_models, read_env_file


def _load(env=None, **kw):
    return load_settings(env or {}, read_file=False, **kw)


def test_env_file_lines_read_like_docker_compose(tmp_path):
    f = tmp_path / ".env"
    f.write_text(
        "# a comment\n"
        "\n"
        "PLAIN=value\n"
        "export EXPORTED=yes\n"
        "SPACED = padded  \n"
        'DOUBLE="has # hash and \\"quotes\\""\n'
        "SINGLE='kept $AS_IS'\n"
        "INLINE=value # comment\n"
        "HASHED=abc#def\n"
        "EMPTY=\n"
        "not an assignment\n"
        "1BAD=x\n",
        encoding="utf-8",
    )
    vals = read_env_file(f)
    assert vals["PLAIN"] == "value" and vals["EXPORTED"] == "yes" and vals["SPACED"] == "padded"
    assert vals["DOUBLE"] == 'has # hash and "quotes"'
    assert vals["SINGLE"] == "kept $AS_IS"
    assert vals["INLINE"] == "value" and vals["HASHED"] == "abc#def"
    assert vals["EMPTY"] == ""
    assert "1BAD" not in vals and len(vals) == 8


def test_the_environment_wins_over_the_file_but_not_when_it_is_empty(tmp_path):
    f = tmp_path / "wikirace.env"
    f.write_text("OPENAI_API_KEY=from-file\nANTHROPIC_API_KEY=from-file\n", encoding="utf-8")
    s = load_settings({"OPENAI_API_KEY": "from-env", "ANTHROPIC_API_KEY": ""}, env_file=str(f))
    assert s.env_file == str(f)
    assert s.providers["openai"].api_key == "from-env" and s.providers["openai"].key_source == "environment"
    assert s.providers["anthropic"].api_key == "from-file" and s.providers["anthropic"].key_source == ".env"


def test_the_env_file_can_be_named_by_a_variable(tmp_path):
    f = tmp_path / "other.env"
    f.write_text("WIKIRACE_PORT=9123\n", encoding="utf-8")
    assert load_settings({"WIKIRACE_ENV_FILE": str(f)}).port == 9123


def test_a_missing_named_env_file_is_a_warning_not_a_crash(tmp_path):
    s = load_settings({}, env_file=str(tmp_path / "nope.env"))
    assert s.env_file is None and any("nope.env" in w for w in s.warnings)


def test_defaults_with_nothing_set():
    s = _load()
    assert (s.host, s.port, s.db_path, s.thinking, s.max_races) == ("127.0.0.1", 8000, "data/wikirace.db", None, 2)
    assert list(s.providers) == ["anthropic", "openai", "openrouter", "ollama", "typesafe"]
    # A provider with a key to set is off until it is set, and says which.
    assert not s.providers["anthropic"].configured
    assert s.providers["anthropic"].problem == "set ANTHROPIC_API_KEY in .env"
    # Ollama needs no key: a URL is enough, and localhost is the default.
    ollama = s.providers["ollama"]
    assert ollama.configured and ollama.base_url == "http://localhost:11434" and ollama.models == ()
    assert [m.model_id for m in s.providers["typesafe"].models] == ["jev-1.13.0"]
    assert s.providers["typesafe"].kind == "judgment"


def test_a_provider_is_ready_once_its_key_is_set():
    s = _load({"ANTHROPIC_API_KEY": "sk-ant-x"})
    assert s.providers["anthropic"].configured and s.providers["anthropic"].problem is None


def test_models_and_their_thinking_levels():
    warnings: list[str] = []
    models = parse_models("gpt-4.1-mini, o4-mini@HIGH,\n o3 , gpt-4.1-mini, odd@ultra", "X", warnings)
    assert [(m.model_id, m.thinking) for m in models] == [
        ("gpt-4.1-mini", None), ("o4-mini", "high"), ("o3", None), ("odd@ultra", None),
    ]
    assert len(warnings) == 1 and "ultra" in warnings[0]


def test_ollama_names_keep_their_colons_and_openrouter_ids_their_slashes():
    s = _load({"OLLAMA_MODELS": "qwen3.5:9b@low, hf.co/org/model:Q4_K_M", "OPENROUTER_API_KEY": "k",
               "OPENROUTER_MODELS": "deepseek/deepseek-r1:free@high"})
    assert [(m.model_id, m.thinking) for m in s.providers["ollama"].models] == [
        ("qwen3.5:9b", "low"), ("hf.co/org/model:Q4_K_M", None),
    ]
    assert [(m.model_id, m.thinking) for m in s.providers["openrouter"].models] == [
        ("deepseek/deepseek-r1:free", "high"),
    ]


def test_a_racers_level_comes_from_the_nearest_setting():
    s = _load({
        "WIKIRACE_THINKING": "low", "OPENAI_THINKING": "medium", "OPENAI_API_KEY": "k",
        "OPENAI_MODELS": "o3@high, o4-mini",
    })
    assert s.thinking_for("openai", "o3") == "high"          # the model's @level
    assert s.thinking_for("openai", "o4-mini") == "medium"   # the provider's
    assert s.thinking_for("anthropic", "claude-opus-5") == "low"  # everyone's
    assert _load().thinking_for("openai", "o3") is None       # nothing: nothing is sent


def test_bad_values_fall_back_with_a_warning():
    s = _load({"WIKIRACE_THINKING": "ludicrous", "WIKIRACE_PORT": "eighty", "WIKIRACE_MAX_RACES": "99",
               "OLLAMA_NUM_CTX": "12"})
    assert s.thinking is None and s.port == 8000 and s.max_races == 2
    assert s.providers["ollama"].num_ctx == 16384
    assert len(s.warnings) == 4


def test_every_level_is_accepted_in_any_case():
    for level in THINKING_LEVELS:
        assert _load({"WIKIRACE_THINKING": level.upper()}).thinking == level


def test_in_a_container_an_ollama_on_localhost_is_the_docker_host():
    for url in ("http://localhost:11434", "http://127.0.0.1:11434/", "http://0.0.0.0:11434"):
        s = _load({"WIKIRACE_IN_DOCKER": "1", "OLLAMA_BASE_URL": url})
        assert s.providers["ollama"].base_url == "http://host.docker.internal:11434", url
    lan = _load({"WIKIRACE_IN_DOCKER": "1", "OLLAMA_BASE_URL": "http://192.168.1.20:11434"})
    assert lan.providers["ollama"].base_url == "http://192.168.1.20:11434"
    # Outside a container, localhost is left alone.
    assert _load({"OLLAMA_BASE_URL": "http://localhost:11434"}).providers["ollama"].base_url == "http://localhost:11434"


def test_base_urls_can_be_changed_and_lose_a_trailing_slash():
    s = _load({"OPENAI_BASE_URL": "http://proxy.lan:4000/v1/", "OPENAI_API_KEY": "k"})
    assert s.providers["openai"].base_url == "http://proxy.lan:4000/v1"


def test_an_empty_ollama_url_switches_ollama_off():
    off = _load({"OLLAMA_BASE_URL": ""}).providers["ollama"]
    assert not off.configured and off.problem.startswith("off: set OLLAMA_BASE_URL")
    # Unset is not the same as empty: unset keeps the localhost default.
    assert _load().providers["ollama"].configured


def test_a_url_is_shown_without_its_password_and_the_container_keeps_it():
    s = _load({"OLLAMA_BASE_URL": "http://alice:hunter2@localhost:11434/?token=abc", "WIKIRACE_IN_DOCKER": "1"})
    ollama = s.providers["ollama"]
    assert ollama.base_url == "http://alice:hunter2@host.docker.internal:11434/?token=abc"
    assert ollama.shown_url == "http://host.docker.internal:11434/"
    assert display_url("http://[::1]:11434") == "http://[::1]:11434"


def test_a_url_with_a_broken_port_is_left_for_the_provider_to_refuse():
    s = _load({"OLLAMA_BASE_URL": "http://localhost:114340", "WIKIRACE_IN_DOCKER": "1"})
    assert s.providers["ollama"].base_url == "http://localhost:114340"
    assert display_url("http://localhost:114340") == "(an unreadable URL)"


def test_only_the_images_own_flag_means_docker():
    # A devcontainer or a CI job runs in a container too, where localhost is itself.
    assert _load({"OLLAMA_BASE_URL": "http://localhost:11434"}).in_docker is False
    assert _load({"WIKIRACE_IN_DOCKER": "0"}).in_docker is False


def test_the_page_answers_to_localhost_and_the_names_it_is_given():
    assert _load().allowed_hosts == ("localhost", "127.0.0.1")
    assert _load({"WIKIRACE_ALLOWED_HOSTS": "WikiRace.lan, 192.168.1.20"}).allowed_hosts == (
        "localhost", "127.0.0.1", "wikirace.lan", "192.168.1.20")
    assert _load({"WIKIRACE_ALLOWED_HOSTS": "*"}).allowed_hosts == ("*",)


def test_a_value_that_starts_with_a_hash_is_a_line_switched_off(tmp_path):
    # `KEY=# sk-...` is not a comment: Compose hands the container `# sk-...`.
    # Whoever wrote it meant the provider off, so it is off and greyed out on
    # the page, without a word about it there.
    f = tmp_path / ".env"
    f.write_text("ANTHROPIC_API_KEY=# sk-ant-old\nOPENAI_API_KEY= #sk-old\nOLLAMA_BASE_URL=# http://localhost:11434\n")
    for s in (load_settings({}, env_file=str(f)), _load({"ANTHROPIC_API_KEY": "# sk-ant-old"})):
        anthropic = s.providers["anthropic"]
        assert anthropic.api_key == "" and not anthropic.configured
        assert anthropic.problem == "set ANTHROPIC_API_KEY in .env"
        assert s.warnings == ()
    s = load_settings({}, env_file=str(f))
    assert not s.providers["openai"].configured and not s.providers["ollama"].configured
    # A real key in the environment still wins over a switched-off line in the file.
    assert load_settings({"ANTHROPIC_API_KEY": "sk-ant-live"}, env_file=str(f)).providers["anthropic"].configured


def test_the_canonical_host_is_a_bare_name_answered_to_with_its_twin():
    s = _load({"WIKIRACE_CANONICAL_HOST": "https://JEV-Arcade.com/"})
    assert s.canonical_host == "jev-arcade.com"
    assert s.allowed_hosts == ("localhost", "127.0.0.1", "jev-arcade.com", "www.jev-arcade.com")
    assert _load({"WIKIRACE_CANONICAL_HOST": "www.jev-arcade.com"}).allowed_hosts[2:] == (
        "www.jev-arcade.com", "jev-arcade.com")
    assert _load().canonical_host is None
    bad = _load({"WIKIRACE_CANONICAL_HOST": "not a host"})
    assert bad.canonical_host is None and any("WIKIRACE_CANONICAL_HOST" in w for w in bad.warnings)
