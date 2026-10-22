import DictationProtocol
import Foundation

private struct VocabularyTestFailure: Error { let message: String }
private func check(_ value: Bool, _ message: String) throws {
  if !value { throw VocabularyTestFailure(message: message) }
}
private func word(_ text: String, _ start: Int, _ end: Int) -> RecognizedWord {
  RecognizedWord(text: text, startSample: start * 16_000, endSample: end * 16_000)
}

func vocabularyTests() throws {
  try check(
    !hasVocabularyAcousticSupport(preferredScore: -9.61, originalScore: -9.75),
    "Weak secondary-model preference does not replace legitimate words")
  try check(
    hasVocabularyAcousticSupport(preferredScore: -5.09, originalScore: -6.59),
    "Clear acoustic evidence permits preferred spelling")
  try check(
    !hasVocabularyAcousticSupport(preferredScore: nil, originalScore: -4),
    "Missing evidence never replaces text")
  try check(
    !hasVocabularyAcousticSupport(preferredScore: .infinity, originalScore: -4),
    "Non-finite evidence never replaces text")
  let request = try AudioRequest.decode(
    """
    {"utteranceId":"one","pcm":"","final":false,"vocabulary":[{"id":"review","text":"Binks","aliases":["Banks"]}]}
    """)
  try check(
    request.vocabulary?.first?.aliases == ["Banks"], "Vocabulary travels with native requests")
  for invalid in [
    "{\"id\":\"review\",\"text\":\"Bi\",\"aliases\":[]}",
    "{\"id\":\"review\",\"text\":\"Binks\",\"aliases\":[\"binks\"]}",
  ] {
    var rejected = false
    do {
      _ = try AudioRequest.decode(
        "{\"utteranceId\":\"one\",\"pcm\":\"\",\"final\":true,\"vocabulary\":[\(invalid)]}")
    } catch { rejected = true }
    try check(rejected, "Native boundary rejects malformed vocabulary")
  }
  let words = [word("Ask", 0, 1), word("Banks,", 1, 2), word("about", 2, 3), word("Banks.", 9, 10)]
  try check(
    applyingVocabularyCorrections([], to: words).map(\.text) == words.map(\.text),
    "No acoustic decision means unchanged text, even for an alias")
  let corrections = [VocabularyCorrection(range: 1..<2, text: "Binks")]
  let corrected = applyingVocabularyCorrections(corrections, to: words)
  try check(
    corrected.map(\.text) == ["Ask", "Binks,", "about", "Banks."],
    "Only the acoustically selected occurrence changes; punctuation and legitimate Banks survive")
  try check(
    corrected[1].startSample == 16_000 && corrected[1].endSample == 32_000,
    "Correction keeps acoustic span")
  let phrase = applyingVocabularyCorrections(
    [VocabularyCorrection(range: 0..<2, text: "Cake Labs")], to: words)
  try check(
    phrase[0].text == "Cake Labs," && phrase[0].endSample == 32_000,
    "Phrases retain the full source span")
  var rolling = RollingTranscript()
  try rolling.append([Float](repeating: 0.1, count: 14 * 16_000))
  rolling.update(words)
  try check(rolling.text == "Ask Banks, about Banks.", "Raw first hypothesis is revisable")
  rolling.update(corrected)
  rolling.update(corrected)
  try check(
    rolling.text == "Ask Binks, about Banks.",
    "Corrected words enter rolling agreement before commit")
  rolling.update(corrected)
  try check(
    rolling.text == "Ask Binks, about Banks.",
    "Overlap/final repeated updates neither duplicate nor lose corrections")
  let restored = [word("Banks!", 9, 10)]
  rolling.update(restored)
  try check(
    rolling.text == "Ask Binks, about Banks!",
    "Final revisions retain committed corrected prefix and revise raw tail")
}
