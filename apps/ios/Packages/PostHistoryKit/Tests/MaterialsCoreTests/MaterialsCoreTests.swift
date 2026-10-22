import XCTest
import PostHistoryAPI
@testable import MaterialsCore

final class FakeMaterialsAPI: MaterialsListAPI, @unchecked Sendable {
    let lock = NSLock()
    var pages: [String?: MaterialPage] = [:]
    var calls: [String?] = []
    var detail: Material?
    func page(cursor: String?, limit: Int) async throws -> MaterialPage {
        lock.withLock { calls.append(cursor); return pages[cursor] ?? MaterialPage(items: [], nextCursor: nil) }
    }
    func material(id: UUID) async throws -> Material { lock.withLock { detail! } }
}

func material(_ id: UUID = UUID(), title: String = "t", technical: TechnicalState = .verified, editorial: EditorialState = .inbox,
              rights: RightsState = .unknown, files: [MaterialFile] = []) -> Material {
    Material(title: title, materialTypes: [], governorate: "غزة", city: "غزة", priority: .normal,
             sensitivity: Sensitivity(minors: false, injured: false, graphic: false),
             displayName: DisplayName(mode: .network), formVersion: 1, dynamicFields: [:],
             id: id, version: 1, reporterId: UUID(), officeId: nil, technicalState: technical, editorialState: editorial,
             rightsState: rights, files: files, createdAt: Date(), updatedAt: Date())
}

func file(_ kind: MaterialFile.Kind, receipt: String?) -> MaterialFile {
    MaterialFile(id: UUID(), kind: kind, state: .verified, receiptNumber: receipt, createdAt: Date())
}

final class MaterialsCoreTests: XCTestCase {
    func testRefreshThenLoadMoreAppendsWithoutDuplicatesAndStopsAtTheEnd() async throws {
        let a = material(), b = material(), c = material()
        let api = FakeMaterialsAPI()
        api.pages[nil] = MaterialPage(items: [a, b], nextCursor: "p2")
        api.pages["p2"] = MaterialPage(items: [b, c], nextCursor: nil)
        let feed = MaterialsFeed(api: api, pageSize: 2)
        try await feed.refresh()
        let all = try await feed.loadMore()
        XCTAssertEqual(all.map(\.id), [a.id, b.id, c.id])
        let end = await feed.reachedEnd
        XCTAssertTrue(end)
        try await feed.loadMore()
        XCTAssertEqual(api.calls, [nil, "p2"], "no request past the last page")
    }

    func testRefreshReplacesTheListAndReloadUpdatesInPlace() async throws {
        let a = material(title: "old")
        let api = FakeMaterialsAPI()
        api.pages[nil] = MaterialPage(items: [a], nextCursor: nil)
        let feed = MaterialsFeed(api: api)
        try await feed.refresh()
        api.detail = material(a.id, title: "new", editorial: .accepted)
        try await feed.reload(id: a.id)
        let items = await feed.items
        XCTAssertEqual(items.map(\.title), ["new"])
        await feed.clear()
        let cleared = await feed.items
        XCTAssertTrue(cleared.isEmpty)
    }

    func testThreeStatesStayIndependentAndReceiptPrefersTheOriginal() {
        let m = material(technical: .originalReceived, editorial: .needsChanges, rights: .blocked,
                         files: [file(.proxy, receipt: "R-1"), file(.original, receipt: "R-2")])
        let s = MaterialStatus(m)
        XCTAssertEqual(s.technical, .init(labelKey: "material.technical.originalReceived", tone: .progress))
        XCTAssertEqual(s.editorial, .init(labelKey: "material.editorial.needsChanges", tone: .attention))
        XCTAssertEqual(s.rights, .init(labelKey: "material.rights.blocked", tone: .bad))
        XCTAssertEqual(s.receiptNumber, "R-2")
        XCTAssertNil(MaterialStatus(material(files: [file(.original, receipt: nil)])).receiptNumber)
    }

    func testEveryStatusLabelHasArabicAndEnglishText() throws {
        let catalog = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../App/Resources/Localizable.xcstrings").standardized
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: catalog)) as! [String: Any]
        let strings = json["strings"] as! [String: Any]
        for key in MaterialStatus.allLabelKeys {
            let loc = (strings[key] as? [String: Any])?["localizations"] as? [String: Any]
            XCTAssertNotNil(loc?["ar"], "missing ar for \(key)")
            XCTAssertNotNil(loc?["en"], "missing en for \(key)")
        }
    }
}
