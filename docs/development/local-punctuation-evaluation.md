# Local punctuation model evaluation

## Scope and status

The initial comparison below informed the implemented optional local mode. Cake now exposes
three exclusive processing modes on one **Voice & Dictation** page, with an editable utility
cleanup prompt. Local processing never invokes the utility model and utility mode never invokes
the local model. Installed users need neither Python nor a model conversion tool.

The selected package is the pinned published FP32 model (~210 MB), not the smaller experimental
quantization whose question boundaries regressed. Model weights download only on explicit action;
Cake bundles `onnxruntime-node@1.30.0`, `@huggingface/tokenizers@0.2.0`, and an exported vocabulary.
See [dictation.md](dictation.md) for installation, ownership, streaming policy and verification.

## Candidate and source

- Model: [1-800-BAD-CODE/punctuation_fullstop_truecase_english](https://huggingface.co/1-800-BAD-CODE/punctuation_fullstop_truecase_english)
- Revision: `b26fd1c40e88678859048898218ea4edcc24c84a`
- License stated in its model card: Apache-2.0.
- English punctuation, character-level capitalization, and sentence-boundary classifiers.
- Training domain: news, not hesitant conversational dictation.
- Maximum trained input: 256 subtokens; longer passages need overlapping windows.

| Source file             |       Bytes | SHA-256                                                            |
| ----------------------- | ----------: | ------------------------------------------------------------------ |
| `punct_cap_seg_en.onnx` | 209,532,928 | `dd922d459da618cd324280889740608b76fb3e9e61d3f402291be1251f91421b` |
| `spe_32k_lc_en.model`   |     587,902 | `9e86d0263de80b3b68327a21f5350c8cdf846e4c4400253c9baf05e3d44871c3` |
| `config.yaml`           |         302 | `002ea72d7ef44a6d547b9ca251d6201c20bcf1e0d02e8bb2890141d92b8bfc8e` |

Downloads were pinned to that revision and checked against the source repository's size and LFS
SHA-256 metadata. Two locally generated dynamic INT8 variants were compared with the original.
These are experimental files, not published downloadable packages.

## Method

Apple M4, ARM64 macOS, Python 3.9, ONNX Runtime 1.19.2 CPU execution provider, two intra-op threads
and one inter-op thread. NumPy 1.26.4 and SentencePiece 0.2.2. Quantization used ONNX Runtime's
`quantize_dynamic`, signed INT8 weights, and either `MatMul` plus `Gather` or just `MatMul`.

Each of twelve short English examples received a warmup and twenty timed inference calls. A
separate 256-subtoken window also received a warmup and twenty calls. Timing excludes tokenization
and output reconstruction. Measurements ran during other development/build activity, so these are
feasibility observations, not production latency guarantees. Process peak memory is deliberately
not reported: running conversion and several sessions in one process contaminated the high-water
mark. A production memory benchmark must isolate each inference process from conversion.

## Size and CPU observations

| Variant                  | Model size (decimal MB) | Short-passage median inference        | 256-subtoken median inference           |
| ------------------------ | ----------------------: | ------------------------------------- | --------------------------------------- |
| Original FP32            |                   209.5 | Approximately 3–8 ms in the first run | Approximately 58 ms in the first run    |
| INT8 `MatMul` + `Gather` |                    52.7 | Approximately 2–5 ms                  | Approximately 43 ms in a subsequent run |
| INT8 `MatMul` only       |                   151.8 | Approximately 2–6 ms                  | Approximately 47 ms in a subsequent run |

The tokenizer adds approximately 0.6 MB. Runtime libraries and working memory are additional.
The 52.7 MB variant demonstrates that the requested approximate 100 MB weight budget is feasible,
but does not by itself establish acceptable punctuation quality.

## Observed quality

All three variants produced:

```text
Input:  is this a question that i should
Output: Is this a question that I should?

Input:  is this a question that i should be asking
Output: Is this a question that I should be asking?
```

Thus replacing the punctuation model does not eliminate premature endings by itself. Live output
must remain revisable across audio segments, and terminal punctuation should not be committed
merely because recognition encountered silence.

For a longer continuation, the FP32 model produced:

```text
Is this a question that I should be asking? Yeah, I think it is.
```

Both quantized variants instead produced:

```text
Is this a question that I should be asking, Yeah, I think it is.
```

This is a visible quality regression in a small sample, not a statistical accuracy estimate.
Filler words remained in place, as expected. The model also capitalized `git` as `GIT` and
occasionally capitalized `um` mid-sentence.

The reference-style SentencePiece reconstruction is unsuitable for technical text. Lowercasing
input loses identifier casing; characters absent from the tokenizer's vocabulary become unknown
tokens. In this experiment, `src/main.ts`, a URL, and `postProcessEnabled` were damaged by that
reconstruction. This must not be copied into product code.

## Implementation decisions and validation

1. Apply predicted labels to original source text through trustworthy token/source alignment;
   never reconstruct the user's words from vocabulary pieces. Preserve unknown characters.
2. Keep existing case inside identifiers, paths, URLs, numbers, and other protected spans. Do not
   globally strip punctuation or lowercase the visible/source transcript.
3. Reconsider recognizer-generated sentence separators across audio-segment boundaries while
   protecting meaningful intra-token punctuation.
4. Keep a bounded overlapping recent passage revisable. Withhold tentative terminal punctuation
   while speaking; an audio endpoint must not independently seal the text.
5. Finalize the remaining passage on Enter, and honor existing manual-edit/focus/mute generations.
6. Validate paused-question continuation and technical text with the production tokenizer/runtime,
   bounded-window tests and Electron input tests. Quantization accuracy was compared before choosing
   FP32. Isolated runtime results, including tokenization/projection, are recorded below; physical
   microphone quality and resource interference with a real Core ML recognizer remain user/device
   evaluation rather than claims derived from fake recognition fixtures.
7. Establish a distributable pinned model package and native CPU runtime without Python on the
   installed user's machine. Use explicit download/installation and model attribution.

The reference reconstruction pipeline was not shipped. Predictions are projected onto original
words with protected technical spans. Only one insertion's recent passage is revisited (roughly
96 words plus 16 context words), bounded into overlapping 254-subtoken windows. Older source
corrections reopen the affected suffix. Local dictation withholds its terminal mark through thinking
pauses until Enter; voice auto-send explicitly finalizes. Manual edits, focus/mute handoffs and
cancelled completions cannot replace sealed text.

