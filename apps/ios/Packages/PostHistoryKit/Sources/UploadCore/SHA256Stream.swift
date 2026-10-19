import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// بصمة SHA-256 بالتدفق (قراءة 1 ميغابايت في المرة) للملف كاملًا أو لنطاق منه؛ لا يُحمَّل الملف في الذاكرة.
public enum SHA256Stream {
    public static let bufferSize = 1 << 20

    public static func hex(of url: URL) throws -> String {
        try digest(of: url, offset: 0, length: nil).map { String(format: "%02x", $0) }.joined()
    }

    /// بصمة النطاق [offset, offset+length) بترميز base64 (للاختبارات والقياس؛ لا تُرسل لكل جزء، ADR 0009).
    public static func base64(of url: URL, offset: Int64, length: Int64) throws -> String {
        Data(try digest(of: url, offset: offset, length: length)).base64EncodedString()
    }

    public static func hex(of data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func digest(of url: URL, offset: Int64, length: Int64?) throws -> [UInt8] {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        var hasher = SHA256()
        var remaining = length ?? Int64.max
        while remaining > 0 {
            let want = Int(min(Int64(bufferSize), remaining))
            let data = try handle.read(upToCount: want) ?? Data()
            if data.isEmpty { break }
            hasher.update(data: data)
            remaining -= Int64(data.count)
        }
        if let length, remaining > 0 { throw UploadError.sourceTruncated }
        return Array(hasher.finalize())
    }
}
