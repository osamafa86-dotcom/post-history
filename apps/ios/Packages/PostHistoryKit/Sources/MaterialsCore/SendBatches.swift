import Foundation
import PostHistoryAPI
import enum UploadCore.UploadFileProtection
import struct UploadCore.AccountScope

/// إرسالة واحدة من شاشة الإرسال: عنوانها الأساسي، ومفاتيح إنشاء ملفاتها كما خُطِّط لها قبل أول طلب، ومواد ما دخل الطابور منها،
/// كي يجمعها إيصال واحد ودوائر واحدة (ADR 0088).
public struct SendBatch: Codable, Equatable, Sendable, Identifiable {
    public var id: UUID
    public var title: String
    /// `Idempotency-Key` إنشاء كل ملف بترتيب الإرسال (`createIdempotencyKey`)، مسجَّلة قبل أول `POST /materials`.
    public var fileKeys: [String]
    /// مواد الملفات التي دخلت الطابور؛ تُضاف مادة كل ملف هنا قبل إدخاله، فلا يتحقق أصل لا تعرف إرساليته.
    public var materialIds: [UUID]
    public var createdAt: Date
    public var receiptShown: Bool
    /// جواب سؤال الحساسية للإرسالة («نعم» في أيٍّ من الثلاثة): تُحجب صور موادها في صفوف الرفع قبل أن تُعرف المادة من الخادم
    /// (ADR 0089). `nil` لملف كتبه بناء سابق، فتُحجب حتى تُعرف.
    public var sensitive: Bool?
    /// الحساب صاحب الإرسالة بمعرّفه المحلي المعتم (`LocalAccounts`، ADR 0091): تُعرض له وحده. `nil` لملف كتبه بناء سابق.
    public var owner: UUID?

    public init(id: UUID = UUID(), title: String, fileKeys: [String] = [], materialIds: [UUID] = [], createdAt: Date = Date(),
                receiptShown: Bool = false, sensitive: Bool? = nil, owner: UUID? = nil) {
        self.id = id
        self.title = title
        self.fileKeys = fileKeys
        self.materialIds = materialIds
        self.createdAt = createdAt
        self.receiptShown = receiptShown
        self.sensitive = sensitive
        self.owner = owner
    }

    /// ملف كتبه بناء سابق من هذا الطلب بلا مفاتيح الملفات يُقرأ كما هو.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        fileKeys = try c.decodeIfPresent([String].self, forKey: .fileKeys) ?? []
        materialIds = try c.decode([UUID].self, forKey: .materialIds)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        receiptShown = try c.decode(Bool.self, forKey: .receiptShown)
        sensitive = try c.decodeIfPresent(Bool.self, forKey: .sensitive)
        owner = try c.decodeIfPresent(UUID.self, forKey: .owner)
    }
}

extension AccountScope {
    /// إرسالات الحساب الداخل وحده (ADR 0091)؛ إرسالة حساب آخر لا يظهر منها عنوان ولا عدد.
    public func visible(_ batches: [SendBatch]) -> [SendBatch] {
        batches.filter { owns($0.owner) }
    }
}

/// ملف الإرسالات الأخيرة في مجلده المحمي المستقل (لا في مجلد حالة الرفع الذي يقرأ كل JSON فيه سجلَّ رفع؛ يمحوه المسح والإبطال).
/// يُكتب بحماية سجلات الرفع نفسها (`UploadFileProtection`: مقروء بعد أول فتح للجهاز منذ تشغيله)، لأن حدث الجلسة الخلفية الذي
/// يُكمل الإرسالة يصل والهاتف مقفل؛ والسجلات تحمل العناوين نفسها بتلك الحماية أصلًا. يحفظ آخر 30.
public final class SendBatchStore: @unchecked Sendable {
    /// نتيجة القراءة: «لا ملف» قائمة فارغة صادقة، و«لم يُقرأ» ليس «لا إرسالات».
    public enum ReadResult: Equatable, Sendable {
        case batches([SendBatch])
        /// الملف موجود ولم يُفتح (محمي والجهاز لم يُفتح منذ تشغيله، أو تعذّرت القراءة): يُعاد المحاولة لاحقًا.
        case unreadable
        /// قُرئ ولم يُفهم: ما فيه لا يُستعاد، وآخر حالة جيدة في الذاكرة تُكتب فوقه.
        case corrupt
    }

    public static let limit = 30
    public let fileURL: URL
    public let writingOptions: Data.WritingOptions
    private let readData: @Sendable (URL) throws -> Data
    private let lock = NSLock()

    /// `readData` يُستبدل في الاختبار وحده (ملف محمي لا يُقرأ والهاتف مقفل).
    public init(fileURL: URL, writingOptions: Data.WritingOptions = UploadFileProtection.writingOptions,
                readData: @escaping @Sendable (URL) throws -> Data = { try Data(contentsOf: $0) }) {
        self.fileURL = fileURL
        self.writingOptions = writingOptions
        self.readData = readData
    }

