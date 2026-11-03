import Foundation

/// حجم جزء tus الذي يرسله الهاتف، ثابت لكل جلسة.
/// في الخلفية أجزاء كبيرة (نهج TUSKit) لأن إيقاظ التطبيق بعد كل جزء يخضع لميزانية الطاقة؛ في المقدمة أجزاء صغيرة.
/// مع قياس للشبكة يُستهدف جزء يستغرق نحو دقيقتين، محصورًا بين الحدين.
/// السقف تحت حدّ جسم الطلب على مسار /files/ (`client_max_body_size 100m` في الحافة ووكيل tusd، وحدّ 100 MB الشائع
/// في الوكلاء أمامها)؛ جزء أكبر منه يُرد بـ 413 فيفشل الرفع نهائيًا (`rejected`). اليوم لا يُمرَّر قياس الصعود، فالجزء
/// الخلفي 64 MiB دائمًا؛ السقف حارس لحين يُوصَل القياس.
public struct ChunkSizePolicy: Sendable, Equatable {
    public var foregroundBytes: Int64 = 8 << 20
    public var backgroundMinBytes: Int64 = 64 << 20
    public var backgroundMaxBytes: Int64 = 90 << 20
    public var targetChunkSeconds: Double = 120
    /// عدد الأجزاء المُجهَّزة مسبقًا على القرص لكل سجل (بما فيها الذي في الطريق): يحد المساحة المؤقتة على الهواتف الممتلئة.
    public var preparedWindow: Int = 2
    /// كم سجلًا يُبصم ويُنقل في وقت واحد في كل الطابور، بترتيب الطابور (ADR 0113). ما بعدها ينتظر دوره بلا جلسة ولا أجزاء.
    public var maxConcurrentTransfers: Int = 2
    /// ميزانية الأجزاء المُجهَّزة على القرص لكل الطابور معًا: جزء إضافي لا يُجهَّز إن تجاوزها، والجزء الأول لسجل بلا جزء يُجهَّز
    /// دائمًا كي يتقدم. ثلاثة أجزاء خلفية (64 MiB)، أي جزء في الطريق لكلٍّ من النقلين وجزء واحد بعدهما.
    public var sharedChunkBudgetBytes: Int64 = 192 << 20

    public init() {}

    public func chunkSize(background: Bool, measuredUplinkBytesPerSecond: Double?) -> Int64 {
        guard background else { return foregroundBytes }
        guard let bps = measuredUplinkBytesPerSecond, bps > 0 else { return backgroundMinBytes }
        let target = Int64(bps * targetChunkSeconds)
        let mib = Int64(1 << 20)
        let rounded = max(mib, (target / mib) * mib)
        return min(backgroundMaxBytes, max(backgroundMinBytes, rounded))
    }
}

public enum ChunkPlanner {
    /// الأجزاء التي يجب تجهيزها الآن: بدءًا من نهاية آخر جزء مُجهَّز (أو من آخر موضع مؤكد) حتى امتلاء النافذة.
    /// `budgetBytes`: ما بقي من ميزانية الطابور المشتركة لهذا السجل. الجزء الأول لسجل بلا جزء مُجهَّز يُجهَّز ولو تجاوزها،
    /// وإلا لا يتقدم الرفع؛ وما بعده ضمن ما بقي منها.
    public static func chunksToPrepare(sizeBytes: Int64, confirmedOffset: Int64, chunkSize: Int64, prepared: [PreparedChunk], window: Int,
                                       budgetBytes: Int64 = .max) -> [(offset: Int64, length: Int64)] {
        precondition(chunkSize > 0)
        var next = prepared.last.map(\.end) ?? confirmedOffset
        var remaining = budgetBytes
        var out: [(Int64, Int64)] = []
        while prepared.count + out.count < window, next < sizeBytes {
            let length = min(chunkSize, sizeBytes - next)
            if !(prepared.isEmpty && out.isEmpty), length > remaining { break }
            out.append((next, length))
            remaining -= length
            next += length
        }
        return out
    }

    /// بعد أن أبلغ الخادم موضعًا مختلفًا عمّا نتوقع: تبقى الأجزاء المُجهَّزة المتصلة من الموضع الجديد فقط.
    public static func reconcile(prepared: [PreparedChunk], serverOffset: Int64) -> (keep: [PreparedChunk], drop: [PreparedChunk]) {
        var keep: [PreparedChunk] = []
        var drop: [PreparedChunk] = []
        var expected = serverOffset
        for c in prepared {
            if c.offset == expected { keep.append(c); expected = c.end } else { drop.append(c) }
        }
        return (keep, drop)
    }
}

