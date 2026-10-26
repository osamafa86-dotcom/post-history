import Foundation

/// قفل التطبيق (الخطة: «أمان المراسل: قفل بالبصمة»): حالة بلا واجهة تُختبر على كل المنصات.
/// مقفل عند الإطلاق إن كان مفعّلًا، ويُقفل فور الخروج إلى الخلفية، ولا يُفتح إلا بنجاح مصادقة مالك الجهاز.
public struct AppLockState: Equatable, Sendable {
    public private(set) var isEnabled: Bool
    public private(set) var isLocked: Bool

    public init(enabled: Bool) {
        isEnabled = enabled
        isLocked = enabled
    }

    /// التفعيل لا يُقبل إلا بعد مصادقة ناجحة (يثبت أن للجهاز Face ID أو Touch ID أو رمزًا)؛ والتطبيق مفتوح لحظتها.
    public mutating func enable(authenticated: Bool) -> Bool {
        guard authenticated else { return false }
        isEnabled = true
        isLocked = false
        return true
    }

    public mutating func disable() {
        isEnabled = false
        isLocked = false
    }

    /// الخلفية تُقفل فورًا: مبدّل التطبيقات مغطّى أصلًا، والعودة تطلب المصادقة.
    public mutating func didEnterBackground() {
        if isEnabled { isLocked = true }
    }

    public mutating func authenticationFinished(success: Bool) {
        if success { isLocked = false }
    }
}

/// مصادقة مالك الجهاز (Face ID أو Touch ID أو رمز الجهاز). التنفيذ بـ LocalAuthentication في التطبيق.
public protocol DeviceOwnerAuthenticator: Sendable {
    var isAvailable: Bool { get }
    func authenticate(reason: String) async -> Bool
}
