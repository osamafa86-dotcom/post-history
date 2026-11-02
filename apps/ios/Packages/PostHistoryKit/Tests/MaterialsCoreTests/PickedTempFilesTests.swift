import XCTest
@testable import MaterialsCore

final class PickedTempFilesTests: XCTestCase {
    func testSweepRemovesOnlyPickerCopies() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("picked-sweep-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let leftovers = [PickedTempFiles.newName(for: "a.mov"), PickedTempFiles.newName(for: "b.jpg")]
        let others = ["FormCache.json", "light-copy.mov"]
        for name in leftovers + others { try Data("x".utf8).write(to: dir.appendingPathComponent(name)) }
        XCTAssertEqual(PickedTempFiles.sweep(in: dir), 2)
        let left = try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted()
        XCTAssertEqual(left, others.sorted(), "files the picker did not make are untouched")
    }

    func testSweepOfAMissingDirectoryIsHarmless() {
        XCTAssertEqual(PickedTempFiles.sweep(in: URL(fileURLWithPath: "/nonexistent-\(UUID().uuidString)")), 0)
    }

    func testNamesAreUniqueAndKeepTheFilename() {
        let a = PickedTempFiles.newName(for: "clip.mov"), b = PickedTempFiles.newName(for: "clip.mov")
        XCTAssertNotEqual(a, b)
        XCTAssertTrue(a.hasPrefix(PickedTempFiles.prefix) && a.hasSuffix("-clip.mov"))
    }

    func testTheOriginalNameComesBackWithoutThePrefixAndId() {
        XCTAssertEqual(PickedTempFiles.originalName(PickedTempFiles.newName(for: "IMG_0042.MOV")), "IMG_0042.MOV")
        XCTAssertEqual(PickedTempFiles.originalName(PickedTempFiles.newName(for: "a-b-c.jpg")), "a-b-c.jpg")
        XCTAssertEqual(PickedTempFiles.originalName("clip.mov"), "clip.mov")
        XCTAssertEqual(PickedTempFiles.originalName("picked-not-a-uuid-clip.mov"), "picked-not-a-uuid-clip.mov")
    }
}
