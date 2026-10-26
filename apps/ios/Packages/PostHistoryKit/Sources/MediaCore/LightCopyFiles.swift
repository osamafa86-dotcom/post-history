import Foundation

/// ملفات النسخ الخفيفة في مجلد الرفع. تحضير قطعه إنهاء التطبيق يترك ملفًا نصف مكتوب لا يشير إليه سجل؛ يُحذف عند الإطلاق.
public enum LightCopyFiles {
    public static let suffix = "-light.mov"

    public static func newName() -> String { "\(UUID().uuidString.lowercased())\(suffix)" }

    /// نسخ في المجلد لا يشير إليها أي سجل رفع (`referenced`: أسماء الملفات التي تحملها السجلات).
    public static func orphans(in directory: URL, referenced: Set<String>) -> [URL] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.filter { $0.hasSuffix(suffix) && !referenced.contains($0) }.sorted().map { directory.appendingPathComponent($0) }
    }
}