    public func read() -> ReadResult {
        lock.withLock {
            guard FileManager.default.fileExists(atPath: fileURL.path) else { return .batches([]) }
            guard let data = try? readData(fileURL) else { return .unreadable }
            guard let decoded = try? JSONDecoder().decode([SendBatch].self, from: data) else { return .corrupt }
            return .batches(Self.newestFirst(decoded))
        }
    }

    /// يكتب آخر 30 ذريًا ويقول هل نجح.
    @discardableResult
    public func write(_ batches: [SendBatch]) -> Bool {
        let kept = Array(Self.newestFirst(batches).prefix(Self.limit))
        guard let data = try? JSONEncoder().encode(kept) else { return false }
        return lock.withLock { (try? data.write(to: fileURL, options: writingOptions)) != nil }
    }

    /// الإبطال والمسح: لا يبقى الملف (حذفه لا يحتاج فتح الحماية).
    public func clear() {
        lock.withLock { _ = try? FileManager.default.removeItem(at: fileURL) }
    }

    static func newestFirst(_ batches: [SendBatch]) -> [SendBatch] { batches.sorted { $0.createdAt > $1.createdAt } }
}

/// الإرسالات كما تراها الواجهة: آخر حالة جيدة في الذاكرة فوق `SendBatchStore`، الأحدث أولًا.
/// - قراءة فاشلة لا تمحو القائمة في الذاكرة؛ تبقى ويُعاد المحاولة عند التحديث التالي (عودة المشهد نشطًا، أو قبل قرار إيصال).
/// - تغيير والملف لم يُقرأ بعد في هذه العملية يبقى في الذاكرة، ويُدمج في الملف عند أول قراءة ناجحة فلا يمحو إرسالات لا تعرفها.
/// - الإرسالة الجارية (حلقة الإرسال لم تنتهِ في هذه العملية) لا يُعرض إيصالها حتى تُغلق، فلا يسبقها إيصال ملف صغير وصل أولًا.
///   والإرسالة التي قطع إنهاءُ التطبيق حلقتَها تُعدّ مغلقة في العملية التالية بما دخل منها الطابور.
@MainActor
public final class SendBatchLedger {
    /// قرار الإيصال حين يتحقق أصل.
    public enum ReceiptScope: Equatable, Sendable {
        /// مادة بلا إرسالة («لقطة بديلة» أو من إصدار سابق): إيصالها وحدها كما كان.
        case material(UUID)
        /// الإرسالة كلها: إيصال واحد حين يصل كل ما بقي منها.
        case batch(UUID)
    }

    public private(set) var batches: [SendBatch] = []
    public let store: SendBatchStore
    /// قُرئ الملف مرة على الأقل في هذه العملية، فالذاكرة تمثّله.
    private var synced = false
    /// في الذاكرة تغيير لم يصل الملف.
    private var unsaved = false
    private var open: Set<UUID> = []

    public init(store: SendBatchStore) {
        self.store = store
        refresh()
    }

    /// يقرأ الملف إن أمكن: ينجح ← القائمة منه (مدموجًا فيها ما لم يُحفظ)، ويتعذّر ← تبقى آخر حالة جيدة كما هي.
    @discardableResult
    public func refresh() -> [SendBatch] {
        switch store.read() {
        case .batches(let disk):
            batches = unsaved ? Self.merge(memory: batches, disk: disk) : disk
            synced = true
            if unsaved { unsaved = !store.write(batches) }
        case .corrupt:
            synced = true
            unsaved = !store.write(batches)
        case .unreadable:
            break
        }
        return batches
    }

    public func isOpen(_ id: UUID) -> Bool { open.contains(id) }

    public func batch(containing materialId: UUID) -> SendBatch? { batches.first { $0.materialIds.contains(materialId) } }

    /// قبل أول `POST /materials`: الإرسالة بمعرّفها ومفاتيح ملفاتها، مفتوحةً حتى `finish`.
    @discardableResult
    public func begin(title: String, fileKeys: [String], sensitive: Bool? = nil, owner: UUID? = nil, now: Date = Date()) -> SendBatch {
        let batch = SendBatch(title: title, fileKeys: fileKeys, createdAt: now, sensitive: sensitive, owner: owner)
        batches.insert(batch, at: 0)
        open.insert(batch.id)
        commit()
        return batch
    }

    /// مادة ملف أُنشئت: تُضاف إلى إرساليتها قبل أن يدخل الملف الطابور.
    public func add(_ materialId: UUID, to batchId: UUID) {
        guard let i = batches.firstIndex(where: { $0.id == batchId }), !batches[i].materialIds.contains(materialId) else { return }
        batches[i].materialIds.append(materialId)
        commit()
    }

    /// انتهت حلقة الإرسال (كلها أو بفشل جزئي): تبقى مواد ما دخل الطابور وحدها، والإرسالة التي لم يدخل منها شيء تُحذف.
    public func finish(_ batchId: UUID, queued: [UUID]) {
        open.remove(batchId)
        guard let i = batches.firstIndex(where: { $0.id == batchId }) else { return }
        if queued.isEmpty { batches.remove(at: i) } else { batches[i].materialIds = queued }
        commit()
    }

