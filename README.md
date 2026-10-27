# 4d-fixed-bugs

A dataset of 2,467 fixed 4D software bugs crawled from
[bugs.4d.com](https://bugs.4d.com), each with an ACI reference ID, an
English summary (with markdown links to the relevant
[developer.4d.com](https://developer.4d.com) command docs), the 4D
commands involved, and the versions the fix shipped in.

On top of that dataset, this repo also builds a fully static,
client-side semantic search chat app — no backend, nothing leaves your
browser. It embeds every localized bug summary offline with the same pinned,
text-only EmbeddingGemma 2 (270M) model, then lets you ask natural-language
questions (or search by version, exact command name, or ACI ID) and
get back the most relevant bug reports, ranked by similarity, entirely
in-browser.

**Live app:** https://miyako.github.io/4d-fixed-bugs/ ·
**日本語版:** https://miyako.github.io/4d-fixed-bugs/ja/ (Japanese summaries
written from the English summaries and 4D Japan's original release notes)
· **Français:** https://miyako.github.io/4d-fixed-bugs/fr/ (full French
summaries translated only from canonical English). French commands, code and
documentation links stay exactly as in English.

All three languages use [EmbeddingGemma 2](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX)
with one shared 768-dimensional search contract and an exact-version official
CDN browser runtime, checked against pinned upstream hashes during the build.
Semantic search starts automatically on WebGPU; explicitly labeled
keyword search stays usable while the model downloads or if WebGPU/model
inference or CDN loading fails. ACI lookup, exact command matching and version
filtering remain available. No query is sent to a server. See `UPDATING.md` for integrity
checks, retrieval evaluation and independently calibrated score cutoffs.
On 43 aligned queries per language, recall@8 is 100% English and 97.67% French
and Japanese. This is not baseline parity: French improves overall, while
English top-one ranking/MRR decline and Japanese loses one top-eight hit.
See `ARCHITECTURE.md` for measured tradeoffs and durable comparison reports.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for a full technical writeup
of how the app works (data model, embedding pipeline, retrieval logic,
rendering, deployment) — detailed enough to rebuild it from scratch,
and [`UPDATING.md`](UPDATING.md) for how to refresh the dataset when 4D
ships new fixes.
