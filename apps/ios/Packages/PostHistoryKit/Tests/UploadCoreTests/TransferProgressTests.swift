import XCTest
@testable import UploadCore

final class TransferProgressTests: XCTestCase {
    func testRateNeedsThreeSamplesAndUsesTheLastThirtySeconds() {
        var e = TransferRateEstimator()
        let t0 = Date(timeIntervalSince1970: 1_000)
        e.record(offset: 0, at: t0)
        e.record(offset: 1_000, at: t0.addingTimeInterval(1))
        XCTAssertNil(e.bytesPerSecond, "fewer than three samples: no estimate")
        e.record(offset: 2_000, at: t0.addingTimeInterval(2))
        XCTAssertEqual(e.bytesPerSecond ?? 0, 1_000, accuracy: 0.001)
        XCTAssertEqual(e.secondsRemaining(sizeBytes: 10_000, confirmedOffset: 2_000) ?? 0, 8, accuracy: 0.001)

        // بعد 40 ثانية بسرعة أبطأ: العيّنات القديمة تخرج من النافذة.
        e.record(offset: 2_100, at: t0.addingTimeInterval(40))
        e.record(offset: 2_200, at: t0.addingTimeInterval(41))
        e.record(offset: 2_300, at: t0.addingTimeInterval(42))
        XCTAssertEqual(e.bytesPerSecond ?? 0, 100, accuracy: 0.001)
    }

    func testResumeFromALowerOffsetRestartsTheEstimate() {
        var e = TransferRateEstimator()
        let t0 = Date(timeIntervalSince1970: 0)
        for i in 0..<3 { e.record(offset: Int64(i) * 500, at: t0.addingTimeInterval(Double(i))) }
        XCTAssertNotNil(e.bytesPerSecond)
        e.record(offset: 400, at: t0.addingTimeInterval(3))
        XCTAssertNil(e.bytesPerSecond, "a server offset behind the last sample starts over")
    }

    func testNoProgressMeansNoEstimate() {
        var e = TransferRateEstimator()
        let t0 = Date(timeIntervalSince1970: 0)
        for i in 0..<4 { e.record(offset: 700, at: t0.addingTimeInterval(Double(i))) }
        XCTAssertNil(e.bytesPerSecond, "a stalled network shows no time left")
    }

    func testBarsForFewPartsAreOnePerPart() {
        let b = ChunkBars(sizeBytes: 100, chunkSizeBytes: 10, confirmedOffset: 30, inFlightOffset: 30)
        XCTAssertEqual(b.totalParts, 10)
        XCTAssertEqual(b.confirmedParts, 3)
        XCTAssertEqual(b.inFlightPart, 4)
        XCTAssertEqual(b.bars, [.confirmed, .confirmed, .confirmed, .inFlight] + Array(repeating: .pending, count: 6))
    }

    func testManyPartsAreGroupedIntoTwelveBars() {
        let b = ChunkBars(sizeBytes: 1_000, chunkSizeBytes: 10, confirmedOffset: 500, inFlightOffset: 500)
        XCTAssertEqual(b.totalParts, 100)
        XCTAssertEqual(b.bars.count, ChunkBars.maxBars)
        XCTAssertEqual(b.bars.filter { $0 == .confirmed }.count, 6, "bars fully inside the first 50 parts")
        XCTAssertEqual(b.bars.filter { $0 == .inFlight }.count, 1)
    }

    func testLastPartAndCompletion() {
        let partial = ChunkBars(sizeBytes: 95, chunkSizeBytes: 10, confirmedOffset: 90, inFlightOffset: 90)
        XCTAssertEqual(partial.totalParts, 10)
        XCTAssertEqual(partial.confirmedParts, 9)
        let done = ChunkBars(sizeBytes: 95, chunkSizeBytes: 10, confirmedOffset: 95, inFlightOffset: nil)
        XCTAssertEqual(done.confirmedParts, 10)
        XCTAssertTrue(done.bars.allSatisfy { $0 == .confirmed })
        XCTAssertNil(done.inFlightPart)
    }
}
