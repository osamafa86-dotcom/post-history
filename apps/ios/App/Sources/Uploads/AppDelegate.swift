import UIKit

/// يستقبل إيقاظ النظام لأحداث الجلسة الخلفية ويمرّر مقبض الإكمال إلى النقل، ويمرّر رمز APNs إلى جسر الإشعارات.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        PushBridge.shared.activate()
        return true
    }

    /// التطبيق عمودي، والمشغّل ملء الشاشة وحده يسمح بالأفقي (`OrientationLock`، ADR 0089).
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        OrientationLock.mask
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        guard identifier == UploadServices.backgroundSessionIdentifier else { return completionHandler() }
        UploadServices.shared.transport.backgroundCompletionHandler = completionHandler
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushBridge.shared.deviceTokenReceived(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // بلا تسجيل: الإشعارات تبقى في صندوق التطبيق (GET /notifications).
    }
}
