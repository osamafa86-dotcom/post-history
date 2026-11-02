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
/// (ADR 0089). وما طُلب قبل مسح، أو أُلغي وهو ينتظر دوره، يسقط بلا طلب.
public actor MaterialsFeed {
    public private(set) var items: [Material] = []
    public private(set) var nextCursor: String?
    public private(set) var reachedEnd = false
    /// صفحة أولى وصلت منذ آخر مسح. بدونها قد تكون القائمة من `reload(id:)` وحده (إشعار فُتح عند الإطلاق، أو تحميل أول فشل
    /// بلا شبكة)، فلا مؤشر ولا نهاية: الاستطلاع و«الصفحة التالية» حينها تحميل أول، لا دمج يُبقي القائمة بلا مؤشر.
    public private(set) var pageLoaded = false
    /// قفل تحميل بترتيب الوصول: من يجد التحميل مشغولًا ينتظر، ومن ينتهي يسلّمه لأول منتظر.
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    /// يرتفع مع المسح. يُقرأ عند دخول التحميل قبل انتظار دوره، فتحميل طُلب قبل المسح لا يطلب بعده ولا يعيد إلى الذاكرة ما مُحي.
    private var epoch = 0
    private let api: any MaterialsListAPI
    private let pageSize: Int

    public init(api: any MaterialsListAPI, pageSize: Int = 30) {
        self.api = api
        self.pageSize = pageSize
    }

    /// تقدّم الصفحات، مفتاح «الصفحة التالية» في آخر المعرض: لا يتغيّر إلا بطلب أُرسل فعلًا.
    public var progress: PageProgress { PageProgress(cursor: nextCursor, reachedEnd: reachedEnd, started: pageLoaded) }

    /// عدد التحميلات المنتظرة دورها (للاختبارات).
    var waiting: Int { waiters.count }

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

    /// بعد بلوغ الدور وقبل الطلب: ما طُلب قبل مسح يسقط بلا طلب (`false`)، وما أُلغي وهو ينتظر يُرمى إلغاءً بلا طلب.
    private func stillWanted(since started: Int) throws -> Bool {
        guard started == epoch else { return false }
        try Task.checkCancellation()
        return true
    }

    /// الصفحة الأولى من جديد وتسقط ما بعدها (السحب للتحديث، والتحميل الأول). القائمة السابقة تبقى إن فشل الطلب.
    @discardableResult
    public func refresh() async throws -> [Material] {
        let started = epoch
        await acquire()
        defer { release() }
        guard try stillWanted(since: started) else { return items }
        return try await firstPage(since: started)
    }

    private func firstPage(since started: Int) async throws -> [Material] {
        let page = try await api.page(cursor: nil, limit: pageSize)
        guard started == epoch else { return items }
        items = page.items
        nextCursor = page.nextCursor
        reachedEnd = page.nextCursor == nil
        pageLoaded = true
        return items
    }

    /// الاستطلاع والعودة إلى المعرض (ADR 0089): الصفحة الأولى تُدمج فوق ما حُمّل، فلا يعود المعرض إلى صفحته الأولى ولا تُعاد الصفحات.
    /// ما تغيّر يُحدَّث في مكانه، والجديد يُضاف أعلاه، وما بعدها ومؤشره يبقيان (الترتيب `created_desc`، فالجديد يأتي أعلى ولا يمس
    /// موضع المؤشر). وتُستبدل القائمة كلها في حالتين: الصفحة الأولى هي القائمة كلها (لا مؤشر بعدها، فتسقط المحذوفة أيضًا)، أو لا
    /// تتقاطع مع ما حُمّل وبعدها مؤشر (جديد أكثر من صفحة، فجوة لا يملؤها المؤشر القديم). وقبل أي صفحة (لا شيء محمَّل، أو مادة من
    /// `reload(id:)` وحدها) هي تحميل أول يضع المؤشر والنهاية.
    @discardableResult
    public func refreshHead() async throws -> [Material] {
        let started = epoch
        await acquire()
        defer { release() }
        guard try stillWanted(since: started) else { return items }
        if !pageLoaded || items.isEmpty { return try await firstPage(since: started) }
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
    /// وقبل أي صفحة هي تحميل أول؛ وبعد آخر صفحة لا طلب.
    @discardableResult
    public func loadMore() async throws -> [Material] {
        let started = epoch
        await acquire()
        defer { release() }
        guard try stillWanted(since: started) else { return items }
        if !pageLoaded { return try await firstPage(since: started) }
        guard !reachedEnd, let cursor = nextCursor else { return items }
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
        pageLoaded = false
    }
}

/// تقدّم صفحات «موادي» وقرار «الصفحة التالية» في آخر المعرض (ADR 0089)، صرفًا ليُختبر. مفتاح مهمة آخر المعرض: لا يتغيّر إلا بطلب
/// أُرسل (صفحة وصلت فتغيّر المؤشر أو النهاية، أو طلب فشل أو نجح بعد فشل)، فلا تعود المهمة بلا طلب ولا تدور.
public struct PageProgress: Equatable, Sendable {
    /// مؤشر الصفحة التالية؛ `nil` قبل أول صفحة وبعد آخرها.
    public var cursor: String?
    public var reachedEnd: Bool
    /// صفحة أولى وصلت منذ آخر مسح.
    public var started: Bool
    /// آخر تحميل فشل (لا الإلغاء، `LoadOutcome`): التحميل التلقائي يقف، وزرّ «تحميل المزيد» يعيده يدويًا.
    public var failed: Bool

    public init(cursor: String? = nil, reachedEnd: Bool = false, started: Bool = false, failed: Bool = false) {
        self.cursor = cursor
        self.reachedEnd = reachedEnd
        self.started = started
        self.failed = failed
    }

    /// هل تُطلب «الصفحة التالية» الآن؟ لا وطلب صفحة في الطريق أو في الطابور (`pending`)، ولا بعد آخر صفحة، ولا بعد فشل إلا بطلب
    /// المراسل (`retry`)، ولا بعد صفحة أولى بلا مؤشر. وقبل أي صفحة نعم: `MaterialsFeed.loadMore` حينها تحميل أول.
    public func wantsNextPage(pending: Bool, retry: Bool = false) -> Bool {
        guard !pending, !reachedEnd, retry || !failed else { return false }
        return cursor != nil || !started
    }
}

/// ما يُعدّ فشلًا في تحميل: الإلغاء ليس فشلًا (مهمة ألغاها SwiftUI عند الاختفاء أو تبديل المفتاح، أو طلب URLSession أُلغي معها)، فلا
/// شريط «غير محدّث منذ …» ولا زرّ «تحميل المزيد» ولا «لا مواد بهذا الفلتر» قبل أوانها.
public enum LoadOutcome {
    public static func isCancellation(_ error: any Error) -> Bool {
        if error is CancellationError { return true }
        if let e = error as? URLError { return e.code == .cancelled }
        // العميل المولَّد يلفّ كل خطأ: `CancellationError` برمز -3، وإلغاء URLSession بالرمز الذي وصل.
        if case ErrorResponse.error(_, _, _, let underlying) = error { return isCancellation(underlying) }
        let ns = error as NSError
        return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled
    }
}
