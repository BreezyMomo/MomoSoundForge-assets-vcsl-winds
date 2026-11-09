# VCSL 吹奏乐器 / Winds

Self-contained, bilingual VCSL instrument library for [MomoSoundForge](https://github.com/BreezyMomo/MomoSoundForge).

Catalog: https://breezymomo.github.io/MomoSoundForge-assets-vcsl-winds/index.json

Recordings and author SFZ mappings are pinned to [VCSL dfcf4a4](https://github.com/sgossner/VCSL/tree/dfcf4a4918771eee884b96ad4493de82ef84daf6), licensed CC0-1.0. Each release contains the complete instrument graphs, audio dependencies, exact provenance, conversion limitations, declared note coverage and file hashes. Audio never enters Git history.

Authoring sources and reproducible import tools are maintained in [MomoSoundForge-assets](https://github.com/BreezyMomo/MomoSoundForge-assets); the runtime library works independently of every other library. Read [AGENTS.md](AGENTS.md) and the linked maintenance rules before changing resources.

Run the immutable snapshot workflow with a fixed release tag, attachment name and SHA-256, first with publish=false. After the candidate succeeds, run the same commit and attachment with publish=true and its candidate_run_id. The workflow pins application protocol 4f125e21a1f78985aff72e8dd52c5b1e2e049bbc, checks every graph and audio hash, MIDI/velocity coverage and resource budgets, then deploys Pages. Site size must stay below 1 GiB.
