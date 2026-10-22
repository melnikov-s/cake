import DictationProtocol
import FluidAudio
import Foundation

/// Uses only locally installed assets. In particular, do not use downloadAndLoad or
/// VocabularyBoostingSession's default-cache tokenizer path (FluidAudio 0.17.4).
@MainActor
final class VocabularyBoosting {
  private let directory: URL
  private var entries: [VocabularyEntry] = []
  private var tokenizer: CtcTokenizer?
  private var spotter: CtcKeywordSpotter?
  private var rescorer: VocabularyRescorer?
  private var context: CustomVocabularyContext?

  init(directory: URL) { self.directory = directory }

  /// Run only when the main authority has nonempty vocabulary and installed assets.
  /// Loading/first prediction may compile Core ML graphs; finish before Listening.
  func prepare() async throws {
    guard spotter == nil else { return }
    let tokenizer = try await CtcTokenizer.load(from: directory)
    let models = try await CtcModels.loadDirect(from: directory)
    let activeSpotter = CtcKeywordSpotter(models: models, blankId: models.vocabulary.count)
    _ = try await activeSpotter.spotKeywordsWithLogProbs(
      audioSamples: [Float](repeating: 0, count: 12_800),
      customVocabulary: CustomVocabularyContext(terms: []), minScore: nil)
    self.tokenizer = tokenizer
    spotter = activeSpotter
  }

  func configure(_ next: [VocabularyEntry]) async throws {
    if next.isEmpty {
      entries = []
      spotter = nil
      tokenizer = nil
      rescorer = nil
      context = nil
      return
    }
    guard next != entries else { return }
    try await prepare()
    guard let tokenizer, let activeSpotter = spotter else { throw ProtocolError.invalidRequest }
    let terms = try next.map { entry in
      let tokens = tokenizer.encode(entry.text)
      guard !tokens.isEmpty else { throw ProtocolError.invalidRequest }
      return CustomVocabularyTerm(text: entry.text, aliases: entry.aliases, ctcTokenIds: tokens)
    }
    let vocabulary = CustomVocabularyContext(terms: terms)
    let activeRescorer = try await VocabularyRescorer.create(
      spotter: activeSpotter, vocabulary: vocabulary,
      config: .init(spotterRescueEnabled: false), ctcModelDirectory: directory)
    spotter = activeSpotter
    rescorer = activeRescorer
    context = vocabulary
    entries = next
  }

  func corrections(text: String, timings: [TokenTiming], audio: [Float], words: [RecognizedWord])
    async throws -> [VocabularyCorrection]
  {
    guard let spotter, let rescorer, let context, !timings.isEmpty else { return [] }
    let spotted = try await spotter.spotKeywordsWithLogProbs(
      audioSamples: audio, customVocabulary: context, minScore: nil)
    let evaluated = rescorer.ctcTokenEvaluateCandidates(
      transcript: text, tokenTimings: timings, logProbs: spotted.logProbs,
      frameDuration: spotted.frameDuration,
      // Conservative policy: aliases open candidate discovery, but only a winning
      // acoustic comparison can change text. No unconditional alias substitutions.
      cbw: 0, minSimilarity: context.minSimilarity)
    guard evaluated.baseWords == words.map(\.text) else {
      throw ASRError.processingFailed("Vocabulary timing alignment failed.")
    }
    return evaluated.candidates.compactMap { candidate in
      guard candidate.legacyOutcome == .applied, candidate.comparisonPassed,
        hasVocabularyAcousticSupport(
          preferredScore: candidate.rawVocabularyCTCScore,
          originalScore: candidate.rawOriginalCTCScore)
      else { return nil }
      return VocabularyCorrection(range: candidate.wordRange, text: candidate.canonicalTerm)
    }
  }
}
