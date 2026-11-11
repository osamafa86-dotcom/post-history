import Foundation

/// ما يُعلَن لقارئ الشاشة حين تتغيّر حالة رفع في الطابور: مرة عند الانتقال إلى «تعذّر» أو «متوقف» أو «وصل»، ولا إعلان لكل نسبة.
/// النص عام: لا عنوان مادة ولا اسم ملف ولا رقم إيصال.
public enum UploadAnnouncement: String, Equatable, Sendable, CaseIterable {
    case failed
    case paused
    case arrived

    /// مفتاح النص في `Localizable.xcstrings` (في `TextKeys.all`، فيُفحص وجوده باللغتين).
    public var textKey: String {
        switch self {
        case .failed: return "upload.announce.failed"
        case .paused: return "upload.announce.paused"
        case .arrived: return "upload.announce.arrived"
        }
    }

    /// ما يلزم إعلانه بين لقطتين متتاليتين لملفات الطابور. يُعلَن الانتقال وحده: ملف يظهر أول مرة لا يُعلَن (فتح التطبيق على طابور
    /// قديم لا يقرأ ماضيه)، وملف بقي على حاله لا يُعلَن وإن تقدّم ما وصل منه. إعلان واحد لكل نوع وإن انتقلت عدة ملفات معًا،
    /// بترتيب ثابت (التعذّر أولًا).
    public static func changes(from old: [UploadItem], to new: [UploadItem]) -> [UploadAnnouncement] {
        let known = Set(old.map { $0.id })
        var before: [UUID: UploadAnnouncement] = [:]
        for item in old {
            if let state = item.announced { before[item.id] = state }
        }
        var found: Set<UploadAnnouncement> = []
        for item in new {
            guard known.contains(item.id), let now = item.announced, before[item.id] != now else { continue }
            found.insert(now)
        }
        return allCases.filter { found.contains($0) }
    }
}

extension UploadItem {
    /// الحالة التي يُعلَن الانتقال إليها، أو `nil` لما لا يُعلَن (تحضير ونقل وإتمام وإلغاء).
    var announced: UploadAnnouncement? {
        switch state {
        case .failed: return .failed
        case .arrived: return .arrived
        case .cancelled: return nil
        case .preparing, .transferring, .finishing: return paused ? .paused : nil
        }
    }
}
