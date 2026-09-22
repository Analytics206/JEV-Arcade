"""`wikirace` on the command line: what it says before it serves.

A person starting the server should see, without opening the page, which
settings file was read and which providers can race, with the fix for the
ones that cannot. It never prints a key.
"""
from __future__ import annotations

import pytest

from wikirace.__main__ import main, summary
from wikirace.config import load_settings


def test_the_summary_names_the_file_the_providers_and_the_fixes():
    s = load_settings({"OPENAI_API_KEY": "sk-secret-value", "OPENAI_MODELS": "gpt-4.1-mini@low",
                       "OLLAMA_BASE_URL": "http://192.168.1.20:11434", "WIKIRACE_THINKING": "bogus"},
                      read_file=False)
    text = summary(s, "127.0.0.1", 8000)
    assert "http://localhost:8000" in text
    assert "environment only" in text
    assert "OpenAI" in text and "gpt-4.1-mini" in text
    assert "set ANTHROPIC_API_KEY in .env" in text
    assert "http://192.168.1.20:11434" in text and "every model it has" in text
    assert "! WIKIRACE_THINKING" in text
    assert "sk-secret-value" not in text


def test_version_and_help_exit_cleanly(capsys):
    for flag in ("--version", "--help"):
        with pytest.raises(SystemExit) as exc:
            main([flag])
        assert exc.value.code == 0
    assert "wikirace" in capsys.readouterr().out


def test_a_password_in_a_url_is_never_printed():
    s = load_settings({"OLLAMA_BASE_URL": "http://alice:hunter2@ollama.lan:11434"}, read_file=False)
    text = summary(s, "127.0.0.1", 8000)
    assert "hunter2" not in text and "alice" not in text and "http://ollama.lan:11434" in text


def test_in_docker_the_summary_says_where_it_listens_not_a_url_it_cannot_know():
    s = load_settings({"WIKIRACE_IN_DOCKER": "1"}, read_file=False)
    text = summary(s, "0.0.0.0", 8000)
    assert "in this container" in text and "http://localhost:8000" not in text
