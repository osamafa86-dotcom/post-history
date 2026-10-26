import XCTest
@testable import MediaCore

final class LightCopyFilesTests: XCTestCase {
    func testOnlyUnreferencedLightCopiesAreOrphans() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("light-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let queued = LightCopyFiles.newName(), halfWritten = LightCopyFiles.newName()
        for name in [queued, halfWritten, "original.mov"] { try Data("x".utf8).write(to: dir.appendingPathComponent(name)) }
        let orphans = LightCopyFiles.orphans(in: dir, referenced: [queued, "original.mov"])
        XCTAssertEqual(orphans.map(\.lastPathComponent), [halfWritten], "an original is never an orphan and a queued light copy is kept")
    }
}
