"""Developer-only export of the pinned SentencePiece vocabulary; not an installed-app dependency.

Usage: python scripts/export-punctuation-tokenizer.py /path/to/spe_32k_lc_en.model
Requires sentencepiece==0.2.2. Run Oxfmt on the generated JSON afterwards.
"""

import hashlib
import json
import pathlib
import sys

import sentencepiece

root = pathlib.Path(__file__).resolve().parent.parent
manifest = json.loads((root / "src/services/dictation/punctuation-manifest.json").read_text())
source = pathlib.Path(sys.argv[1])
if hashlib.sha256(source.read_bytes()).hexdigest() != manifest["tokenizerSha256"]:
    raise ValueError("Tokenizer checksum does not match the pinned original")
processor = sentencepiece.SentencePieceProcessor(model_file=str(source))
exported = {
    "model": {
        "type": "Unigram",
        "unk_id": processor.unk_id(),
        "vocab": [
            [processor.id_to_piece(index), processor.get_score(index)]
            for index in range(processor.get_piece_size())
        ],
    },
    "normalizer": {"type": "NFKC"},
    "pre_tokenizer": {
        "type": "Metaspace",
        "replacement": "▁",
        "prepend_scheme": "always",
        "split": True,
    },
    "decoder": {
        "type": "Metaspace",
        "replacement": "▁",
        "prepend_scheme": "always",
    },
    "post_processor": None,
    "added_tokens": [],
    "source": {
        "repository": manifest["repository"],
        "revision": manifest["revision"],
        "file": "spe_32k_lc_en.model",
        "sha256": manifest["tokenizerSha256"],
        "transformation": (
            "SentencePiece vocabulary/scores exported to Unigram JSON; NFKC and metaspace "
            "normalization. Original words are retained by the application, never decoded "
            "from vocabulary pieces."
        ),
    },
    "license": (root / "node_modules/@huggingface/tokenizers/LICENSE").read_text(),
}
(root / "src/services/dictation/punctuation-tokenizer.json").write_text(
    json.dumps(exported, ensure_ascii=False)
)
