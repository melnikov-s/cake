import DictationProtocol
import Foundation

private struct RollingTestFailure: Error { let message: String }
private func check(_ value: Bool, _ message: String) throws {
  if !value { throw RollingTestFailure(message: message) }
}
private func word(_ text: String, _ start: Double, _ end: Double) -> RecognizedWord {
  RecognizedWord(text: text, startSample: Int(start * 16_000), endSample: Int(end * 16_000))
}
private func audio(_ seconds: Int) -> [Float] { [Float](repeating: 0.1, count: seconds * 16_000) }

func rollingTranscriptTests() throws {
  // A new hypothesis replaces the passage, including old false punctuation and capitalization.
  var passage = RollingTranscript()
  try passage.append(audio(3))
  passage.update([word("Is", 0, 0.4), word("this", 0.4, 0.8), word("correct?", 0.8, 1.5)])
  let beforePause = passage.text
  passage.update([word("Is", 0, 0.4), word("this", 0.4, 0.8), word("correct?", 0.8, 1.5)])
  try check(
    passage.text == beforePause, "A pause neither adds words nor seals the recent hypothesis")
  try passage.append(audio(2))
  passage.update([
    word("Is", 0, 0.4), word("this", 0.4, 0.8), word("correct", 0.8, 1.5),
    word("for", 3, 3.4), word("streaming?", 3.4, 4),
  ])
  try check(
    passage.text == "Is this correct for streaming?",
    "Resumed speech can remove an earlier question mark")
  passage.update([word("Is", 0, 0.4), word("this", 0.4, 0.8), word("correct", 0.8, 1.5)])
  try check(passage.text == "Is this correct", "Hypotheses can also retract provisional words")

  // Confidence/agreement in the words alone does not settle punctuation. Future context matters.
  var agreement = RollingTranscript()
  try agreement.append(audio(10))
  let punctuated = [word("Look", 0, 1), word("here.", 1, 2), word("Next", 8, 9)]
  agreement.update(punctuated)
  agreement.update([word("Look", 0, 1), word("here", 1, 2), word("next", 8, 9)])
  agreement.update([word("Look", 0, 1), word("here,", 1, 2), word("next", 8, 9)])
  try check(agreement.text == "Look here, next", "Disagreeing punctuation must remain revisable")
  try check(
    agreement.audio.count > 8 * 16_000, "Unsettled punctuation retains its acoustic context")

  var recent = RollingTranscript()
  try recent.append(audio(5))
  let recentGuess = [word("Look", 0, 1), word("here.", 1, 2), word("Next", 3, 4)]
  recent.update(recentGuess)
  recent.update(recentGuess)
  recent.update([word("Look", 0, 1), word("here", 1, 2), word("Next", 3, 4)])
  try check(
    recent.text == "Look here Next",
    "Repeated short-window guesses cannot prematurely freeze punctuation")

  // Left overlap anchors a stable prefix by text AND time. Spoken repetitions are not deduplicated.
  var overlap = RollingTranscript()
  try overlap.append(audio(14))
  let repeated = [word("Go", 0, 1), word("now", 3, 4), word("now", 9, 10), word("please.", 10, 11)]
  overlap.update(repeated)
  overlap.update(repeated)
  try check(overlap.startSample > 0, "Stable old audio is trimmed, retaining left context")
  overlap.update([word("Now", 3.1, 4.1), word("now", 9, 10), word("please!", 10, 11)])
  try check(
    overlap.text == "Go now now please!",
    "Overlap is emitted once while genuine repeated words survive")
  overlap.update([word("now", 9, 10), word("please?", 10, 11)])
  try check(
    overlap.text == "Go now now please?",
    "A missing overlap anchor uses acoustic timing without dropping the next word")

  // Window pressure does not require a sentence ending or unlimited audio retention.
  var bounded = RollingTranscript()
  for second in 0..<160 {
    try bounded.append(audio(1))
    let first = bounded.startSample / 16_000
    let hypothesis = (first...second).map { word("word\($0)", Double($0), Double($0) + 0.8) }
    bounded.update(hypothesis, atCapacity: bounded.remainingSamples == 0)
    try check(
      bounded.audio.count <= RollingTranscript.maximumSamples,
      "Long speech has a bounded audio window")
  }
  try check(
    bounded.text == (0..<160).map { "word\($0)" }.joined(separator: " "),
    "Rolling seams neither duplicate nor drop words during long continuous speech")

  var pressure = RollingTranscript()
  try pressure.append(audio(14))
  pressure.update([word("Old", 0, 1), word("guess", 2, 3), word("tail", 12, 13)])
  pressure.update(
    [word("Better", 0, 1), word("guess", 2, 3), word("tail", 12, 13)], atCapacity: true)
  try check(
    pressure.remainingSamples > 0, "Budget pressure advances even when an old prefix never agrees")
  pressure.update([word("revised", 12, 13)])
  try check(
    pressure.text == "Better guess revised", "Budget pressure preserves a revisable recent tail")

  var unrecognized = RollingTranscript()
  try unrecognized.append(audio(14))
  unrecognized.update([], atCapacity: true)
  try check(
    unrecognized.remainingSamples > 0 && unrecognized.text.isEmpty,
    "Unrecognized audio cannot fill the buffer or invent text")
  let reset = RollingTranscript()
  try check(
    reset.audio.isEmpty && reset.text.isEmpty,
    "A new recognition generation has no prior audio or words")
}
