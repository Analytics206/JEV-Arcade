"""The Arcade: games beside WikiRace, each showing one thing Jev does well.

Every game is one module here (registry.py says what a module holds), run by
the same machinery: players (players.py), a streamed background run (runs.py),
its history (store.py) and the HTTP API (api.py). `core.py` is the pure part
they share: Jev's questions and answers, reading a text model, and cost.
"""
