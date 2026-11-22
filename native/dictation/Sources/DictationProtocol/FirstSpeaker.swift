/// Policies for anonymous, round-local verification. Model labels are local to each window;
/// they are never treated as stable IDs. Only one immutable reference matches across windows.
public struct FirstSpeaker: Sendable {
  public enum Frame: Equatable, Sendable {
    case silence, uncertain, single(Int)
  }

  public static let frameStep = 270
  private static let minimumAnchor = 24  // ~405 ms of clear, consistent speech
  public static let minimumMatch = 15  // ~253 ms of evidence for later windows
  private static let similarity: Float = 0.52
  private var reference: [Float]?

  public init() {}

  public mutating func allowedLabels(
    _ frames: [Frame], from firstFrame: Int, until outputEnd: Int,
    embedding: (Int) throws -> [Float]?
  ) rethrows -> Set<Int> {
    var newlySelected: Int?
    if reference == nil {
      var label: Int?
      var count = 0
      var quiet = 0
      var start = firstFrame
      for i in firstFrame..<frames.count {
        switch frames[i] {
        case .single(let next):
          if next != label {
            label = next
            count = 0
            start = i
          }
          quiet = 0
          count += 1
          if count >= Self.minimumAnchor && start < outputEnd,
            let vector = try embedding(next), let unit = Self.normalized(vector)
          {
            reference = unit
            newlySelected = next
          }
        case .silence:
          quiet += 1
          if quiet > 8 { label = nil }
        case .uncertain:
          label = nil
        }
        if newlySelected != nil { break }
      }
    }
    guard let reference else { return [] }
    let candidates = Set(frames[firstFrame..<outputEnd].compactMap { frame -> Int? in
      if case .single(let label) = frame { return label }
      return nil
    })
    // A second local track is a separate speaker decision, never implicitly passed through.
    // At lock time, only the chosen track is eligible, even if another sounds similar.
    if let newlySelected { return candidates.intersection([newlySelected]) }
    let ranked = try candidates.compactMap { label -> (Int, Float)? in
      guard let vector = try embedding(label), let unit = Self.normalized(vector),
        unit.count == reference.count
      else { return nil }
      return (label, zip(unit, reference).reduce(0) { $0 + $1.0 * $1.1 })
    }.sorted { $0.1 > $1.1 }
    guard let best = ranked.first, best.1 >= Self.similarity,
      ranked.count == 1 || best.1 - ranked[1].1 >= 0.08
    else { return [] }
    return [best.0]
  }

  private static func normalized(_ values: [Float]) -> [Float]? {
    let length = values.reduce(Float(0)) { $0 + $1 * $1 }.squareRoot()
    guard length.isFinite, length > 0 else { return nil }
    return values.map { $0 / length }
  }
}