    /// إيصال الإرسالة عُرض: يُعلَّم في الذاكرة أولًا فلا يُعرض مرة ثانية ولو تعذّر الحفظ، ثم يُحفظ.
    public func markReceiptShown(_ batchId: UUID) {
        guard let i = batches.firstIndex(where: { $0.id == batchId }), !batches[i].receiptShown else { return }
        batches[i].receiptShown = true
        commit()
    }

    /// إرسالات الحساب `owner` التي استحق إيصالها ولم يُعرض (وصل آخر ملفاتها وهو خارج)، الأقدم أولًا: تُعرض حين يدخل (ADR 0091).
    /// إرسالات الإصدارات السابقة بلا مالك لا تُعرض هنا، فلا يظهر بعد الترقية إيصال قديم فجأة.
    public func receiptsDue(forOwner owner: UUID, items: (SendBatch) -> [UploadItem]) -> [UUID] {
        batches.filter { $0.owner == owner && due($0, items: items) != nil }.reversed().map(\.id)
    }

    /// الإبطال والمسح: لا تبقى إرسالات تشير إلى طابور مُحي.
    public func forgetAll() {
        batches = []
        open = []
        unsaved = false
        synced = true
        store.clear()
    }

    /// حين يتحقق أصل مادة: إيصالها وحدها إن لم تكن من إرسالة، وإيصال إرساليتها إن اكتملت وأُغلقت ولم يُعرض، وإلا `nil` (تنتظر).
    /// `items`: أصول الإرسالة كما تحسبها شاشة الرفع.
    public func receiptDue(forMaterial materialId: UUID, items: (SendBatch) -> [UploadItem]) -> ReceiptScope? {
        guard let batch = batch(containing: materialId) else { return .material(materialId) }
        return due(batch, items: items)
    }

    /// بعد `finish`: قد تكون ملفات الإرسالة كلها وصلت أثناء الحلقة، فلا حدث آخر يأتي لإيصالها.
    public func receiptDue(forBatch id: UUID, items: (SendBatch) -> [UploadItem]) -> ReceiptScope? {
        batches.first { $0.id == id }.flatMap { due($0, items: items) }
    }

    private func due(_ batch: SendBatch, items: (SendBatch) -> [UploadItem]) -> ReceiptScope? {
        guard !batch.receiptShown, !open.contains(batch.id), UploadOverview.isComplete(items(batch)) else { return nil }
        return .batch(batch.id)
    }

    private func commit() {
        batches = Array(SendBatchStore.newestFirst(batches).prefix(SendBatchStore.limit))
        unsaved = true
        guard synced else { refresh(); return }
        unsaved = !store.write(batches)
    }

    /// الذاكرة تغلب فيما تعرفه (هي الأحدث في هذه العملية)، وما في الملف وحده يُضاف.
    static func merge(memory: [SendBatch], disk: [SendBatch]) -> [SendBatch] {
        let known = Set(memory.map(\.id))
        return Array(SendBatchStore.newestFirst(memory + disk.filter { !known.contains($0.id) }).prefix(SendBatchStore.limit))
    }
}

/// إرسال المسودة إرسالةً واحدة (ADR 0088 وADR 0081): تُسجَّل الإرسالة بمعرّفها ومفاتيح ملفاتها قبل أول طلب، وتُضاف مادة كل ملف
/// إليها قبل إدخاله الطابور، وتُغلق بعد الحلقة بما دخل منها. فإيصال صورة صغيرة يتحقق قبل انتهاء الحلقة ينتظر إغلاقها ولا يُعرض وحده.
public enum BatchedSubmission {
    public struct Outcome {
        public var submission: DraftSubmission.Outcome
        public var batchId: UUID
        /// مواد الملفات التي دخلت الطابور، بالترتيب.
        public var queued: [UUID]
    }

    @MainActor
    public static func run(_ draft: MaterialDraft, dynamicFields: [String: JSONValue], ledger: SendBatchLedger, owner: UUID? = nil,
                           create: (String, MaterialCreate) async throws -> UUID,
                           enqueue: (MaterialDraft.PickedFile, UUID, MaterialCreate) async throws -> Void) async -> Outcome {
        let batch = ledger.begin(title: draft.title.trimmingCharacters(in: .whitespacesAndNewlines),
                                 fileKeys: draft.files.map(\.createIdempotencyKey),
                                 sensitive: draft.sensitivity.map { $0.minors || $0.injured || $0.graphic }, owner: owner)
        var queued: [UUID] = []
        let outcome = await DraftSubmission.run(draft, dynamicFields: dynamicFields, create: create) { file, materialId, body in
            ledger.add(materialId, to: batch.id)
            try await enqueue(file, materialId, body)
            queued.append(materialId)
        }
        ledger.finish(batch.id, queued: queued)
        return Outcome(submission: outcome, batchId: batch.id, queued: queued)
    }
}
