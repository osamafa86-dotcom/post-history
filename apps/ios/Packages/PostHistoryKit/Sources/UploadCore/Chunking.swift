import Foundation

/// حجم جزء tus الذي يرسله الهاتف، ثابت لكل جلسة.
/// في الخلفية أجزاء كبيرة (نهج TUSKit) لأن إيقاظ التطبيق بعد كل جزء يخضع لميزانية الطاقة؛ في المقدمة أجزاء صغيرة.
/// مع قياس للشبكة يُستهدف جزء يستغرق نحو دقيقتين، محصورًا بين الحدين.
public struct ChunkSizePolicy: Sendable, Equatable {
    public var foregroundBytes: Int64 = 8 << 20
    public var backgroundMinBytes: Int64 = 64 << 20
    public var backgroundMaxBytes: Int64 = 512 << 20
    public var targetChunkSeconds: Double = 120
    /// عدد الأجزاء المُجهَّزة مسبقًا على القرص (بما فيها الذي في الطريق): يحد المساحة المؤقتة على الهواتف الممتلئة.
    public var preparedWindow: Int = 2

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
    public static func chunksToPrepare(sizeBytes: Int64, confirmedOffset: Int64, chunkSize: Int64, prepared: [PreparedChunk], window: Int) -> [(offset: Int64, length: Int64)] {
        precondition(chunkSize > 0)
        var next = prepared.last.map(\.end) ?? confirmedOffset
        var out: [(Int64, Int64)] = []
        while prepared.count + out.count < window, next < sizeBytes {
            let length = min(chunkSize, sizeBytes - next)
            out.append((next, length))
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

/// يكتب ملفات الأجزاء في مجلد الأجزاء ويحسب بصمتها، ويحذفها بعد التأكيد.
public struct ChunkSlicer: Sendable {
    public let chunksDirectory: URL

    public init(chunksDirectory: URL) { self.chunksDirectory = chunksDirectory }

    public func prepare(uploadId: UUID, source: URL, offset: Int64, length: Int64) throws -> PreparedChunk {
        try FileManager.default.createDirectory(at: chunksDirectory, withIntermediateDirectories: true)
        let name = "\(uploadId.uuidString.lowercased())-\(offset).part"
        let target = chunksDirectory.appendingPathComponent(name)
        let reader = try FileHandle(forReadingFrom: source)
        defer { try? reader.close() }
        try reader.seek(toOffset: UInt64(offset))
        FileManager.default.createFile(atPath: target.path, contents: nil)
        let writer = try FileHandle(forWritingTo: target)
        defer { try? writer.close() }
        var remaining = length
        while remaining > 0 {
            let data = try reader.read(upToCount: Int(min(Int64(SHA256Stream.bufferSize), remaining))) ?? Data()
            if data.isEmpty { throw UploadError.sourceTruncated }
            try writer.write(contentsOf: data)
            remaining -= Int64(data.count)
        }
        return PreparedChunk(offset: offset, length: length, fileName: name, sha256Base64: try SHA256Stream.base64(of: target, offset: 0, length: length))
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
}
