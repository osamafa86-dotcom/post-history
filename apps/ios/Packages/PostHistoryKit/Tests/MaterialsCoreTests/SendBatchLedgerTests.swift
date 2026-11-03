import XCTest
import PostHistoryAPI
import UploadCore
@testable import MaterialsCore

/// الإرسالة الواحدة وإيصالها (ADR 0088): تُسجَّل قبل أول ملف يدخل الطابور، ولا تمحوها قراءة فاشلة والهاتف مقفل،
/// ولا يسبقها إيصال ملف صغير وصل قبل انتهاء الحلقة.
final class SendBatchLedgerTests: XCTestCase {
    /// مجلد لكل اختبار (XCTest ينشئ نسخة من الصنف لكل اختبار).
    private let dir = FileManager.default.temporaryDirectory.appendingPathComponent("batches-\(UUID().uuidString)")

    override func tearDown() {
        try? FileManager.default.removeItem(at: dir)
        super.tearDown()
    }

    private var fileURL: URL {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("send-batches.json")
    }

    /// قارئ يُقفل ويُفتح كما يفعل الهاتف بملف محمي.
    private final class Lock: @unchecked Sendable {
        private let lock = NSLock()
        private var locked = false
        var isLocked: Bool {
            get { lock.withLock { locked } }
            set { lock.withLock { locked = newValue } }
        }
        func read(_ url: URL) throws -> Data {
            if isLocked { throw CocoaError(.fileReadNoPermission) }
            return try Data(contentsOf: url)
        }
    }

    private func store(_ lock: Lock? = nil) -> SendBatchStore {
        guard let lock else { return SendBatchStore(fileURL: fileURL) }
        return SendBatchStore(fileURL: fileURL, readData: { try lock.read($0) })
    }

    private func file(_ name: String) -> MaterialDraft.PickedFile {
        .init(relativePath: "Uploads/\(name)", filename: name, sizeBytes: 10, mimeType: "image/jpeg", isVideo: false, durationSeconds: nil)
    }

    private func ready(files: Int) -> MaterialDraft {
        var d = MaterialDraft()
        d.files = (0..<files).map { file("\($0).jpg") }
        d.title = "توزيع مساعدات في المخيم"
        d.materialTypes = [.breaking]
        d.tags = ["مساعدات"]
        d.governorate = "دير البلح"; d.city = "النصيرات"
        d.priority = .normal
        d.answerSensitivity(.no)
        d.displayMode = .realName
        d.formVersion = 1
        return d
    }

    private func arrived(_ ids: Set<UUID>) -> (SendBatch) -> [UploadItem] {
        { batch in
            batch.materialIds.map { UploadItem(id: UUID(), materialId: $0, sizeBytes: 10, confirmedOffset: ids.contains($0) ? 10 : 0,
                                               state: ids.contains($0) ? .arrived : .transferring) }
        }
    }

    // MARK: التسجيل قبل الطابور

    @MainActor func testTheSendIsRecordedBeforeAnyFileIsQueuedAndAnEarlyArrivalWaits() async throws {
        let ledger = SendBatchLedger(store: store())
        let draft = ready(files: 3)
        let keys = draft.files.map(\.createIdempotencyKey)
        var arrivedSoFar: Set<UUID> = []
        var decisionsDuringLoop: [SendBatchLedger.ReceiptScope?] = []

        let result = await BatchedSubmission.run(draft, dynamicFields: [:], ledger: ledger) { _, _ in
            UUID()
        } enqueue: { _, materialId, _ in
            // لحظة دخول الملف الطابور: إرساليته على القرص بمفاتيح ملفاتها الثلاثة، ومادته فيها.
            guard case .batches(let onDisk) = SendBatchStore(fileURL: self.fileURL).read() else { return XCTFail("unreadable") }
            XCTAssertEqual(onDisk.first?.fileKeys, keys)
            XCTAssertEqual(onDisk.first?.materialIds.last, materialId)
            // صورة صغيرة يتحقق أصلها فورًا، قبل أن تُنشأ مادة الملف التالي.
            arrivedSoFar.insert(materialId)
            decisionsDuringLoop.append(ledger.receiptDue(forMaterial: materialId, items: self.arrived(arrivedSoFar)))
        }

        XCTAssertNil(result.submission.error)
        XCTAssertEqual(decisionsDuringLoop, [nil, nil, nil], "no receipt of its own and no early receipt for the send")
        XCTAssertFalse(ledger.isOpen(result.batchId))
        let batch = try XCTUnwrap(ledger.batches.first)
        XCTAssertEqual(batch.id, result.batchId)
        XCTAssertEqual(batch.title, "توزيع مساعدات في المخيم")
        XCTAssertEqual(batch.materialIds, result.queued)
        XCTAssertEqual(batch.fileKeys, keys)
        // كلها وصلت أثناء الحلقة: الإيصال الواحد يُقرَّر عند الإغلاق، ومرة واحدة.
        XCTAssertEqual(ledger.receiptDue(forBatch: batch.id, items: arrived(arrivedSoFar)), .batch(batch.id))
        ledger.markReceiptShown(batch.id)
        XCTAssertNil(ledger.receiptDue(forMaterial: result.queued[2], items: arrived(arrivedSoFar)))
        XCTAssertEqual(SendBatchLedger(store: store()).batches.first?.receiptShown, true)
    }

