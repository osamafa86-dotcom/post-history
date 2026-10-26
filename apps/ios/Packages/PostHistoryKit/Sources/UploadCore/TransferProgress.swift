import Foundation

/// سرعة الرفع من عيّنات آخر 30 ثانية (المواصفة A2): يُعرض الزمن المتبقي فقط بثلاث عيّنات على الأقل وبتقدم فعلي.
public struct TransferRateEstimator: Sendable {
    public static let window: TimeInterval = 30
    public static let minimumSamples = 3

    private var samples: [(at: Date, offset: Int64)] = []

    public init() {}

    /// عيّنة من موضع أكّده الخادم. موضع أقل من السابق (استئناف من HEAD بعد قطع) يبدأ العدّ من جديد.
    public mutating func record(offset: Int64, at date: Date) {
        if let last = samples.last, offset < last.offset { samples.removeAll() }
        samples.append((date, offset))
        samples.removeAll { date.timeIntervalSince($0.at) > Self.window }
    }

    public mutating func reset() { samples.removeAll() }

    /// بايت/ث، أو `nil` إن قلّت العيّنات أو لم يتقدم شيء.
    public var bytesPerSecond: Double? {
        guard samples.count >= Self.minimumSamples, let first = samples.first, let last = samples.last else { return nil }
        let seconds = last.at.timeIntervalSince(first.at)
        let bytes = last.offset - first.offset
        guard seconds > 0, bytes > 0 else { return nil }
        return Double(bytes) / seconds
    }

    public func secondsRemaining(sizeBytes: Int64, confirmedOffset: Int64) -> TimeInterval? {
        guard let rate = bytesPerSecond, sizeBytes > confirmedOffset else { return nil }
        return Double(sizeBytes - confirmedOffset) / rate
    }
}

/// شرائط الأجزاء (المواصفة A2): مؤكَّد/جارٍ/لاحق، 12 شريطًا حدًّا أقصى بتجميع الأجزاء، مع العدّ الحقيقي للأجزاء.
public struct ChunkBars: Equatable, Sendable {
    public enum State: Equatable, Sendable { case confirmed, inFlight, pending }

    public static let maxBars = 12

    public let bars: [State]
    /// أجزاء أكّدها الخادم من أصل `totalParts`.
    public let confirmedParts: Int
    public let totalParts: Int
    /// رقم الجزء الجاري (يبدأ من 1)، أو `nil` إن لم يكن جزء في الطريق.
    public let inFlightPart: Int?

    public init(sizeBytes: Int64, chunkSizeBytes: Int64, confirmedOffset: Int64, inFlightOffset: Int64?) {
        guard sizeBytes > 0, chunkSizeBytes > 0 else {
            bars = []; confirmedParts = 0; totalParts = 0; inFlightPart = nil
            return
        }
        let total = Int((sizeBytes + chunkSizeBytes - 1) / chunkSizeBytes)
        let doneParts = confirmedOffset >= sizeBytes ? total : min(total, Int(max(confirmedOffset, 0) / chunkSizeBytes))
        let inFlight = inFlightOffset.map { Int($0 / chunkSizeBytes) }.flatMap { $0 < total ? $0 : nil }
        totalParts = total
        confirmedParts = doneParts
        inFlightPart = inFlight.map { $0 + 1 }

        let count = min(total, Self.maxBars)
        bars = (0..<count).map { bar in
            // كل شريط يغطي مجموعة متصلة من الأجزاء؛ مؤكَّد إن اكتملت كلها، جارٍ إن ضم الجزء الجاري.
            let lower = bar * total / count
            let upper = (bar + 1) * total / count // حصري
            if upper <= doneParts { return .confirmed }
            if let inFlight, (lower..<upper).contains(inFlight) { return .inFlight }
            return .pending
        }
    }
}
