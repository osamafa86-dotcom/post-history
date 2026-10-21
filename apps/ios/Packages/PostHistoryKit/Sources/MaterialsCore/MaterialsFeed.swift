import Foundation
import PostHistoryAPI

/// `GET /materials` كما يحتاجه المراسل: مواده فقط (النطاق على الخادم)، الأحدث أولًا، بصفحات.
public protocol MaterialsListAPI: Sendable {
    func page(cursor: String?, limit: Int) async throws -> MaterialPage
    func material(id: UUID) async throws -> Material
}

public struct GeneratedMaterialsListAPI: MaterialsListAPI {
    private let configuration: PostHistoryAPIAPIConfiguration
    public init(configuration: PostHistoryAPIAPIConfiguration) { self.configuration = configuration }

    public func page(cursor: String?, limit: Int) async throws -> MaterialPage {
        try await MaterialsAPI.listMaterials(sort: .createdDesc, cursor: cursor, limit: limit, apiConfiguration: configuration)
    }

    public func material(id: UUID) async throws -> Material {
        try await MaterialsAPI.getMaterial(id: id, apiConfiguration: configuration)
    }
}

/// قائمة «موادي»: تحديث من الأول، وتحميل التالي بلا تكرار، وطلب واحد في كل لحظة.
public actor MaterialsFeed {
    public private(set) var items: [Material] = []
    public private(set) var nextCursor: String?
    public private(set) var reachedEnd = false
    private var loading = false
    private let api: any MaterialsListAPI
    private let pageSize: Int

    public init(api: any MaterialsListAPI, pageSize: Int = 30) {
        self.api = api
        self.pageSize = pageSize
    }

    /// الصفحة الأولى من جديد (السحب للتحديث، العودة إلى الشاشة). القائمة السابقة تبقى إن فشل الطلب.
    @discardableResult
    public func refresh() async throws -> [Material] {
        guard !loading else { return items }
        loading = true
        defer { loading = false }
        let page = try await api.page(cursor: nil, limit: pageSize)
        items = page.items
        nextCursor = page.nextCursor
        reachedEnd = page.nextCursor == nil
        return items
    }

    /// الصفحة التالية؛ ما وصل مرتين (مادة تحركت بين الصفحات) لا يتكرر.
    @discardableResult
    public func loadMore() async throws -> [Material] {
        guard !loading, !reachedEnd, let cursor = nextCursor else { return items }
        loading = true
        defer { loading = false }
        let page = try await api.page(cursor: cursor, limit: pageSize)
        let known = Set(items.map(\.id))
        items.append(contentsOf: page.items.filter { !known.contains($0.id) })
        nextCursor = page.nextCursor
        reachedEnd = page.nextCursor == nil
        return items
    }

    /// يحدّث مادة واحدة في مكانها (شاشة التفاصيل، أو إشعار عنها).
    @discardableResult
    public func reload(id: UUID) async throws -> Material {
        let m = try await api.material(id: id)
        if let i = items.firstIndex(where: { $0.id == id }) { items[i] = m } else { items.insert(m, at: 0) }
        return m
    }

    /// المسح الطارئ وتسجيل الخروج: لا يبقى في الذاكرة عنوان ولا مكان.
    public func clear() {
        items = []
        nextCursor = nil
        reachedEnd = false
    }
}