    @MainActor func testAPartialFailureKeepsWhatWasQueuedAndAnEmptySendIsDropped() async throws {
        let ledger = SendBatchLedger(store: store())
        var created = 0
        let partial = await BatchedSubmission.run(ready(files: 3), dynamicFields: [:], ledger: ledger) { _, _ in
            created += 1
            if created == 2 { throw URLError(.notConnectedToInternet) }
            return UUID()
        } enqueue: { _, _, _ in }
        XCTAssertNotNil(partial.submission.error)
        XCTAssertEqual(partial.submission.draft.files.count, 2, "what was not queued stays in the draft")
        XCTAssertEqual(partial.queued.count, 1)
        XCTAssertEqual(ledger.batches.first?.materialIds, partial.queued)
        XCTAssertEqual(ledger.receiptDue(forMaterial: partial.queued[0], items: arrived(Set(partial.queued))), .batch(partial.batchId))

        let failed = await BatchedSubmission.run(ready(files: 2), dynamicFields: [:], ledger: ledger) { _, _ in
            throw URLError(.timedOut)
        } enqueue: { _, _, _ in }
        XCTAssertNotNil(failed.submission.error)
        XCTAssertFalse(ledger.batches.contains { $0.id == failed.batchId }, "a send with nothing queued leaves no batch")
        XCTAssertEqual(ledger.batches.count, 1)
    }

    @MainActor func testAMaterialWithoutASendHasItsOwnReceiptAndAnUnfinishedSendWaits() async {
        let ledger = SendBatchLedger(store: store())
        let lone = UUID()
        XCTAssertEqual(ledger.receiptDue(forMaterial: lone, items: arrived([lone])), .material(lone))

        let batch = ledger.begin(title: "قصف", fileKeys: ["k1", "k2"])
        let first = UUID(), second = UUID()
        ledger.add(first, to: batch.id)
        XCTAssertTrue(ledger.isOpen(batch.id))
        XCTAssertNil(ledger.receiptDue(forMaterial: first, items: arrived([first])))
        ledger.add(second, to: batch.id)
        ledger.finish(batch.id, queued: [first, second])
        XCTAssertNil(ledger.receiptDue(forMaterial: first, items: arrived([first])), "waits for the last file")
        XCTAssertEqual(ledger.receiptDue(forMaterial: second, items: arrived([first, second])), .batch(batch.id))

        // حلقة قطعها إنهاء التطبيق: في العملية التالية تُعدّ مغلقة بما دخل منها.
        let cut = ledger.begin(title: "مقطوعة", fileKeys: ["a", "b", "c"])
        let only = UUID()
        ledger.add(only, to: cut.id)
        let nextProcess = SendBatchLedger(store: store())
        XCTAssertFalse(nextProcess.isOpen(cut.id))
        XCTAssertEqual(nextProcess.receiptDue(forMaterial: only, items: arrived([only])), .batch(cut.id))
    }

    // MARK: القراءة الفاشلة والهاتف مقفل

    @MainActor func testAFailedReadDoesNotWipeTheList() async {
        let lock = Lock()
        let ledger = SendBatchLedger(store: store(lock))
        let batch = ledger.begin(title: "أ", fileKeys: ["k"])
        let material = UUID()
        ledger.add(material, to: batch.id)
        ledger.finish(batch.id, queued: [material])

        lock.isLocked = true
        XCTAssertEqual(store(lock).read(), .unreadable, "a protected file is not an empty one")
        XCTAssertEqual(ledger.refresh().map(\.id), [batch.id], "the last good list stays")
        XCTAssertEqual(ledger.receiptDue(forMaterial: material, items: arrived([material])), .batch(batch.id),
                       "the grouping survives the lock, so the receipt covers the whole send")
        ledger.markReceiptShown(batch.id)
        XCTAssertNil(ledger.receiptDue(forMaterial: material, items: arrived([material])), "shown once even if it was not saved")

        lock.isLocked = false
        XCTAssertEqual(ledger.refresh().first?.receiptShown, true)
        XCTAssertEqual(SendBatchLedger(store: store()).batches.first?.receiptShown, true, "saved on the next good read")
    }