/// يكتب ملفات الأجزاء في مجلد الأجزاء ويحذفها بعد التأكيد.
public struct ChunkSlicer: Sendable {
    public let chunksDirectory: URL
    /// كتابة بيانات الجزء في ملفه؛ تُستبدل في الاختبار وحده (قرص ممتلئ).
    private let writeChunkData: @Sendable (FileHandle, Data) throws -> Void

    public init(chunksDirectory: URL, writeChunkData: @escaping @Sendable (FileHandle, Data) throws -> Void = { try $0.write(contentsOf: $1) }) {
        self.chunksDirectory = chunksDirectory
        self.writeChunkData = writeChunkData
    }

    /// قراءة الأصل وخطؤها يخصّانه (غاب أو تغيّر). الكتابة على قرص الهاتف شيء آخر: امتلاؤه يُبلَّغ `UploadError.outOfSpace`
    /// ولا يُعدّ عيبًا في الأصل. وما كُتب من جزء لم يكتمل يُحذف فلا يشغل مساحة ولا يُحسب جاهزًا.
    public func prepare(uploadId: UUID, source: URL, offset: Int64, length: Int64) throws -> PreparedChunk {
        let name = "\(uploadId.uuidString.lowercased())-\(offset).part"
        let target = chunksDirectory.appendingPathComponent(name)
        let reader = try FileHandle(forReadingFrom: source)
        defer { try? reader.close() }
        try reader.seek(toOffset: UInt64(offset))
        let writer: FileHandle
        do {
            try FileManager.default.createDirectory(at: chunksDirectory, withIntermediateDirectories: true)
            try Data().write(to: target, options: UploadFileProtection.writingOptions)
            writer = try FileHandle(forWritingTo: target)
        } catch {
            try? FileManager.default.removeItem(at: target)
            throw UploadError.writeFailure(error)
        }
        defer { try? writer.close() }
        do {
            var remaining = length
            while remaining > 0 {
                let data = try reader.read(upToCount: Int(min(Int64(SHA256Stream.bufferSize), remaining))) ?? Data()
                if data.isEmpty { throw UploadError.sourceTruncated }
                do { try writeChunkData(writer, data) } catch { throw UploadError.writeFailure(error) }
                remaining -= Int64(data.count)
            }
        } catch {
            try? FileManager.default.removeItem(at: target)
            throw error
        }
        return PreparedChunk(offset: offset, length: length, fileName: name)
    }

    public func url(of chunk: PreparedChunk) -> URL { chunksDirectory.appendingPathComponent(chunk.fileName) }

    public func exists(_ chunk: PreparedChunk) -> Bool { FileManager.default.fileExists(atPath: url(of: chunk).path) }

    public func discard(_ chunk: PreparedChunk) {
        try? FileManager.default.removeItem(at: url(of: chunk))
    }

    public func discardAll(uploadId: UUID) {
        let prefix = uploadId.uuidString.lowercased()
        let files = (try? FileManager.default.contentsOfDirectory(at: chunksDirectory, includingPropertiesForKeys: nil)) ?? []
        for f in files where f.lastPathComponent.hasPrefix(prefix) { try? FileManager.default.removeItem(at: f) }
    }
}

public enum UploadError: Error, Equatable {
    case sourceTruncated
    case notFound(UUID)
    case invalidEndpoint
    /// قرص الهاتف لا يتسع لملف جزء: الأصل سليم وما وصل الخادم باقٍ، فيُعاد بعد مهلة متزايدة ولا يفشل الرفع (ADR 0113).
    case outOfSpace

    /// خطأ كتابة ملف الجزء: امتلاء القرص يصير `outOfSpace`، وما عداه كما هو.
    static func writeFailure(_ error: any Error) -> any Error { isOutOfSpace(error) ? UploadError.outOfSpace : error }

    /// امتلاء القرص كما تبلّغه المنصة: `CocoaError.fileWriteOutOfSpace`، أو `ENOSPC`/`EDQUOT` مباشرةً أو خطأً أساسيًا تحته.
    public static func isOutOfSpace(_ error: any Error) -> Bool {
        if (error as? UploadError) == .outOfSpace { return true }
        let ns = error as NSError
        if ns.domain == NSCocoaErrorDomain, ns.code == CocoaError.Code.fileWriteOutOfSpace.rawValue { return true }
        if ns.domain == NSPOSIXErrorDomain, ns.code == Int(ENOSPC) || ns.code == Int(EDQUOT) { return true }
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError, underlying !== ns { return isOutOfSpace(underlying) }
        return false
    }
}
