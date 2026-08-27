# 4d-fixed-bugs

A dataset of 2,420 fixed 4D software bugs crawled from
[bugs.4d.com](https://bugs.4d.com), each with an ACI reference ID, an
English summary (with markdown links to the relevant
[developer.4d.com](https://developer.4d.com) command docs), the 4D
commands involved, and the versions the fix shipped in.

On top of that dataset, this repo also builds a fully static,
client-side semantic search chat app — no backend, nothing leaves your
browser. It embeds every bug summary offline with a small
sentence-transformer model, then lets you ask natural-language
questions (or search by version, exact command name, or ACI ID) and
get back the most relevant bug reports, ranked by similarity, entirely
in-browser.

**Live app:** https://miyako.github.io/4d-fixed-bugs/

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for a full technical writeup
of how the app works (data model, embedding pipeline, retrieval logic,
rendering, deployment) — detailed enough to rebuild it from scratch.