    @MainActor func testALaunchWhileLockedNeitherLosesNorOverwritesTheFile() async {
        let earlier = SendBatchLedger(store: store())
        let old = earlier.begin(title: "قديمة", fileKeys: ["k"], now: Date(timeIntervalSince1970: 1))
        let oldMaterial = UUID()
        earlier.add(oldMaterial, to: old.id)
        earlier.finish(old.id, queued: [oldMaterial])

        // إطلاق في الخلفية والملف لا يُقرأ: القائمة فارغة في الذاكرة، والتغيير لا يُكتب فوق ما لا يعرفه.
        let lock = Lock()
        lock.isLocked = true
        let launched = SendBatchLedger(store: store(lock))
        XCTAssertEqual(launched.batches, [])
        let fresh = launched.begin(title: "جديدة", fileKeys: ["n"], now: Date(timeIntervalSince1970: 2))
        XCTAssertEqual(SendBatchLedger(store: store()).batches.map(\.id), [old.id], "the file was not overwritten")

        lock.isLocked = false
        XCTAssertEqual(launched.refresh().map(\.id), [fresh.id, old.id], "merged on the first good read")
        XCTAssertEqual(SendBatchLedger(store: store()).batches.map(\.id), [fresh.id, old.id])
        XCTAssertEqual(launched.batch(containing: oldMaterial)?.id, old.id)
    }

    func testADraftReloadThatCannotReadKeepsTheLastGoodList() throws {
        let lock = Lock()
        let draftsDir = dir.appendingPathComponent("Drafts")
        let store = try FileDraftStore(directory: draftsDir, readData: { try lock.read($0) })
        var draft = MaterialDraft()
        draft.title = "مسودة"
        try store.save(draft)
        XCTAssertEqual(store.loadAllIfReadable()?.map(\.id), [draft.id])

        lock.isLocked = true
        XCTAssertNil(store.loadAllIfReadable(), "a protected draft is not a missing one: the caller keeps what it has")
        XCTAssertEqual(store.loadAll(), [], "the plain reader drops it, so the reload no longer uses it")

        lock.isLocked = false
        try Data("not json".utf8).write(to: draftsDir.appendingPathComponent("broken.json"))
        XCTAssertEqual(store.loadAllIfReadable()?.map(\.id), [draft.id], "a file read but not understood is skipped as before")
        try FileManager.default.removeItem(at: draftsDir)
        XCTAssertEqual(store.loadAllIfReadable(), [], "after a wipe the list is truly empty")
    }

    @MainActor func testACorruptFileIsReplacedByTheLastGoodListAndAMissingOneIsEmpty() async throws {
        XCTAssertEqual(store().read(), .batches([]), "no file means no sends")
        let ledger = SendBatchLedger(store: store())
        let batch = ledger.begin(title: "أ", fileKeys: ["k"])
        try Data("not json".utf8).write(to: fileURL)
        XCTAssertEqual(store().read(), .corrupt)
        XCTAssertEqual(ledger.refresh().map(\.id), [batch.id])
        XCTAssertEqual(SendBatchLedger(store: store()).batches.map(\.id), [batch.id], "rewritten from memory")
    }

