import Foundation

/// نسخ مؤقتة يصنعها اختيار المعرض (`FileRepresentation`) في `temporaryDirectory` قبل نقلها إلى مجلد الرفع.
/// تُحذف بعد النقل مباشرة؛ إن أُنهي التطبيق بينهما بقيت نسخة من أصل المراسل خارج مجلداته المحمية. تُكنَس عند الإطلاق،
/// والمسح الطارئ يمحو المجلد المؤقت كله.
public enum PickedTempFiles {
    public static let prefix = "picked-"

    public static func newName(for filename: String) -> String { "\(prefix)\(UUID().uuidString.lowercased())-\(filename)" }

    /// يحذف كل ما يحمل بادئة الاختيار في المجلد ويعيد عدده. يُستدعى عند الإطلاق وحده: لا اختيار جارٍ حينها.
    @discardableResult
    public static func sweep(in directory: URL) -> Int {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        var removed = 0
        for name in names where name.hasPrefix(prefix) {
            if (try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))) != nil { removed += 1 }
        }
        return removed
    }
}
