import XCTest
@testable import DeviceSecurity

final class EmergencyWipeTests: XCTestCase {
    private func tempDir() -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("wipe-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func testEmptyDirectoryRemovesEverythingAndKeepsTheFolder() throws {
        let dir = tempDir()
        try Data([1, 2, 3]).write(to: dir.appendingPathComponent("a.bin"))
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("sub/deeper"), withIntermediateDirectories: true)
        try Data([4]).write(to: dir.appendingPathComponent("sub/deeper/b.bin"))
        XCTAssertEqual(try LocalDataWiper.emptyDirectory(dir), 2)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [])
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.path))
        XCTAssertEqual(try LocalDataWiper.emptyDirectory(dir), 0, "second pass finds nothing")
    }

    func testMissingDirectoryIsAbsentNotFailure() throws {
        let dir = tempDir().appendingPathComponent("never-created")
        XCTAssertEqual(try LocalDataWiper.emptyDirectory(dir, recreate: false), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path))
    }

    func testRunsEveryStepInOrderAndContinuesAfterFailure() async {
        final class Log: @unchecked Sendable { var order: [String] = [] }
        let log = Log()
        let wipe = EmergencyWipe(steps: [
            WipeStep(name: "uploads") { log.order.append("uploads"); return 3 },
            WipeStep(name: "keychain") { log.order.append("keychain"); throw LocalDataWiper.WipeError.removalFailed },
            WipeStep(name: "files") { log.order.append("files"); return 0 },
        ])
        let report = await wipe.run()
        XCTAssertEqual(log.order, ["uploads", "keychain", "files"])
        XCTAssertEqual(report.outcomes.map(\.step), ["uploads", "keychain", "files"])
        XCTAssertEqual(report.outcomes[0].status, .wiped(items: 3))
        XCTAssertEqual(report.outcomes[1].status, .failed("WipeError"))
        XCTAssertEqual(report.outcomes[2].status, .absent)
        XCTAssertFalse(report.allClean)
        XCTAssertGreaterThanOrEqual(report.finishedAt, report.startedAt)
    }

    func testKeyValueStepSkipsKeptKeys() async throws {
        final class Store: @unchecked Sendable { var keys: Set<String> = ["deleteLocalAfterReceipt", "hasLaunchedBefore", "draft"] }
        let store = Store()
        let step = LocalDataWiper.keyValueStep(name: "defaults", keys: ["deleteLocalAfterReceipt", "hasLaunchedBefore", "draft", "missing"], keep: ["hasLaunchedBefore"]) { key in
            store.keys.remove(key) != nil
        }
        let removed = try await step.run()
        XCTAssertEqual(removed, 2)
        XCTAssertEqual(store.keys, ["hasLaunchedBefore"])
    }

    func testReportNamesContainNoPaths() async throws {
        let dir = tempDir()
        try Data([1]).write(to: dir.appendingPathComponent("x"))
        let report = await EmergencyWipe(steps: [LocalDataWiper.directoryStep(name: "chunks", url: dir)]).run()
        XCTAssertEqual(report.outcomes, [WipeOutcome(step: "chunks", status: .wiped(items: 1))])
        XCTAssertFalse(String(describing: report).contains("/"))
    }
}