    @MainActor func testStorageKeepsTheNewestThirtyAndForgetsOnWipe() async {
        let ledger = SendBatchLedger(store: store())
        for i in 0..<40 {
            let b = ledger.begin(title: "\(i)", fileKeys: [], now: Date(timeIntervalSince1970: Double(i)))
            ledger.finish(b.id, queued: [UUID()])
        }
        XCTAssertEqual(ledger.batches.count, SendBatchStore.limit)
        XCTAssertEqual(ledger.batches.first?.title, "39")
        XCTAssertEqual(SendBatchLedger(store: store()).batches.count, SendBatchStore.limit)
        ledger.forgetAll()
        XCTAssertEqual(ledger.batches, [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
        XCTAssertEqual(SendBatchLedger(store: store()).batches, [])
    }

    @MainActor func testTheSendRecordsItsSensitivityAnswer() async {
        let ledger = SendBatchLedger(store: store())
        let plain = await BatchedSubmission.run(ready(files: 1), dynamicFields: [:], ledger: ledger) { _, _ in UUID() } enqueue: { _, _, _ in }
        var draft = ready(files: 1)
        draft.answerSensitivity(.yes)
        draft.minors = false; draft.injured = true; draft.graphic = false
        let sensitive = await BatchedSubmission.run(draft, dynamicFields: [:], ledger: ledger) { _, _ in UUID() } enqueue: { _, _, _ in }
        XCTAssertEqual(ledger.batches.first { $0.id == plain.batchId }?.sensitive, false)
        XCTAssertEqual(ledger.batches.first { $0.id == sensitive.batchId }?.sensitive, true)
        guard case .batches(let onDisk) = SendBatchStore(fileURL: fileURL).read() else { return XCTFail("unreadable") }
        XCTAssertEqual(onDisk.first { $0.id == sensitive.batchId }?.sensitive, true, "kept on disk for the upload rows")
    }

    // MARK: الحساب صاحب الإرسالة (ADR 0093)

    @MainActor func testTheSendCarriesItsOwnerAndOnlyItsOwnerSeesIt() async {
        let a = UUID(), b = UUID()
        let ledger = SendBatchLedger(store: store())
        let mine = await BatchedSubmission.run(ready(files: 1), dynamicFields: [:], ledger: ledger, owner: a) { _, _ in UUID() } enqueue: { _, _, _ in }
        let theirs = await BatchedSubmission.run(ready(files: 1), dynamicFields: [:], ledger: ledger, owner: b) { _, _ in UUID() } enqueue: { _, _, _ in }
        guard case .batches(let onDisk) = SendBatchStore(fileURL: fileURL).read() else { return XCTFail("unreadable") }
        XCTAssertEqual(onDisk.first { $0.id == mine.batchId }?.owner, a, "the owner is kept on disk")
        XCTAssertEqual(AccountScope(current: a).visible(ledger.batches).map(\.id), [mine.batchId])
        XCTAssertEqual(AccountScope(current: b).visible(ledger.batches).map(\.id), [theirs.batchId])
        XCTAssertTrue(AccountScope().visible(ledger.batches).isEmpty, "signed out: no send is shown")
        let old = SendBatch(title: "قديمة")
        XCTAssertEqual(AccountScope(current: a, sole: a).visible([old]).map(\.id), [old.id], "an older send belongs to the sole account")
        XCTAssertTrue(AccountScope(current: a, sole: nil).visible([old]).isEmpty, "and to nobody once two accounts signed in")
    }

    @MainActor func testAReceiptDueWhileItsOwnerWasOutIsFoundWhenTheOwnerSignsIn() async {
        let a = UUID(), b = UUID()
        let ledger = SendBatchLedger(store: store())
        let first = await BatchedSubmission.run(ready(files: 1), dynamicFields: [:], ledger: ledger, owner: a) { _, _ in UUID() } enqueue: { _, _, _ in }
        let second = await BatchedSubmission.run(ready(files: 1), dynamicFields: [:], ledger: ledger, owner: a) { _, _ in UUID() } enqueue: { _, _, _ in }
        let other = await BatchedSubmission.run(ready(files: 1), dynamicFields: [:], ledger: ledger, owner: b) { _, _ in UUID() } enqueue: { _, _, _ in }
        let everything = arrived(Set(first.queued + second.queued + other.queued))
        XCTAssertEqual(ledger.receiptsDue(forOwner: a, items: everything), [first.batchId, second.batchId], "the owner's, oldest first")
        XCTAssertEqual(ledger.receiptsDue(forOwner: b, items: everything), [other.batchId])
        ledger.markReceiptShown(first.batchId)
        XCTAssertEqual(ledger.receiptsDue(forOwner: a, items: everything), [second.batchId], "a receipt already shown is not shown again")
        XCTAssertTrue(ledger.receiptsDue(forOwner: a, items: arrived([])).isEmpty, "nothing before the last file arrives")
    }

    @MainActor func testTheFileUsesTheUploadRecordsProtectionAndReadsOlderEntries() async throws {
        XCTAssertEqual(store().writingOptions, UploadFileProtection.writingOptions,
                       "readable after first unlock, like the upload records the background session wakes for")
        let id = UUID(), material = UUID()
        let older = "[{\"id\":\"\(id.uuidString)\",\"title\":\"أ\",\"materialIds\":[\"\(material.uuidString)\"],\"createdAt\":10,\"receiptShown\":false}]"
        try Data(older.utf8).write(to: fileURL)
        XCTAssertEqual(store().read(), .batches([SendBatch(id: id, title: "أ", materialIds: [material], createdAt: Date(timeIntervalSinceReferenceDate: 10))]))
    }
}
