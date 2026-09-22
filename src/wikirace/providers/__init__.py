"""The five providers, built from the settings.

`build(settings)` makes one provider per provider id in the settings,
configured or not, so the page can say why one cannot race: calling an
unconfigured one raises a final ProviderError naming the variable to set.
`transport` replaces the network for every one of them (the tests hand in an
`httpx.MockTransport`; the Anthropic SDK's httpx2 client is bridged to it).
"""
from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

import httpx

from ..config import Settings
from .anthropic import AnthropicProvider
from .base import Completion, ModelInfo, ProviderError, TextProvider
from .ollama import OllamaProvider
from .openai import OpenAIProvider
from .typesafe import TypeSafe

Provider = TextProvider | TypeSafe

_KINDS: dict[str, Any] = {
    "anthropic": AnthropicProvider,
    "openai": OpenAIProvider,
    "openrouter": OpenAIProvider,
    "ollama": OllamaProvider,
    "typesafe": TypeSafe,
}


def build(settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None) -> dict[str, Provider]:
    """{provider id: provider} for every provider in *settings*."""
    return {
        pid: _KINDS[pid](cfg, transport=transport)
        for pid, cfg in settings.providers.items()
        if pid in _KINDS
    }


async def aclose_all(providers: Mapping[str, Provider]) -> None:
    """Close every provider's connections. One that fails to close does not
    stop the rest: this runs at shutdown."""
    await asyncio.gather(*(p.aclose() for p in providers.values()), return_exceptions=True)


__all__ = [
    "AnthropicProvider",
    "Completion",
    "ModelInfo",
    "OllamaProvider",
    "OpenAIProvider",
    "Provider",
    "ProviderError",
    "TextProvider",
    "TypeSafe",
    "aclose_all",
    "build",
]
