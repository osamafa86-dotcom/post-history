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

/// قائمة «موادي»: تحديث من الأول، وتحميل التالي بلا تكرار. التحميلات (السحب، والاستطلاع، و«الصفحة التالية») تمر واحدةً واحدة
/// بالترتيب: ما يُطلب والأخرى جارية ينتظر دوره ثم يُنفَّذ، ولا يعود بلا طلب؛ فلا يُفقد طلب «الصفحة التالية» إن وافق استطلاعًا
/// (ADR 0089).
public actor MaterialsFeed {
    public private(set) var items: [Material] = []
    public private(set) var nextCursor: String?
    public private(set) var reachedEnd = false
    /// قفل تحميل بترتيب الوصول: من يجد التحميل مشغولًا ينتظر، ومن ينتهي يسلّمه لأول منتظر.
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    /// يرتفع مع المسح، فتحميل بدأ قبله لا يعيد إلى الذاكرة ما مُحي.
    private var epoch = 0
    private let api: any MaterialsListAPI
    private let pageSize: Int

    public init(api: any MaterialsListAPI, pageSize: Int = 30) {
        self.api = api
        self.pageSize = pageSize
    }

    private func acquire() async {
        guard busy else {
            busy = true
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    private func release() {
        if waiters.isEmpty { busy = false } else { waiters.removeFirst().resume() }
    }

    /// الصفحة الأولى من جديد وتسقط ما بعدها (السحب للتحديث، والتحميل الأول). القائمة السابقة تبقى إن فشل الطلب.
    @discardableResult
    public func refresh() async throws -> [Material] {
        await acquire()
        defer { release() }
        return try await firstPage()
    }

    private func firstPage() async throws -> [Material] {
        let started = epoch
        let page = try await api.page(cursor: nil, limit: pageSize)
        guard started == epoch else { return items }
        items = page.items
        nextCursor = page.nextCursor
        reachedEnd = page.nextCursor == nil
        return items
    }

    /// الاستطلاع والعودة إلى المعرض (ADR 0089): الصفحة الأولى تُدمج فوق ما حُمّل، فلا يعود المعرض إلى صفحته الأولى ولا تُعاد الصفحات.
    /// ما تغيّر يُحدَّث في مكانه، والجديد يُضاف أعلاه، وما بعدها ومؤشره يبقيان (الترتيب `created_desc`، فالجديد يأتي أعلى ولا يمس
    /// موضع المؤشر). وتُستبدل القائمة كلها في حالتين: الصفحة الأولى هي القائمة كلها (لا مؤشر بعدها، فتسقط المحذوفة أيضًا)، أو لا
    /// تتقاطع مع ما حُمّل وبعدها مؤشر (جديد أكثر من صفحة، فجوة لا يملؤها المؤشر القديم). بلا شيء محمَّل هي تحميل أول.
    @discardableResult
    public func refreshHead() async throws -> [Material] {
        await acquire()
        defer { release() }
        if items.isEmpty { return try await firstPage() }
        let started = epoch
        let page = try await api.page(cursor: nil, limit: pageSize)
        guard started == epoch else { return items }
        let known = Set(items.map(\.id))
        if page.nextCursor == nil || !page.items.contains(where: { known.contains($0.id) }) {
            items = page.items
            nextCursor = page.nextCursor
            reachedEnd = page.nextCursor == nil
            return items
        }
        var fresh: [UUID: Material] = [:]
        for m in page.items { fresh[m.id] = m }
        var added: [Material] = []
        for m in page.items where !known.contains(m.id) && !added.contains(where: { $0.id == m.id }) { added.append(m) }
        items = added + items.map { fresh[$0.id] ?? $0 }
        return items
    }

    /// الصفحة التالية؛ ما وصل مرتين (مادة تحركت بين الصفحات) لا يتكرر. وتحميل جارٍ (استطلاع مثلًا) تنتظره ثم تطلب بمؤشره بعده.
    @discardableResult
    public func loadMore() async throws -> [Material] {
        await acquire()
        defer { release() }
        guard !reachedEnd, let cursor = nextCursor else { return items }
        let started = epoch
        let page = try await api.page(cursor: cursor, limit: pageSize)
        guard started == epoch else { return items }
        let known = Set(items.map(\.id))
        items.append(contentsOf: page.items.filter { !known.contains($0.id) })
        nextCursor = page.nextCursor
        reachedEnd = page.nextCursor == nil
        return items
    }

    /// يحدّث مادة واحدة في مكانها (شاشة التفاصيل، أو إشعار عنها).
    @discardableResult
    public func reload(id: UUID) async throws -> Material {
        let started = epoch
        let m = try await api.material(id: id)
        guard started == epoch else { return m }
        if let i = items.firstIndex(where: { $0.id == id }) { items[i] = m } else { items.insert(m, at: 0) }
        return m
    }

    /// المسح الطارئ وتسجيل الخروج: لا يبقى في الذاكرة عنوان ولا مكان.
    public func clear() {
        epoch += 1
        items = []
        nextCursor = nil
        reachedEnd = false
    }
}
