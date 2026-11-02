import Foundation

/// نسخ مؤقتة يصنعها اختيار المعرض (`FileRepresentation`) في `temporaryDirectory` قبل نقلها إلى مجلد الرفع.
/// تُحذف بعد النقل مباشرة؛ إن أُنهي التطبيق بينهما بقيت نسخة من أصل المراسل خارج مجلداته المحمية. تُكنَس عند الإطلاق،
/// والمسح الطارئ يمحو المجلد المؤقت كله.
public enum PickedTempFiles {
    public static let prefix = "picked-"

    public static func newName(for filename: String) -> String { "\(prefix)\(UUID().uuidString.lowercased())-\(filename)" }

    /// اسم الملف كما اختاره المراسل من اسم النسخة المؤقتة (بلا البادئة والمعرّف)؛ أي اسم آخر يعود كما هو.
    public static func originalName(_ name: String) -> String {
        guard name.hasPrefix(prefix) else { return name }
        let rest = name.dropFirst(prefix.count)
        let uuidLength = 36
        guard rest.count > uuidLength + 1, UUID(uuidString: String(rest.prefix(uuidLength))) != nil,
              rest.dropFirst(uuidLength).first == "-" else { return name }
        return String(rest.dropFirst(uuidLength + 1))
    }

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