## Isolated production-engine measurements

Apple M4, Node 24.9.0 ARM64, ONNX Runtime 1.30.0 CPU, two intra-op threads, one inter-op thread.
One model in one fresh process; no quantization/conversion. Thirty warm runs measured complete
processing, including tokenization and source projection:

| Measurement                             |   Observation |
| --------------------------------------- | ------------: |
| Verified model/session load             |        359 ms |
| Short question median / p95             |  2.2 / 3.2 ms |
| Initial 700-word passage                |         63 ms |
| Subsequent growing-passage median / p95 |  8.2 / 9.1 ms |
| Process RSS before model                |       128 MiB |
| Warm short / long RSS                   | 697 / 747 MiB |
| Peak RSS                                |       747 MiB |

These are observations, not latency or memory guarantees. RSS includes runtime libraries,
allocator residency and the process itself, not just weights. `session.release()` releases the
session but did not immediately lower this process's RSS. The model is computationally cheap for
progressive processing but is **not a ~100 MB RAM component**. The original download target was
approximate; FP32 was chosen to avoid the observed quantized question-boundary regression.
Separate-process runs disabling the CPU arena/memory pattern, with either default or basic graph
optimization, still peaked around 746–747 MiB and had slower rolling medians (~14–15 ms).
Those options were not adopted.

The real-engine tests repair `Is this a question that I should? Be asking?` into a live passage
without a terminal mark and a final question on Enter. Source paths, identifiers, URLs, decimals,
code and filler words remain intact. English/news-domain capitalization may still be inappropriate
for conversational vocabulary; punctuation quality is not a guarantee of semantic fidelity.
