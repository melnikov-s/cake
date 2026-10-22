import Foundation

public struct VocabularyEntry: Decodable, Sendable, Equatable {
  public let id: String
  public let text: String
  public let aliases: [String]

  public func validate() throws {
    let forms = [text] + aliases
    guard !id.isEmpty, id.count <= 100, aliases.count <= 5,
      forms.allSatisfy({
        $0.count >= 3 && $0.count <= 80
          && $0.rangeOfCharacter(from: .controlCharacters) == nil
          && $0 == $0.trimmingCharacters(in: .whitespacesAndNewlines)
      }), Set(forms.map { $0.lowercased() }).count == forms.count
    else { throw ProtocolError.invalidRequest }
  }
}

/// Require a meaningful margin in normalized CTC log scores, not a near-tie.
/// A weak secondary-model preference must not override ordinary decoder words.
public func hasVocabularyAcousticSupport(preferredScore: Float?, originalScore: Float?) -> Bool {
  guard let preferredScore, let originalScore, preferredScore.isFinite, originalScore.isFinite
  else { return false }
  return preferredScore > originalScore + 0.5
}

/// A time-aligned acoustic decision, never a global string replacement.
public struct VocabularyCorrection: Sendable {
  public let range: Range<Int>
  public let text: String
  public init(range: Range<Int>, text: String) {
    self.range = range
    self.text = text
  }
}

/// Correct the timed hypothesis BEFORE rolling agreement/commit. Multi-word terms retain
/// their source span, so revisions, overlap trimming and finalization use one timeline.
public func applyingVocabularyCorrections(
  _ corrections: [VocabularyCorrection], to words: [RecognizedWord]
) -> [RecognizedWord] {
  var result: [RecognizedWord] = []
  var offset = 0
  for correction in corrections.sorted(by: { $0.range.lowerBound < $1.range.lowerBound }) {
    let range = correction.range
    guard !range.isEmpty, range.lowerBound >= offset, range.upperBound <= words.count else {
      continue
    }
    result.append(contentsOf: words[offset..<range.lowerBound])
    let trailing = words[range.upperBound - 1].text.reversed().prefix { ".,!?;:".contains($0) }
      .reversed()
    let text =
      correction.text
      + (correction.text.last.map { ".,!?;:".contains($0) } == true ? "" : String(trailing))
    result.append(
      RecognizedWord(
        text: text, startSample: words[range.lowerBound].startSample,
        endSample: words[range.upperBound - 1].endSample))
    offset = range.upperBound
  }
  result.append(contentsOf: words[offset...])
  return result
}
