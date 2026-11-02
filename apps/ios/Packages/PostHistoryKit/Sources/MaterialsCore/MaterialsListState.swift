import Foundation
import PostHistoryAPI

/// ما يعرضه «موادي» من القائمة (ADR 0089)، صرفًا ليُختبر: المواد، وتقدّم الصفحات، وآخر تحديث ناجح، وجيلٌ يرتفع مع المسح الطارئ
/// والخروج والإبطال. كل تحميل يأخذ تذكرة جيله حين يبدأ، قبل أي انتظار، ونتيجته تسقط إن ارتفع الجيل بعدها: تحميل أعاد قائمته قبل
/// `MaterialsFeed.clear()` لا يكتبها بعد المسح، فلا تعود عناوين المراسل السابق وأماكنه إلى الذاكرة ولا يُكتب لها «آخر تحديث».
public struct MaterialsListState: Equatable, Sendable {
    /// جيل القائمة حين بدأ التحميل.
    public struct Ticket: Equatable, Sendable {
        let generation: Int
    }

    public private(set) var items: [Material] = []
    /// تقدّم الصفحات مع فشل آخر تحميل؛ مفتاح «الصفحة التالية» في آخر المعرض (`PageProgress`).
    public private(set) var pages = PageProgress()
    /// آخر تحديث ناجح للصفحة الأولى (السحب والاستطلاع)؛ عند الفشل تبقى المواد مع شريط «غير محدّث منذ …».
    public private(set) var lastUpdated: Date?
    private var generation = 0

    public init() {}

    /// يُؤخذ حين يبدأ التحميل، قبل أي انتظار.
    public func ticket() -> Ticket { Ticket(generation: generation) }

    /// نتيجة التحميل صاحب التذكرة ما زالت تُكتب: لم يقع مسح بعد بدئه.
    public func accepts(_ ticket: Ticket) -> Bool { ticket.generation == generation }

    /// نتيجة تحميل مع تقدّم الصفحات بعده (`MaterialsFeed.progress`). النجاح يكتب المواد ويمحو الفشل، و`updatedAt` للصفحة الأولى
    /// وحدها؛ والإلغاء ليس فشلًا (`LoadOutcome`) فيبقى ما كان؛ والفشل يُبقي المواد المعروضة. `false` إن سقطت النتيجة لأن مسحًا وقع بعد
    /// بدء التحميل.
    @discardableResult
    public mutating func settle(_ ticket: Ticket, _ result: Result<[Material], any Error>, progress: PageProgress,
                                updatedAt: Date? = nil) -> Bool {
        guard accepts(ticket) else { return false }
        var next = progress
        switch result {
        case .success(let fresh):
            items = fresh
            next.failed = false
            if let updatedAt { lastUpdated = updatedAt }
        case .failure(let error):
            next.failed = LoadOutcome.isCancellation(error) ? pages.failed : true
        }
        pages = next
        return true
    }

    /// مادة واحدة حُدّثت (`MaterialsFeed.reload`): المواد كما في المحمّل بعدها، إن لم يقع مسح بعد بدء الطلب.
    @discardableResult
    public mutating func replaceItems(_ ticket: Ticket, with fresh: [Material]) -> Bool {
        guard accepts(ticket) else { return false }
        items = fresh
        return true
    }

    /// المسح الطارئ والخروج والإبطال: لا مادة ولا تقدّم ولا «آخر تحديث»، ويرتفع الجيل فتسقط نتيجة كل تحميل بدأ قبله.
    public mutating func clear() {
        generation += 1
        items = []
        pages = PageProgress()
        lastUpdated = nil
    }
}
